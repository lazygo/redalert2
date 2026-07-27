import { GameApi, OrderType, PlayerData, SideType, UnitData, Vector2 } from "../../../../game-api";
import {
    Mission,
    MissionAction,
    disbandMission,
    noop,
    requestSpecificUnits,
    requestUnitsWithSamePriority,
} from "../mission";
import { MissionController } from "../missionController";
import { DebugLogger } from "../../common/utils";
import { numBuildingsOwnedOfName } from "../../building/buildingRules";
import { MissionContext, SupabotContext } from "../../common/context";
import { UnitComposition } from "../../../strategy/strategy";
import { isBrutalOrSavageProfile } from "../../../BotDifficultyProfile";
import {
    ATTACK_PATH_BRIDGE_SCORE_THRESHOLD,
    BRIDGE_REPAIR_ATTACK_PATH_PRIORITY,
    getActiveAttackRoutePoints,
    getBridgeRepairPriorityForHut,
    hasLaunchedAttackMissions,
    scoreBridgeHutForAttackRoute,
} from "./bridgeRepairUtils";

const ACTION_COOLDOWN_TICKS = 30;
const CHECK_INTERVAL_TICKS = 120;
const MAX_ATTEMPT_COUNT = 3;
const MAX_CONCURRENT_CAPTURE_MISSIONS = 2;
const SAVAGE_MAX_CONCURRENT_CAPTURE_MISSIONS = 3;
/** Concurrent oil missions — keep piping engineers until the map is dry. */
const MAX_CONCURRENT_OIL_MISSIONS = 2;
const BRUTAL_MAX_CONCURRENT_OIL_MISSIONS = 4;
const SAVAGE_MAX_CONCURRENT_OIL_MISSIONS = 6;
/** Above bridge attack-route repair (118) and spy (110) so engineers are actually queued for oil. */
const OIL_DERRICK_CAPTURE_PRIORITY = 135;
const TECH_CAPTURE_PRIORITY = 68;
const DEFAULT_CAPTURE_PRIORITY = 52;
const CAPTURE_PREPARE_TIMEOUT_TICKS = 15 * 75;
/** Free a stuck oil slot so the next derrick can be attempted. */
const OIL_ACTING_TIMEOUT_TICKS = 15 * 90;

const REFINERY_NAMES = ["GAREFN", "NAREFN"];

enum EngineerMissionState {
    Preparing = 0,
    Acting = 1,
}

export type EngineerMissionKind = "capture" | "repair_bridge";

const LOST_ENGINEER = "lost_engineer";
const NO_PATH = "no_path";

/**
 * Engineer capture (tech) or bridge repair (cab hut).
 */
export class EngineerMission extends Mission {
    private state = EngineerMissionState.Preparing;
    private lastActionAttemptTick = -1;
    private preparingSinceTick: number | null = null;
    private actingSinceTick: number | null = null;

    constructor(
        uniqueName: string,
        private priority: number,
        private targetId: number,
        private escortLevel: number,
        private kind: EngineerMissionKind,
        private skipEscort: boolean,
        logger: DebugLogger,
        private readonly isOilCapture: boolean = false,
    ) {
        super(uniqueName, logger);
    }

