import { GameApi, ObjectType, PlayerData, UnitData, Vector2 } from "../../../../game-api";
import { CombatSquad } from "./squads/combatSquad";
import { Mission, MissionAction, disbandMission, grabCombatants, noop, requestUnits } from "../mission";
import { MatchAwareness } from "../../awareness";
import { MissionController } from "../missionController";
import { RetreatMission } from "./retreatMission";
import { DebugLogger, isOwnedByNeutral, maxBy } from "../../common/utils";
import { manageMoveMicro } from "./squads/common";
import { MissionContext, SupabotContext } from "../../common/context";
import { UnitComposition } from "../../../strategy/strategy";
import { SideComposition } from "../../../strategy/compositionUtils";
import { AttackWaveKind, AttackWavePlanner, GRAND_ASSAULT_WAVE_PREFIX } from "../../../strategy/attackWavePlanner";
import type { StrategicFocusPlanner } from "../../../strategy/strategicFocusPlanner";
import { GRAND_ASSAULT_FILL_PRIORITY, GrandAssaultPlanner } from "../../../strategy/grandAssaultPlanner";
import { hasWarFactory } from "./mcvReserveMission";

export enum AttackFailReason {
    NoTargets = "NoTargets",
    DefenceTooStrong = "DefenceTooStrong",
    UnableToAcquireUnits = "UnableToAcquireUnits",
    OutOfUnits = "OutOfUnits",
}

export enum AttackMissionState {
    Preparing = 0,
    Attacking = 1,
    Retreating = 2,
}

const NO_TARGET_RETARGET_TICKS = 300;
const NO_TARGET_IDLE_TIMEOUT_TICKS = 600;
/** Abort a preparing wave that never launches — frees batch-attack slots. */
const PREPARING_MAX_TICKS = 15 * 60;
/** After this many ticks with enough units, stop hoarding and attack. */
const PREPARING_LAUNCH_AFTER_TICKS = 45;
const GRAND_ASSAULT_LAUNCH_MAX_WAIT_TICKS = 15 * 90;
const RALLY_GRAB_RADIUS = 14;

const ATTACK_MISSION_PRIORITY_RAMP = 1.02;
/** Above base-guard fill (22) but below garrison hold (58) so attacks get factory output without stripping guards. */
const ATTACK_MISSION_MAX_PRIORITY = 54;
// While preparing the squad, how many ticks to wait before dropping one unit from the desired squad size. If the squad size drops below the minimum, the attack mission is aborted.
const REQUESTED_UNIT_COUNT_DECAY_TICKS = 120;

/**
 * A mission that tries to attack a certain area.
 */
export class AttackMission extends Mission<AttackFailReason> {
    private squad: CombatSquad;

    private lastTargetSeenAt = 0;
    private hasPickedNewTarget: boolean = false;

    private state: AttackMissionState = AttackMissionState.Preparing;
    private requestedUnitCount: number;
    private lastRequestedUnitCountDecayAt: number | null = null;
    private preparingSinceTick: number | null = null;
    private readonly squadDecayTicks: number | null;
    private readonly fastLaunch: boolean;
    private readonly waveKind: AttackWaveKind;
    private readonly targetHoardSize: number | null;
    private readonly lockOnFirstAssign: boolean;
    private onLaunchCallback?: () => void;
    private launchNotified = false;

    constructor(
        uniqueName: string,
        private priority: number,
        rallyArea: Vector2,
        private attackArea: Vector2,
        private radius: number,
        private composition: SideComposition,
        logger: DebugLogger,
        squadDecayTicks: number | null = null,
        compactRally: boolean = false,
        fastLaunch: boolean = false,
        waveKind: AttackWaveKind = "assault",
        targetHoardSize?: number,
        lockOnFirstAssign: boolean = false,
    ) {
        super(uniqueName, logger);
        this.squad = new CombatSquad(rallyArea, attackArea, radius, compactRally);
        this.waveKind = waveKind;
        this.targetHoardSize = targetHoardSize ?? null;
        this.lockOnFirstAssign = lockOnFirstAssign;
        // Fast-launch waves only queue up to the minimum — avoids factory spam and rally hoarding.
        if (waveKind === "grand_assault" && targetHoardSize !== undefined) {
            this.requestedUnitCount = targetHoardSize;
        } else {
            this.requestedUnitCount = fastLaunch
                ? composition.minimumUnits
                : composition.maximumUnits;
        }
        this.squadDecayTicks = squadDecayTicks;
        this.fastLaunch = fastLaunch;
    }

