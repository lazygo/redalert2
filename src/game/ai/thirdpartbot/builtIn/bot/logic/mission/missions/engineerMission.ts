import { GameApi, GameObjectData, OrderType, SideType, SpeedType, Tile, UnitData, Vector2 } from "../../../../game-api";
import {
    Mission,
    MissionAction,
    disbandMission,
    noop,
    requestUnitsWithSamePriority,
} from "../mission";
import { MissionController } from "../missionController";
import { DebugLogger, toPathNode, toVector2 } from "../../common/utils";
import { computeAdjacentRect, getAdjacentTiles } from "../../common/tileUtils";
import { MissionContext, SupabotContext } from "../../common/context";
import { UnitComposition } from "../../../strategy/strategy";
import {
    ATTACK_PATH_BRIDGE_SCORE_THRESHOLD,
    BRIDGE_REPAIR_ATTACK_PATH_PRIORITY,
    getActiveAttackRoutePoints,
    getBridgeRepairPriorityForHut,
    hasActiveAttackMissions,
    scoreBridgeHutForAttackRoute,
} from "./bridgeRepairUtils";

const ACTION_COOLDOWN_TICKS = 30;
const CHECK_INTERVAL_TICKS = 200;
const MAX_ATTEMPT_COUNT = 3;
/** Give up only after this many ticks of unreachable target (not on first path check). */
const NO_PATH_GIVE_UP_TICKS = 15 * 80;
const MAX_CONCURRENT_CAPTURE_MISSIONS = 2;
const CAPTURE_MISSION_PRIORITY = 100;

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
    private unreachableSinceTick: number | null = null;

    constructor(
        uniqueName: string,
        private priority: number,
        private targetId: number,
        private escortLevel: number,
        private kind: EngineerMissionKind,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    public _onAiUpdate(context: MissionContext): MissionAction {
        const { game } = context;
        const actionsApi = context.player.actions;
        const playerData = game.getPlayerData(context.player.name);
        const engineers = this.getUnitsOfTypes(game, "SENGINEER", "ENGINEER");

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
            return disbandMission(LOST_ENGINEER);
        }

        if (this.state === EngineerMissionState.Preparing) {
            const composition: UnitComposition = {};
            switch (playerData.country!.side) {
                case SideType.Nod:
                    composition["SENGINEER"] = 1;
                    if (this.kind === "capture") {
                        composition["DOG"] = Math.max(0, this.escortLevel - 1);
                        composition["HTNK"] = Math.max(0, this.escortLevel - 2);
                    }
                    break;
                case SideType.GDI:
                    composition["ENGINEER"] = 1;
                    if (this.kind === "capture") {
                        composition["ADOG"] = Math.max(0, this.escortLevel - 1);
                        composition["MTNK"] = Math.max(0, this.escortLevel - 2);
                    }
                    break;
            }
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
            const engineer = engineers[0];
            if (!engineer) {
                return requestUnitsWithSamePriority(
                    playerData.country!.side === SideType.Nod ? ["SENGINEER"] : ["ENGINEER"],
                    this.priority,
                );
            }
            const approachPath = findBestApproachPath(game, engineer, target);
            if (!approachPath) {
                const tick = game.getCurrentTick();
                if (this.unreachableSinceTick === null) {
                    this.unreachableSinceTick = tick;
                } else if (tick - this.unreachableSinceTick >= NO_PATH_GIVE_UP_TICKS) {
                    return disbandMission(NO_PATH);
                }
                return noop();
            }
            this.unreachableSinceTick = null;
            const orderType = this.kind === "repair_bridge" ? OrderType.Repair : OrderType.Capture;
            actionsApi.orderUnits([engineer.id], orderType, this.targetId);
            if (this.kind === "capture") {
                const escortUnits = this.getUnitsOfTypes(game, "DOG", "HTNK", "ADOG", "MTNK");
                if (escortUnits.length > 0) {
                    actionsApi.orderUnits(
                        escortUnits.map((u) => u.id),
                        OrderType.Guard,
                        engineer.id,
                    );
                }
            }
            this.lastActionAttemptTick = game.getCurrentTick();
            this.logger(`Engineer ${engineer.id} ${this.kind} → ${this.targetId}`);
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

function getStructureApproachTiles(gameApi: GameApi, target: GameObjectData): Tile[] {
    const range = computeAdjacentRect(toVector2(target.tile), target.foundation, 1);
    return getAdjacentTiles(gameApi, range, false).filter((tile) =>
        gameApi.map.isPassableTile(tile, SpeedType.Foot, {}, true),
    );
}

function findBestApproachPath(
    gameApi: GameApi,
    unit: UnitData,
    target: GameObjectData,
): { tile: Tile; pathLength: number } | null {
    const approaches = getStructureApproachTiles(gameApi, target);
    if (approaches.length === 0) {
        return null;
    }

    const startOnBridge = unit.onBridge ?? false;
    const bridgeVariants = startOnBridge ? [true, false] : [false, true];
    let best: { tile: Tile; pathLength: number } | null = null;

    for (const onBridge of bridgeVariants) {
        const start = toPathNode(unit.tile, onBridge);
        for (const tile of approaches) {
            try {
                const path = gameApi.mapApi.findPath(
                    SpeedType.Foot,
                    start,
                    toPathNode(tile, false),
                    { bestEffort: true, maxExpandedNodes: 2500 },
                );
                if (path.length === 0) {
                    continue;
                }
                if (!best || path.length < best.pathLength) {
                    best = { tile, pathLength: path.length };
                }
            } catch {
                // try next approach tile
            }
        }
        if (best) {
            break;
        }
    }

    return best;
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

function scoreTechCaptureTarget(game: GameApi, objectId: number): number {
    const data = game.getGameObjectData(objectId);
    if (!data?.rules?.capturable) {
        return 0;
    }
    const cash = (data.rules as { produceCashAmount?: number }).produceCashAmount ?? 0;
    return 1000 + cash * 10;
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
        const savage = context.botProfile?.id === "savage";
        const attacksActive = savage && hasActiveAttackMissions(context, missionController);
        const interval = savage
            ? Math.floor(CHECK_INTERVAL_TICKS * (attacksActive ? 0.35 : 0.65))
            : CHECK_INTERVAL_TICKS;
        if (!(game.getCurrentTick() > this.lastCheckAt + interval)) {
            return;
        }
        this.lastCheckAt = game.getCurrentTick();

        this.maybeCreateCaptureMissions(context, missionController, logger);

        if (savage) {
            this.maybeCreateBridgeRepairs(context, missionController, logger, attacksActive);
            this.maybeCreateGarrisons(context, missionController, logger);
        }
    }

    private maybeCreateCaptureMissions(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        const { game } = context;
        const playerData = game.getPlayerData(context.player.name);
        const activeCaptures = missionController
            .getMissions()
            .filter((m) => m.getUniqueName().startsWith("capture-")).length;
        if (activeCaptures >= MAX_CONCURRENT_CAPTURE_MISSIONS) {
            return;
        }

        const techBuildingIds = game.getVisibleUnits(
            playerData.name,
            "hostile",
            (r) => r.capturable && !!(r as { needsEngineer?: boolean }).needsEngineer,
        );
        const enemyBuildingIds = game.getVisibleUnits(
            playerData.name,
            "enemy",
            (r) => r.capturable && !(r as { needsEngineer?: boolean }).needsEngineer,
        );

        const candidates = [
            ...techBuildingIds.map((id) => ({ id, score: scoreTechCaptureTarget(game, id) })),
            ...enemyBuildingIds
                .filter((id) => isEnemyBuildingCapturable(game, id))
                .map((id) => ({ id, score: scoreEnemyCaptureTarget(game, playerData.name, id) })),
        ]
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score);

        let created = activeCaptures;
        for (const { id: buildingId } of candidates) {
            if (created >= MAX_CONCURRENT_CAPTURE_MISSIONS) {
                break;
            }
            if (
                (this.lostEngineerCounts[buildingId] ?? 0) >= MAX_ATTEMPT_COUNT ||
                (this.noPathCounts[buildingId] ?? 0) >= MAX_ATTEMPT_COUNT
            ) {
                continue;
            }
            const escortLevel = (this.lostEngineerCounts[buildingId] ?? 0) + 1;
            const added = missionController.addMission(
                new EngineerMission(
                    "capture-" + buildingId,
                    CAPTURE_MISSION_PRIORITY,
                    buildingId,
                    escortLevel,
                    "capture",
                    logger,
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
        const maxActive = attacksActive ? 4 : 2;
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
                new EngineerMission("bridge-" + hutId, priority, hutId, 0, "repair_bridge", logger).withOnFinish(
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