    public _onAiUpdate(context: MissionContext): MissionAction {
        const { game } = context;
        const actionsApi = context.player.actions;
        const playerData = game.getPlayerData(context.player.name);
        const side = playerData.country!.side;
        const engineerTypes = side === SideType.Nod ? ["SENGINEER"] : ["ENGINEER"];
        const engineers = this.getUnitsOfTypes(game, ...engineerTypes);

        const target = game.getGameObjectData(this.targetId);
        if (!target) {
            return disbandMission();
        }
        // Capture completes when we own it; repair hut stays neutral — don't disband on owner.
        if (this.kind === "capture" && target.owner === playerData.name) {
            return disbandMission();
        }
        // Bridge already repaired (or never needed repair).
        if (this.kind === "repair_bridge") {
            const hut = game.getUnitData(this.targetId);
            if (!hut?.needsBridgeRepair) {
                return disbandMission();
            }
        }

        if (engineers.length === 0 && this.state === EngineerMissionState.Acting) {
            // Capture often consumes the engineer one tick before ownership updates —
            // for oil, request a replacement instead of burning the attempt budget.
            if (this.isOilCapture) {
                return requestUnitsWithSamePriority(engineerTypes, this.priority + 8);
            }
            return disbandMission(LOST_ENGINEER);
        }

        if (this.state === EngineerMissionState.Preparing) {
            const tick = game.getCurrentTick();
            if (this.preparingSinceTick === null) {
                this.preparingSinceTick = tick;
            } else if (tick > this.preparingSinceTick + CAPTURE_PREPARE_TIMEOUT_TICKS) {
                return disbandMission("prepare_timeout");
            }

            const engineerPriority = this.isOilCapture ? this.priority + 8 : this.priority;
            const escortPriority = this.isOilCapture ? Math.max(42, this.priority - 25) : this.priority;

            if (engineers.length === 0) {
                const idleEngineerId = findIdleEngineerId(game, playerData.name, engineerTypes[0]);
                if (idleEngineerId !== null) {
                    return requestSpecificUnits([idleEngineerId], engineerPriority);
                }
                return requestUnitsWithSamePriority(engineerTypes, engineerPriority);
            }

            // Oil: engineer moves immediately; escort is best-effort and never blocks capture.
            if (this.isOilCapture) {
                this.state = EngineerMissionState.Acting;
                this.actingSinceTick = tick;
            } else {
                const composition = buildCaptureComposition(
                    side,
                    this.kind,
                    this.skipEscort,
                    this.escortLevel,
                );
                const missingUnits = this.getMissingUnits(game, composition);
                if (missingUnits.length > 0) {
                    const escortTypes = missingUnits
                        .map(([unitName]) => unitName)
                        .filter((name) => !engineerTypes.includes(name));
                    if (missingUnits.some(([name]) => engineerTypes.includes(name))) {
                        return requestUnitsWithSamePriority(engineerTypes, engineerPriority);
                    }
                    if (escortTypes.length > 0) {
                        return requestUnitsWithSamePriority(escortTypes, escortPriority);
                    }
                }
                this.state = EngineerMissionState.Acting;
            }
        }

        if (this.state === EngineerMissionState.Acting) {
            const tick = game.getCurrentTick();
            if (this.actingSinceTick === null) {
                this.actingSinceTick = tick;
            } else if (
                this.isOilCapture &&
                tick > this.actingSinceTick + OIL_ACTING_TIMEOUT_TICKS
            ) {
                return disbandMission(NO_PATH);
            }
        }

        if (
            this.state === EngineerMissionState.Acting &&
            game.getCurrentTick() > this.lastActionAttemptTick + ACTION_COOLDOWN_TICKS
        ) {
            const engineer = engineers[0];
            if (!engineer) {
                return requestUnitsWithSamePriority(engineerTypes, this.priority);
            }

            const orderType = this.kind === "repair_bridge" ? OrderType.Repair : OrderType.Capture;
            // Issue Capture/Repair immediately — do not gate on pathfinding (it often falsely fails).
            actionsApi.orderUnits([engineer.id], orderType, this.targetId);
            this.lastActionAttemptTick = game.getCurrentTick();
            this.logger(`Engineer ${engineer.id} ${this.kind} → ${this.targetId}`);

            if (this.kind === "capture" && !this.skipEscort) {
                this.orderEscortGuard(actionsApi, game);
                if (this.isOilCapture) {
                    const composition = buildCaptureComposition(side, this.kind, false, this.escortLevel);
                    const missingEscort = this.getMissingUnits(game, composition).filter(
                        ([name]) => !engineerTypes.includes(name),
                    );
                    if (missingEscort.length > 0) {
                        return requestUnitsWithSamePriority(
                            missingEscort.map(([unitName]) => unitName),
                            Math.max(42, this.priority - 25),
                        );
                    }
                }
            }
        }
        return noop();
    }

    private orderEscortGuard(actionsApi: MissionContext["player"]["actions"], game: GameApi): void {
        const escortUnits = this.getUnitsOfTypes(game, "DOG", "HTNK", "ADOG", "MTNK");
        if (escortUnits.length === 0) {
            return;
        }
        const engineer = this.getUnitsOfTypes(game, "SENGINEER", "ENGINEER")[0];
        if (!engineer) {
            return;
        }
        actionsApi.orderUnits(
            escortUnits.map((u) => u.id),
            OrderType.Guard,
            engineer.id,
        );
    }