    withOnLaunch(callback: () => void): this {
        this.onLaunchCallback = callback;
        return this;
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        switch (this.state) {
            case AttackMissionState.Preparing:
                return this.handlePreparingState(context);
            case AttackMissionState.Attacking:
                return this.handleAttackingState(context);
            case AttackMissionState.Retreating:
                return this.handleRetreatingState(context);
        }
    }

    private handlePreparingState(context: MissionContext) {
        if (this.waveKind === "grand_assault") {
            return this.handleGrandAssaultPreparing(context);
        }
        const { game } = context;
        const tick = game.getCurrentTick();
        if (this.preparingSinceTick === null) {
            this.preparingSinceTick = tick;
        } else if (tick > this.preparingSinceTick + PREPARING_MAX_TICKS) {
            return disbandMission(AttackFailReason.UnableToAcquireUnits);
        } else if (
            tick > this.preparingSinceTick + 120 &&
            this.getUnitIds().length < Math.ceil(this.composition.minimumUnits * 0.35)
        ) {
            // Stuck gathering — shrink the wave so harass/retries can fire instead of blocking forever.
            this.requestedUnitCount = Math.max(
                this.composition.minimumUnits - 1,
                this.requestedUnitCount - 1,
            );
            this.preparingSinceTick = tick;
        }
        this.decayDesiredCompositionIfNeeded(game, context);
        if (this.requestedUnitCount < this.composition.minimumUnits) {
            return disbandMission(AttackFailReason.UnableToAcquireUnits);
        }

        const desiredComposition = this.getDesiredComposition();
        const missingUnits = this.getMissingUnits(game, desiredComposition);
        const assignedCount = this.getUnitIds().length;

        if (
            assignedCount >= this.composition.minimumUnits &&
            (this.fastLaunch || tick > this.preparingSinceTick! + PREPARING_LAUNCH_AFTER_TICKS)
        ) {
            return this.transitionToAttacking();
        }

        if (missingUnits.length > 0) {
            if (assignedCount < this.composition.minimumUnits && tick % 4 !== 0) {
                return grabCombatants(context.matchAwareness.getMainRallyPoint(), RALLY_GRAB_RADIUS);
            }
            this.priority = Math.min(this.priority * ATTACK_MISSION_PRIORITY_RAMP, ATTACK_MISSION_MAX_PRIORITY);
            // distribute the priority among the amount of missing units of each type
            const totalMissingUnits = missingUnits.reduce((sum, [, numMissing]) => sum + numMissing, 0);
            const unitPriorities = Object.fromEntries(
                missingUnits.map(([unitName, numMissing]) => [
                    unitName,
                    (this.priority * numMissing) / totalMissingUnits,
                ]),
            );
            return requestUnits(unitPriorities);
        } else {
            return this.transitionToAttacking();
        }
    }

    /** Savage grand assault: hoard at rally until target size, then launch; low factory priority. */
    private handleGrandAssaultPreparing(context: MissionContext) {
        const { game, matchAwareness } = context;
        const tick = game.getCurrentTick();
        if (this.preparingSinceTick === null) {
            this.preparingSinceTick = tick;
        } else if (tick > this.preparingSinceTick + PREPARING_MAX_TICKS) {
            if (this.getUnitIds().length >= this.composition.minimumUnits) {
                return this.transitionToAttacking();
            }
            return disbandMission(AttackFailReason.UnableToAcquireUnits);
        }

        const targetHoard =
            this.targetHoardSize ??
            Math.max(this.composition.minimumUnits, this.requestedUnitCount);
        const assignedCount = this.getUnitIds().length;

        if (
            assignedCount >= targetHoard ||
            (assignedCount >= this.composition.minimumUnits &&
                tick > this.preparingSinceTick + GRAND_ASSAULT_LAUNCH_MAX_WAIT_TICKS)
        ) {
            return this.transitionToAttacking();
        }

        const desiredComposition = this.getDesiredComposition();
        const missingUnits = this.getMissingUnits(game, desiredComposition);

        if (missingUnits.length > 0) {
            // Rally grab only until minimum is met — bulk hoard comes from factory output.
            if (assignedCount < this.composition.minimumUnits && tick % 4 !== 0) {
                return grabCombatants(matchAwareness.getMainRallyPoint(), RALLY_GRAB_RADIUS);
            }
            const totalMissingUnits = missingUnits.reduce((sum, [, numMissing]) => sum + numMissing, 0);
            const unitPriorities = Object.fromEntries(
                missingUnits.map(([unitName, numMissing]) => [
                    unitName,
                    (GRAND_ASSAULT_FILL_PRIORITY * numMissing) / totalMissingUnits,
                ]),
            );
            return requestUnits(unitPriorities);
        }

        return noop();
    }

