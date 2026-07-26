import { GameApi, GameObjectData, OrderType, SideType, SpeedType, UnitData } from "../../../../game-api";
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

const ACTION_COOLDOWN_TICKS = 30;
const CHECK_INTERVAL_TICKS = 200;
const MAX_ATTEMPT_COUNT = 3;

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
            if (!canReachStructure(game, engineer, target)) {
                return disbandMission(NO_PATH);
            }
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

function canReachStructure(gameApi: GameApi, engineer: UnitData, target: GameObjectData) {
    const reachabilityMap = gameApi.map.getReachabilityMap(SpeedType.Foot, true);
    const range = computeAdjacentRect(toVector2(target.tile), target.foundation, 1);
    const adjacentTiles = getAdjacentTiles(gameApi, range, false);
    for (const tile of adjacentTiles) {
        if (
            reachabilityMap.isReachable(
                toPathNode(engineer.tile, engineer.onBridge ?? false) as any,
                toPathNode(tile, false) as any,
            )
        ) {
            return true;
        }
    }
    return false;
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
        const playerData = game.getPlayerData(context.player.name);
        const savage = context.botProfile?.id === "savage";
        const interval = savage ? Math.floor(CHECK_INTERVAL_TICKS * 0.65) : CHECK_INTERVAL_TICKS;
        if (!(game.getCurrentTick() > this.lastCheckAt + interval)) {
            return;
        }
        this.lastCheckAt = game.getCurrentTick();

        this.maybeCreateTechCaptures(context, missionController, logger);

        if (savage) {
            this.maybeCreateBridgeRepairs(context, missionController, logger);
            this.maybeCreateGarrisons(context, missionController, logger);
        }
    }

    private maybeCreateTechCaptures(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        const { game } = context;
        const playerData = game.getPlayerData(context.player.name);
        const eligibleTechBuildings = game.getVisibleUnits(
            playerData.name,
            "hostile",
            (r) => r.capturable && r.produceCashAmount > 0,
        );

        eligibleTechBuildings.forEach((techBuildingId) => {
            if (
                (this.lostEngineerCounts[techBuildingId] ?? 0) >= MAX_ATTEMPT_COUNT ||
                (this.noPathCounts[techBuildingId] ?? 0) >= MAX_ATTEMPT_COUNT
            ) {
                return;
            }
            const escortLevel = (this.lostEngineerCounts[techBuildingId] ?? 0) + 1;
            missionController.addMission(
                new EngineerMission(
                    "capture-" + techBuildingId,
                    100,
                    techBuildingId,
                    escortLevel,
                    "capture",
                    logger,
                ).withOnFinish((_unitIds, reason) => {
                    if (reason === LOST_ENGINEER) {
                        this.lostEngineerCounts[techBuildingId] =
                            (this.lostEngineerCounts[techBuildingId] ?? 0) + 1;
                    } else if (reason === NO_PATH) {
                        this.noPathCounts[techBuildingId] = (this.noPathCounts[techBuildingId] ?? 0) + 1;
                    }
                }),
            );
        });
    }

    private maybeCreateBridgeRepairs(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        const { game } = context;
        const playerData = game.getPlayerData(context.player.name);
        const active = missionController.getMissions().filter((m) => m.getUniqueName().startsWith("bridge-"));
        if (active.length >= 2) {
            return;
        }

        // Bridge repair huts (CabHut) — neutral buildings with BridgeRepairHut=yes.
        // Only create missions when the associated bridge is actually destroyed.
        const hutIds = game.getVisibleUnits(
            playerData.name,
            "hostile",
            (r) => !!(r as { bridgeRepairHut?: boolean }).bridgeRepairHut,
        );

        for (const hutId of hutIds) {
            if (
                (this.lostEngineerCounts[hutId] ?? 0) >= MAX_ATTEMPT_COUNT ||
                (this.noPathCounts[hutId] ?? 0) >= MAX_ATTEMPT_COUNT
            ) {
                continue;
            }
            const hut = game.getUnitData(hutId);
            if (!hut?.needsBridgeRepair) {
                continue;
            }
            const added = missionController.addMission(
                new EngineerMission("bridge-" + hutId, 105, hutId, 0, "repair_bridge", logger).withOnFinish(
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
                logger(`Created bridge-repair mission for hut ${hutId}`);
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
        if (active.length >= 2) {
            return;
        }

        // Civilian / empty buildings that can be occupied (CanBeOccupied).
        const buildings = game.getVisibleUnits(
            playerData.name,
            "hostile",
            (r) => !!(r as { canBeOccupied?: boolean }).canBeOccupied,
        );

        for (const buildingId of buildings) {
            const data = game.getUnitData(buildingId);
            // Skip owned, enemy-garrisoned, or full buildings.
            if (!data || data.owner === playerData.name) {
                continue;
            }
            const occupied = data.garrisonUnitCount ?? 0;
            const max = data.garrisonUnitsMax ?? 0;
            if (occupied > 0 || (max > 0 && occupied >= max)) {
                continue;
            }
            const added = missionController.addMission(
                new GarrisonMission("garrison-" + buildingId, 70, buildingId, 3, logger),
            );
            if (added) {
                logger(`Created garrison mission for building ${buildingId}`);
                break;
            }
        }
    }
}