    /** Let idle engineers join oil missions; lock once assigned. */
    public isUnitsLocked(): boolean {
        if (this.isOilCapture) {
            return this.getUnitIds().length > 0;
        }
        return true;
    }

    public getGlobalDebugText(): string | undefined {
        const state = this.state === EngineerMissionState.Preparing ? "prep" : "act";
        return `${this.kind}-${state}`;
    }

    public getPriority() {
        return this.priority;
    }
}

function buildCaptureComposition(
    side: SideType,
    kind: EngineerMissionKind,
    skipEscort: boolean,
    escortLevel: number,
): UnitComposition {
    const composition: UnitComposition = {};
    if (side === SideType.Nod) {
        composition["SENGINEER"] = 1;
        if (kind === "capture" && !skipEscort) {
            const dogs = Math.max(0, escortLevel - 1);
            const tanks = Math.max(0, escortLevel - 2);
            if (dogs > 0) {
                composition["DOG"] = dogs;
            }
            if (tanks > 0) {
                composition["HTNK"] = tanks;
            }
        }
    } else {
        composition["ENGINEER"] = 1;
        if (kind === "capture" && !skipEscort) {
            const dogs = Math.max(0, escortLevel - 1);
            const tanks = Math.max(0, escortLevel - 2);
            if (dogs > 0) {
                composition["ADOG"] = dogs;
            }
            if (tanks > 0) {
                composition["MTNK"] = tanks;
            }
        }
    }
    return composition;
}

function findIdleEngineerId(game: GameApi, playerName: string, engineerName: string): number | null {
    const ids = game.getVisibleUnits(playerName, "self", (r) => r.name === engineerName);
    return ids.length > 0 ? ids[0] : null;
}

function isEnemyBuildingCapturable(game: GameApi, objectId: number): boolean {
    const data = game.getGameObjectData(objectId);
    if (!data?.rules?.capturable || data.owner === undefined) {
        return false;
    }
    const owner = game.getPlayerData(data.owner);
    if (!owner.isCombatant) {
        return false;
    }
    const hp = data.hitPoints ?? 0;
    const maxHp = data.maxHitPoints ?? 1;
    const captureLevel = game.getGeneralRules()?.engineerCaptureLevel ?? 0.25;
    const captureThreshold = 100 * captureLevel;
    if (hp <= captureThreshold + 1) {
        return true;
    }
    // Damaged structures — engineer may need multiple trips when multi-engineer is enabled.
    return hp / maxHp <= captureLevel + 0.2;
}

function isOilDerrick(rules: { produceCashAmount?: number; produceCashStartup?: number; name?: string }): boolean {
    return (
        (rules.produceCashAmount ?? 0) > 0 ||
        (rules.produceCashStartup ?? 0) > 0 ||
        rules.name === "CAOILD"
    );
}

function hasRefinery(game: GameApi, playerData: PlayerData): boolean {
    return REFINERY_NAMES.some((name) => numBuildingsOwnedOfName(game, playerData, name) > 0);
}

function findCapturableOilDerrickIds(game: GameApi, playerName: string): number[] {
    const ids = new Set<number>();
    const consider = (objectId: number) => {
        const data = game.getGameObjectData(objectId);
        if (!data?.rules?.capturable || !data.rules.needsEngineer) {
            return;
        }
        if (data.owner === playerName) {
            return;
        }
        if (!isOilDerrick(data.rules)) {
            return;
        }
        ids.add(objectId);
    };

    for (const id of game.getVisibleUnits(
        playerName,
        "hostile",
        (r) => r.capturable && r.needsEngineer,
    )) {
        consider(id);
    }
    try {
        for (const id of game.getNeutralUnits((r) => r.capturable && r.needsEngineer)) {
            consider(id);
        }
    } catch {
        // Civilian house may be missing on some maps / skirmish setups.
    }
    return [...ids];
}

function countActiveOilCaptureMissions(missionController: MissionController): number {
    return missionController
        .getMissions()
        .filter((m) => m.getUniqueName().startsWith("capture-oil-")).length;
}