    private transitionToAttacking(): MissionAction {
        if (!this.launchNotified && this.onLaunchCallback) {
            this.launchNotified = true;
            this.onLaunchCallback();
        }
        this.priority = ATTACK_MISSION_INITIAL_PRIORITY;
        this.state = AttackMissionState.Attacking;
        return noop();
    }

    private handleAttackingState(context: MissionContext) {
        const { game, matchAwareness } = context;
        const playerData = game.getPlayerData(context.player.name);
        if (this.getUnitIds().length === 0) {
            // TODO: disband directly (we no longer retreat when losing)
            this.state = AttackMissionState.Retreating;
            return noop();
        }

        const foundTargets = matchAwareness
            .getHostilesNearPoint2d(this.attackArea, this.radius)
            .map((unit) => game.getUnitData(unit.unitId))
            .filter((unit) => !isOwnedByNeutral(unit)) as UnitData[];

        const update = this.squad.onAiUpdate(context, this, this.logger);

        if (update.type !== "noop") {
            return update;
        }

        if (foundTargets.length > 0) {
            this.lastTargetSeenAt = game.getCurrentTick();
            this.hasPickedNewTarget = false;
        } else if (game.getCurrentTick() > this.lastTargetSeenAt + NO_TARGET_IDLE_TIMEOUT_TICKS) {
            return disbandMission(AttackFailReason.NoTargets);
        } else if (
            !this.hasPickedNewTarget &&
            game.getCurrentTick() > this.lastTargetSeenAt + NO_TARGET_RETARGET_TICKS
        ) {
            const newTarget = generateTarget(game, playerData, matchAwareness);
            if (newTarget) {
                this.squad.setAttackArea(newTarget);
                this.hasPickedNewTarget = true;
            }
        }

        return noop();
    }

    private handleRetreatingState(context: MissionContext) {
        const { game, actionBatcher, matchAwareness } = context;
        this.getUnits(game).forEach((unitId) => {
            actionBatcher.push(manageMoveMicro(unitId, matchAwareness.getMainRallyPoint()));
        });
        // Note: probably should just disband rather than have a retreating state
        return disbandMission(AttackFailReason.OutOfUnits);
    }

    public getGlobalDebugText(): string | undefined {
        if (this.waveKind === "grand_assault") {
            const hoard = this.targetHoardSize ?? this.requestedUnitCount;
            const state =
                this.state === AttackMissionState.Preparing
                    ? "prep"
                    : this.state === AttackMissionState.Attacking
                      ? "atk"
                      : "ret";
            return `grand-${state}:${this.getUnitIds().length}/${hoard}`;
        }
        return this.squad.getGlobalDebugText() ?? "<none>";
    }

    public getState() {
        return this.state;
    }

    public getAttackArea(): Vector2 {
        return this.attackArea;
    }

    // Grand-assault hoard locks assigned units; savage harass locks on first assign.
    public isUnitsLocked(): boolean {
        if (this.waveKind === "grand_assault") {
            if (this.state === AttackMissionState.Attacking) {
                return true;
            }
            if (this.state === AttackMissionState.Preparing) {
                return this.getUnitIds().length > 0;
            }
            return true;
        }
        if (this.state === AttackMissionState.Attacking) {
            return true;
        }
        if (this.state !== AttackMissionState.Preparing) {
            return true;
        }
        if (this.lockOnFirstAssign && this.getUnitIds().length > 0) {
            return true;
        }
        return this.getUnitIds().length >= this.composition.minimumUnits;
    }

    public getPriority() {
        return this.priority;
    }