function hasPendingVisibleOil(game: GameApi, playerName: string, missionController: MissionController): boolean {
    // Prefer finishing oil over bridge repair whenever any derrick remains free.
    const remaining = findCapturableOilDerrickIds(game, playerName).length;
    if (remaining > 0) {
        return true;
    }
    return countActiveOilCaptureMissions(missionController) > 0;
}

function getCaptureMissionPriority(
    rules: { produceCashAmount?: number; name?: string },
    savage: boolean,
): number {
    if (isOilDerrick(rules)) {
        return OIL_DERRICK_CAPTURE_PRIORITY;
    }
    return savage ? TECH_CAPTURE_PRIORITY : DEFAULT_CAPTURE_PRIORITY;
}

function scoreTechCaptureTarget(game: GameApi, objectId: number, playerName: string): number {
    const data = game.getGameObjectData(objectId);
    if (!data?.rules?.capturable) {
        return 0;
    }
    const rules = data.rules as { produceCashAmount?: number; name?: string };
    const cash = rules.produceCashAmount ?? 0;
    let score = 1000 + cash * 10;
    if (isOilDerrick(rules)) {
        score += 600;
    }
    const playerData = game.getPlayerData(playerName);
    const dist = playerData.startLocation.distanceTo(new Vector2(data.tile.rx, data.tile.ry));
    score -= dist * 1.2;
    return Math.max(score, 1);
}

function scoreEnemyCaptureTarget(game: GameApi, playerName: string, objectId: number): number {
    const data = game.getGameObjectData(objectId);
    if (!data || !isEnemyBuildingCapturable(game, objectId)) {
        return 0;
    }
    const hp = data.hitPoints ?? 0;
    const maxHp = data.maxHitPoints ?? 1;
    const damageScore = (1 - hp / maxHp) * 500;
    const valueByName: Record<string, number> = {
        GACNST: 400,
        NACNST: 400,
        GAWEAP: 350,
        NAWEAP: 350,
        GATECH: 320,
        NATECH: 320,
        GAREFN: 280,
        NAREFN: 280,
        GAPILE: 200,
        NAHAND: 200,
    };
    const nameScore = valueByName[data.name] ?? 120;
    const playerData = game.getPlayerData(playerName);
    const dist = playerData.startLocation.distanceTo(new Vector2(data.tile.rx, data.tile.ry));
    return damageScore + nameScore - dist * 2;
}

/**
 * Send GIs / Conscripts to occupy civilian buildings (CanBeOccupied).
 */
export class GarrisonMission extends Mission {
    private state = EngineerMissionState.Preparing;
    private lastActionAttemptTick = -1;

    constructor(
        uniqueName: string,
        private priority: number,
        private buildingId: number,
        private squadSize: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    public _onAiUpdate(context: MissionContext): MissionAction {
        const { game } = context;
        const actionsApi = context.player.actions;
        const playerData = game.getPlayerData(context.player.name);
        const infantryName = playerData.country!.side === SideType.Nod ? "E2" : "E1";
        const troops = this.getUnitsOfTypes(game, infantryName);

        const target = game.getGameObjectData(this.buildingId);
        if (!target) {
            return disbandMission();
        }

        if (this.state === EngineerMissionState.Preparing) {
            const composition: UnitComposition = { [infantryName]: this.squadSize };
            const missingUnits = this.getMissingUnits(game, composition);
            if (missingUnits.length > 0) {
                return requestUnitsWithSamePriority(
                    missingUnits.map(([unitName]) => unitName),
                    this.priority,
                );
            }
            this.state = EngineerMissionState.Acting;
        }

        if (
            this.state === EngineerMissionState.Acting &&
            game.getCurrentTick() > this.lastActionAttemptTick + ACTION_COOLDOWN_TICKS
        ) {
            if (troops.length === 0) {
                return requestUnitsWithSamePriority([infantryName], this.priority);
            }
            // Occupy each troop into the building (garrison).
            actionsApi.orderUnits(
                troops.map((t) => t.id),
                OrderType.Occupy,
                this.buildingId,
            );
            this.lastActionAttemptTick = game.getCurrentTick();
            this.logger(`Garrison squad occupying building ${this.buildingId}`);
            // Once ordered, disband — troops stay in building; mission complete enough.
            return disbandMission();
        }
        return noop();
    }

    public getGlobalDebugText(): string | undefined {
        return undefined;
    }

    public getPriority() {
        return this.priority;
    }
}

export class EngineerMissionFactory {
    private lastCheckAt = 0;
    private lostEngineerCounts: { [buildingId: number]: number } = {};
    private noPathCounts: { [buildingId: number]: number } = {};

    getName(): string {
        return "EngineerMissionFactory";
    }

    maybeCreateMissions(context: SupabotContext, missionController: MissionController, logger: DebugLogger): void {
        const { game } = context;
        const aggressive = isBrutalOrSavageProfile(context.botProfile);
        const savage = context.botProfile?.id === "savage";
        const attacksActive = savage && hasLaunchedAttackMissions(context, missionController);
        const interval = aggressive ? Math.floor(CHECK_INTERVAL_TICKS * 0.5) : CHECK_INTERVAL_TICKS;
        if (!(game.getCurrentTick() > this.lastCheckAt + interval)) {
            return;
        }
        this.lastCheckAt = game.getCurrentTick();

        if (aggressive) {
            this.maybeCreateOilCaptureMissions(context, missionController, logger);
        }
        this.maybeCreateCaptureMissions(context, missionController, logger);

        if (savage) {
            this.maybeCreateBridgeRepairs(context, missionController, logger, attacksActive);
            this.maybeCreateGarrisons(context, missionController, logger);
        }
    }

    private maybeCreateOilCaptureMissions(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        const { game } = context;
        const playerData = game.getPlayerData(context.player.name);

        if (!hasRefinery(game, playerData)) {
            return;
        }

        // Brutal/Savage already learn every neutral derrick via getNeutralUnits —
        // do not wait for fog reveal or scouting will cap captures at a handful.
        const requireVisible = !isBrutalOrSavageProfile(context.botProfile);
        const oilIds = findCapturableOilDerrickIds(game, playerData.name).filter((id) => {
            const data = game.getGameObjectData(id);
            if (!data?.tile) {
                return false;
            }
            if (!requireVisible) {
                return true;
            }
            return game.mapApi.isVisibleTile(data.tile, playerData.name);
        });

        if (oilIds.length === 0) {
            return;
        }

        const profileId = context.botProfile?.id;
        const maxOilMissions =
            profileId === "savage"
                ? SAVAGE_MAX_CONCURRENT_OIL_MISSIONS
                : isBrutalOrSavageProfile(context.botProfile)
                  ? BRUTAL_MAX_CONCURRENT_OIL_MISSIONS
                  : MAX_CONCURRENT_OIL_MISSIONS;
        let activeOil = countActiveOilCaptureMissions(missionController);

        const scored = oilIds
            .map((id) => ({ id, score: scoreTechCaptureTarget(game, id, playerData.name) }))
            .sort((a, b) => b.score - a.score);

        for (const { id: buildingId } of scored) {
            if (activeOil >= maxOilMissions) {
                break;
            }
            if (missionController.getMissions().some((m) => m.getUniqueName() === `capture-oil-${buildingId}`)) {
                continue;
            }
            if (
                (this.lostEngineerCounts[buildingId] ?? 0) >= MAX_ATTEMPT_COUNT ||
                (this.noPathCounts[buildingId] ?? 0) >= MAX_ATTEMPT_COUNT
            ) {
                continue;
            }

            const baseEscortLevel = (this.lostEngineerCounts[buildingId] ?? 0) + 1;
            const escortLevel = Math.max(2, baseEscortLevel);
            const added = missionController.addMission(
                new EngineerMission(
                    `capture-oil-${buildingId}`,
                    OIL_DERRICK_CAPTURE_PRIORITY,
                    buildingId,
                    escortLevel,
                    "capture",
                    false,
                    logger,
                    true,
                ).withOnFinish((_unitIds, reason) => {
                    if (reason === LOST_ENGINEER) {
                        this.lostEngineerCounts[buildingId] =
                            (this.lostEngineerCounts[buildingId] ?? 0) + 1;
                    } else if (reason === NO_PATH) {
                        this.noPathCounts[buildingId] = (this.noPathCounts[buildingId] ?? 0) + 1;
                    }
                }),
            );
            if (added) {
                activeOil++;
                logger(
                    `Created oil capture mission for derrick ${buildingId} (priority ${OIL_DERRICK_CAPTURE_PRIORITY}, escort ${escortLevel})`,
                );
            }
        }
    }