    private decayDesiredCompositionIfNeeded(game: GameApi, context: MissionContext): void {
        if (this.waveKind === "grand_assault") {
            return;
        }
        const decayInterval =
            this.squadDecayTicks ??
            context.botProfile?.attackSquadDecayTicks ??
            REQUESTED_UNIT_COUNT_DECAY_TICKS;
        const currentTick = game.getCurrentTick();
        if (this.lastRequestedUnitCountDecayAt === null) {
            this.lastRequestedUnitCountDecayAt = currentTick;
            return;
        }

        if (currentTick <= this.lastRequestedUnitCountDecayAt + decayInterval) {
            return;
        }

        this.lastRequestedUnitCountDecayAt = currentTick;
        if (this.fastLaunch) {
            this.requestedUnitCount = Math.max(this.composition.minimumUnits, this.requestedUnitCount - 1);
            return;
        }
        this.requestedUnitCount--;
    }

    private getDesiredComposition(): UnitComposition {
        const compositionWeights = this.composition.composition;
        const totalWeights = Object.values(compositionWeights).reduce((a, b) => a + b, 0);
        if (totalWeights <= 0) {
            return {};
        }

        return Object.fromEntries(
            Object.entries(compositionWeights).map(([unitName, weight]) => [
                unitName,
                Math.round((weight * this.requestedUnitCount) / totalWeights),
            ]),
        );
    }
}

// Calculates the weight for initiating an attack on the position of a unit or building.
// This is separate from unit micro; the squad will be ordered to attack in the vicinity of the point.
const getTargetWeight: (unitData: UnitData, tryFocusHarvester: boolean) => number = (unitData, tryFocusHarvester) => {
    if (tryFocusHarvester && unitData.rules.harvester) {
        return 100000;
    } else if (unitData.type as any === ObjectType.Building) {
        return unitData.maxHitPoints * 10;
    } else {
        return unitData.maxHitPoints;
    }
};

function generateTarget(
    gameApi: GameApi,
    playerData: PlayerData,
    _matchAwareness: MatchAwareness,
    includeBaseLocations: boolean = false,
    preferHarvesters: boolean = false,
): Vector2 | null {
    // Prefer economy disruption when harassing or when explicitly requested.
    try {
        const tryFocusHarvester = preferHarvesters || gameApi.generateRandomInt(0, 1) === 0;
        const enemyUnits = gameApi
            .getVisibleUnits(playerData.name, "enemy")
            .map((unitId) => gameApi.getUnitData(unitId))
            .filter((u) => !!u && gameApi.getPlayerData(u.owner).isCombatant) as UnitData[];

        const maxUnit = maxBy(enemyUnits, (u) => getTargetWeight(u, tryFocusHarvester));
        if (maxUnit) {
            return new Vector2(maxUnit.tile.rx, maxUnit.tile.ry);
        }

        const mapApi = gameApi.mapApi;
        const enemyPlayers = gameApi
            .getPlayers()
            .map((p) => gameApi.getPlayerData(p))
            .filter((otherPlayer) => !gameApi.areAlliedPlayers(playerData.name, otherPlayer.name));

        if (enemyPlayers.length > 0) {
            if (includeBaseLocations) {
                const unexploredEnemyLocations = enemyPlayers.filter((otherPlayer) => {
                    const tile = mapApi.getTile(otherPlayer.startLocation.x, otherPlayer.startLocation.y);
                    if (!tile) {
                        return false;
                    }
                    return !mapApi.isVisibleTile(tile, playerData.name);
                });
                if (unexploredEnemyLocations.length > 0) {
                    const idx = gameApi.generateRandomInt(0, unexploredEnemyLocations.length - 1);
                    return unexploredEnemyLocations[idx].startLocation;
                }
            }
            // No visible enemies yet — march toward a known enemy base so attacks still happen early.
            const idx = gameApi.generateRandomInt(0, enemyPlayers.length - 1);
            return enemyPlayers[idx].startLocation;
        }
    } catch (err) {
        // There's a crash here when accessing a building that got destroyed. Will catch and ignore or now.
        return null;
    }
    return null;
}

// Number of ticks between attacking visible targets.
const DEFAULT_VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS = 60;

// Number of ticks between attacking "bases" (enemy starting locations).
const DEFAULT_BASE_ATTACK_COOLDOWN_TICKS = 600;

const ATTACK_MISSION_INITIAL_PRIORITY = 42;

export class AttackMissionFactory {
    constructor(
        private lastAttackAt: number = -DEFAULT_VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS,
        private visibleAttackCooldownTicks: number = DEFAULT_VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS,
        private baseAttackCooldownTicks: number = DEFAULT_BASE_ATTACK_COOLDOWN_TICKS,
        private maxPreparingAttacks: number = 2,
        private wavePlanner?: AttackWavePlanner,
        private focusPlanner?: StrategicFocusPlanner,
        private grandAssaultPlanner?: GrandAssaultPlanner,
    ) {}