    private maybeCreateCaptureMissions(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        const { game } = context;
        const playerData = game.getPlayerData(context.player.name);
        const savage = context.botProfile?.id === "savage";
        const maxCaptures = savage ? SAVAGE_MAX_CONCURRENT_CAPTURE_MISSIONS : MAX_CONCURRENT_CAPTURE_MISSIONS;
        // Oil uses capture-oil-* and has its own concurrency budget — don't let it fill this slot.
        const activeCaptures = missionController
            .getMissions()
            .filter(
                (m) =>
                    m.getUniqueName().startsWith("capture-") &&
                    !m.getUniqueName().startsWith("capture-oil-"),
            ).length;
        if (activeCaptures >= maxCaptures) {
            return;
        }

        const techBuildingIds = game
            .getVisibleUnits(
                playerData.name,
                "hostile",
                (r) => r.capturable && !!(r as { needsEngineer?: boolean }).needsEngineer,
            )
            .filter((id) => {
                const rules = game.getGameObjectData(id)?.rules;
                return rules && !isOilDerrick(rules);
            });
        const enemyBuildingIds = game.getVisibleUnits(
            playerData.name,
            "enemy",
            (r) => r.capturable && !(r as { needsEngineer?: boolean }).needsEngineer,
        );

        const candidates = [
            ...techBuildingIds.map((id) => ({
                id,
                score: scoreTechCaptureTarget(game, id, playerData.name),
            })),
            ...enemyBuildingIds
                .filter((id) => isEnemyBuildingCapturable(game, id))
                .map((id) => ({ id, score: scoreEnemyCaptureTarget(game, playerData.name, id) })),
        ]
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score);

        let created = activeCaptures;
        for (const { id: buildingId } of candidates) {
            if (created >= maxCaptures) {
                break;
            }
            if (
                (this.lostEngineerCounts[buildingId] ?? 0) >= MAX_ATTEMPT_COUNT ||
                (this.noPathCounts[buildingId] ?? 0) >= MAX_ATTEMPT_COUNT
            ) {
                continue;
            }
            const targetData = game.getGameObjectData(buildingId);
            if (!targetData?.rules) {
                continue;
            }
            const rules = targetData.rules as { produceCashAmount?: number; name?: string };
            // Oil is handled exclusively by maybeCreateOilCaptureMissions.
            if (isOilDerrick(rules)) {
                continue;
            }
            const priority = getCaptureMissionPriority(rules, savage);
            const escortLevel = (this.lostEngineerCounts[buildingId] ?? 0) + 1;
            const added = missionController.addMission(
                new EngineerMission(
                    "capture-" + buildingId,
                    priority,
                    buildingId,
                    escortLevel,
                    "capture",
                    false,
                    logger,
                    false,
                ).withOnFinish((_unitIds, reason) => {
                    if (reason === LOST_ENGINEER) {
                        this.lostEngineerCounts[buildingId] =
                            (this.lostEngineerCounts[buildingId] ?? 0) + 1;
                    } else if (reason === NO_PATH) {
                        this.noPathCounts[buildingId] = (this.noPathCounts[buildingId] ?? 0) + 1;
                    }
                }),
            );
            if (added) {
                created++;
                logger(`Created engineer capture mission for building ${buildingId}`);
            }
        }
    }