    getName(): string {
        return "AttackMissionFactory";
    }

    maybeCreateMissions(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
        getComposition: (wave: AttackWaveKind) => SideComposition | null,
    ): void {
        const profile = context.botProfile;
        if (profile?.grandAssaultMode) {
            this.maybeCreateHarassMission(context, missionController, logger, getComposition);
            this.maybeCreateGrandAssaultMission(context, missionController, logger, getComposition);
            return;
        }

        this.maybeCreateWaveMission(context, missionController, logger, getComposition, "assault");
    }

    private maybeCreateHarassMission(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
        getComposition: (wave: AttackWaveKind) => SideComposition | null,
    ): void {
        this.maybeCreateWaveMission(context, missionController, logger, getComposition, "harass");
    }

    /** Always keep one grand-assault hoard active; launch spawns the next hoard immediately. */
    private maybeCreateGrandAssaultMission(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
        getComposition: (wave: AttackWaveKind) => SideComposition | null,
    ): void {
        const { game, matchAwareness } = context;
        const playerData = game.getPlayerData(context.player.name);
        if (!hasWarFactory(game, playerData)) {
            return;
        }

        const composition = getComposition("grand_assault");
        if (!composition || !this.grandAssaultPlanner) {
            return;
        }

        const attackMissions = missionController
            .getMissions()
            .filter((mission): mission is AttackMission => mission instanceof AttackMission);
        const grandMissions = attackMissions.filter((mission) =>
            mission.getUniqueName().startsWith(GRAND_ASSAULT_WAVE_PREFIX),
        );
        const grandPreparing = grandMissions.filter(
            (mission) => mission.getState() === AttackMissionState.Preparing,
        );
        if (grandPreparing.length > 0) {
            return;
        }

        const preparingCount = attackMissions.filter(
            (mission) => mission.getState() === AttackMissionState.Preparing,
        ).length;
        if (preparingCount >= this.maxPreparingAttacks) {
            return;
        }

        const includeEnemyBases = game.getCurrentTick() > this.lastAttackAt + this.baseAttackCooldownTicks;
        const attackArea = generateTarget(
            game,
            playerData,
            matchAwareness,
            includeEnemyBases,
            false,
        );
        if (!attackArea) {
            return;
        }

        const targetHoard = this.grandAssaultPlanner.getTargetHoardSize(context, composition);
        const squadName = `${GRAND_ASSAULT_WAVE_PREFIX}${game.getCurrentTick()}`;
        const squadDecayTicks = context.botProfile?.attackSquadDecayTicks ?? null;

        const tryAttack = missionController.addMission(
            new AttackMission(
                squadName,
                GRAND_ASSAULT_FILL_PRIORITY,
                matchAwareness.getMainRallyPoint(),
                attackArea,
                10,
                composition,
                logger,
                squadDecayTicks,
                false,
                false,
                "grand_assault",
                targetHoard,
            )
                .withOnLaunch(() => {
                    this.grandAssaultPlanner?.onGrandAssaultLaunched(context);
                    logger(`Grand assault launched: ${squadName} (target ${targetHoard})`);
                })
                .withOnFinish((unitIds, reason) => {
                    logger(
                        `Grand assault ${squadName} finished with ${unitIds.length} units: ${reason}`,
                    );
                    missionController.addMission(
                        new RetreatMission(
                            "retreat-from-" + squadName + game.getCurrentTick(),
                            matchAwareness.getMainRallyPoint(),
                            unitIds,
                            logger,
                        ),
                    );
                }),
        );
        if (tryAttack) {
            logger(`Started grand assault hoard: ${squadName} → ${targetHoard} units`);
        }
    }

    private maybeCreateWaveMission(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
        getComposition: (wave: AttackWaveKind) => SideComposition | null,
        forcedWave?: AttackWaveKind,
    ): void {
        const { game, matchAwareness } = context;
        const playerData = game.getPlayerData(context.player.name);
        const profile = context.botProfile;

        const wave: AttackWaveKind =
            forcedWave ??
            (profile?.alternateAttackWaves && this.wavePlanner
                ? this.wavePlanner.chooseWave(context)
                : "assault");

        const composition = getComposition(wave);
        if (!composition) {
            return;
        }

        const isHarass = wave === "harass";
        const cooldownTicks = isHarass
            ? (profile?.harassAttackCooldownTicks ??
              Math.floor(this.visibleAttackCooldownTicks * 0.55))
            : this.visibleAttackCooldownTicks;

        if (game.getCurrentTick() < this.lastAttackAt + cooldownTicks) {
            return;
        }

        const attackMissions = missionController
            .getMissions()
            .filter((mission): mission is AttackMission => mission instanceof AttackMission);

        const wavePrefix = `${wave}_`;
        const sameWaveMissions = attackMissions.filter((mission) =>
            mission.getUniqueName().startsWith(wavePrefix),
        );

        const useBatching = profile?.batchAttacks && (!profile.alternateAttackWaves || !isHarass);
        if (useBatching) {
            if (sameWaveMissions.some((mission) => mission.getState() === AttackMissionState.Attacking)) {
                return;
            }
            if (sameWaveMissions.some((mission) => mission.getState() === AttackMissionState.Preparing)) {
                return;
            }
        } else if (profile?.alternateAttackWaves && !profile.grandAssaultMode) {
            if (sameWaveMissions.some((mission) => mission.getState() === AttackMissionState.Attacking)) {
                return;
            }
            if (sameWaveMissions.some((mission) => mission.getState() === AttackMissionState.Preparing)) {
                return;
            }
        }

        const assaultPreparing = attackMissions.filter(
            (mission) =>
                mission.getUniqueName().startsWith("assault_") &&
                mission.getState() === AttackMissionState.Preparing,
        ).length;
        const harassPreparing = attackMissions.filter(
            (mission) =>
                mission.getUniqueName().startsWith("harass_") &&
                mission.getState() === AttackMissionState.Preparing,
        ).length;
        if (isHarass && harassPreparing >= 1) {
            return;
        }
        if (!isHarass && assaultPreparing >= 1) {
            return;
        }

        // Limit concurrent preparing attacks (grand assault has its own slot in savage mode).
        const preparingCount = attackMissions.filter((mission) => {
            if (mission.getState() !== AttackMissionState.Preparing) {
                return false;
            }
            if (profile?.grandAssaultMode && mission.getUniqueName().startsWith(GRAND_ASSAULT_WAVE_PREFIX)) {
                return false;
            }
            return true;
        }).length;
        if (preparingCount >= this.maxPreparingAttacks) {
            return;
        }

        const attackRadius = 10;

        const includeEnemyBases =
            !isHarass && game.getCurrentTick() > this.lastAttackAt + this.baseAttackCooldownTicks;

        const attackArea = generateTarget(
            game,
            playerData,
            matchAwareness,
            includeEnemyBases,
            isHarass,
        );

        if (!attackArea) {
            return;
        }

        const squadName = `${wave}_${game.getCurrentTick()}`;
        const squadDecayTicks = isHarass ? (profile?.harassSquadDecayTicks ?? 100) : (profile?.attackSquadDecayTicks ?? null);
        const fastLaunch = isHarass || !!profile?.batchAttacks;

        const tryAttack = missionController.addMission(
            new AttackMission(
                squadName,
                ATTACK_MISSION_INITIAL_PRIORITY,
                matchAwareness.getMainRallyPoint(),
                attackArea,
                attackRadius,
                composition,
                logger,
                squadDecayTicks,
                isHarass,
                fastLaunch,
                wave,
                undefined,
                !!profile?.grandAssaultMode && isHarass,
            ).withOnFinish((unitIds, reason) => {
                logger(
                    `Attack ${squadName} (${wave}, ${JSON.stringify(composition)}) with ${
                        unitIds.length
                    } units finished with reason: ${reason}`,
                );
                if (profile?.alternateAttackWaves) {
                    this.wavePlanner?.recordLaunch(wave);
                }
                if ((profile?.alternateAttackWaves || profile?.fortifyBase) && !profile?.grandAssaultMode) {
                    this.focusPlanner?.onAttackFinished(context);
                }
                missionController.addMission(
                    new RetreatMission(
                        "retreat-from-" + squadName + game.getCurrentTick(),
                        matchAwareness.getMainRallyPoint(),
                        unitIds,
                        logger,
                    ),
                );
            }),
        );
        if (tryAttack) {
            this.lastAttackAt = game.getCurrentTick();
            logger(`Launched ${wave} wave: ${squadName}`);
        }
    }
}