    private maybeCreateBridgeRepairs(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
        attacksActive: boolean,
    ): void {
        const { game, matchAwareness } = context;
        const playerData = game.getPlayerData(context.player.name);
        const active = missionController.getMissions().filter((m) => m.getUniqueName().startsWith("bridge-"));
        const oilPending = hasPendingVisibleOil(game, playerData.name, missionController);
        if (oilPending) {
            return;
        }
        let maxActive = attacksActive ? 4 : 2;
        if (active.length >= maxActive) {
            return;
        }

        const attackPoints = getActiveAttackRoutePoints(context, missionController);
        const rallyPoint = matchAwareness.getMainRallyPoint();
        const sectorCache = matchAwareness.getSectorCache();

        const hutIds = game.getVisibleUnits(
            playerData.name,
            "hostile",
            (r) => !!(r as { bridgeRepairHut?: boolean }).bridgeRepairHut,
        );

        const candidates = hutIds
            .map((hutId) => {
                const hut = game.getUnitData(hutId);
                if (!hut?.needsBridgeRepair || !hut.tile) {
                    return null;
                }
                if (
                    (this.lostEngineerCounts[hutId] ?? 0) >= MAX_ATTEMPT_COUNT ||
                    (this.noPathCounts[hutId] ?? 0) >= MAX_ATTEMPT_COUNT
                ) {
                    return null;
                }
                const score =
                    attackPoints.length > 0
                        ? scoreBridgeHutForAttackRoute(hut, rallyPoint, attackPoints, sectorCache)
                        : 0;
                return { hutId, hut, score };
            })
            .filter(
                (entry): entry is { hutId: number; hut: UnitData; score: number } => entry !== null,
            )
            .sort((a, b) => b.score - a.score);

        for (const { hutId, hut, score } of candidates) {
            const onAttackRoute = score >= ATTACK_PATH_BRIDGE_SCORE_THRESHOLD;
            const priority = onAttackRoute
                ? BRIDGE_REPAIR_ATTACK_PATH_PRIORITY
                : getBridgeRepairPriorityForHut(hut, context, missionController);
            const added = missionController.addMission(
                new EngineerMission("bridge-" + hutId, priority, hutId, 0, "repair_bridge", true, logger).withOnFinish(
                    (_unitIds, reason) => {
                        if (reason === LOST_ENGINEER) {
                            this.lostEngineerCounts[hutId] = (this.lostEngineerCounts[hutId] ?? 0) + 1;
                        } else if (reason === NO_PATH) {
                            this.noPathCounts[hutId] = (this.noPathCounts[hutId] ?? 0) + 1;
                        }
                    },
                ),
            );
            if (added) {
                logger(
                    onAttackRoute
                        ? `Created attack-route bridge repair for hut ${hutId} (score ${Math.round(score)})`
                        : `Created bridge-repair mission for hut ${hutId}`,
                );
                break;
            }
        }
    }

    private maybeCreateGarrisons(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        const { game } = context;
        const playerData = game.getPlayerData(context.player.name);
        const active = missionController.getMissions().filter((m) => m.getUniqueName().startsWith("garrison-"));
        if (active.length >= 6) {
            return;
        }

        const baseCenter = playerData.startLocation;
        const maxDistanceFromBase = 22;

        // Civilian / empty buildings that can be occupied (CanBeOccupied).
        const buildings = game.getVisibleUnits(
            playerData.name,
            "hostile",
            (r) => !!(r as { canBeOccupied?: boolean }).canBeOccupied,
        );

        const sorted = buildings
            .map((buildingId) => {
                const data = game.getUnitData(buildingId);
                if (!data?.tile) {
                    return null;
                }
                const dist = baseCenter.distanceTo(new Vector2(data.tile.rx, data.tile.ry));
                return { buildingId, data, dist };
            })
            .filter((entry): entry is { buildingId: number; data: NonNullable<ReturnType<typeof game.getUnitData>>; dist: number } => !!entry)
            .sort((a, b) => a.dist - b.dist);

        for (const { buildingId, data, dist } of sorted) {
            if (dist > maxDistanceFromBase) {
                continue;
            }
            // Skip owned, enemy-garrisoned, or full buildings.
            if (data.owner === playerData.name) {
                continue;
            }
            const occupied = data.garrisonUnitCount ?? 0;
            const max = data.garrisonUnitsMax ?? 0;
            if (occupied > 0 || (max > 0 && occupied >= max)) {
                continue;
            }
            const squadSize = dist <= 12 ? 4 : 3;
            const added = missionController.addMission(
                new GarrisonMission("garrison-" + buildingId, 70, buildingId, squadSize, logger),
            );
            if (added) {
                logger(`Created garrison mission for building ${buildingId} (${Math.round(dist)} tiles from base)`);
                break;
            }
        }
    }
}
