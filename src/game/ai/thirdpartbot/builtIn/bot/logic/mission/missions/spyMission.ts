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

const INFILTRATE_COOLDOWN_TICKS = 45;
const SPY_CHECK_INTERVAL_TICKS = 240;
const MAX_SPY_ATTEMPTS = 3;

const HIGH_VALUE_SPY_TARGETS = new Set([
    "GATECH",
    "NATECH",
    "GAWEAP",
    "NAWEAP",
    "GAAIRC",
    "AMRADR",
    "NARADR",
    "GAPOWR",
    "NAPOWR",
    "NANRCT",
    "GAPILE",
    "NAHAND",
    "GAREFN",
    "NAREFN",
]);

enum SpyMissionState {
    Preparing = 0,
    Infiltrating = 1,
}

const LOST_SPY = "lost_spy";
const NO_PATH = "no_path";

/**
 * Allied spy infiltration — targets high-value enemy buildings.
 * Only used by Savage-tier bots on the Allied (GDI) side.
 */
export class SpyMission extends Mission {
    private state = SpyMissionState.Preparing;
    private lastInfiltrateAttemptTick = -1;

    constructor(
        uniqueName: string,
        private priority: number,
        private infiltrateTargetId: number,
        private escortLevel: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    get targetId() {
        return this.infiltrateTargetId;
    }

    public _onAiUpdate(context: MissionContext): MissionAction {
        const { game } = context;
        const actionsApi = context.player.actions;
        const playerData = game.getPlayerData(context.player.name);
        const spies = this.getUnitsOfTypes(game, "SPY");

        const target = game.getGameObjectData(this.infiltrateTargetId);
        if (!target || target.owner === playerData.name) {
            return disbandMission();
        }

        if (spies.length === 0 && this.state === SpyMissionState.Infiltrating) {
            return disbandMission(LOST_SPY);
        }

        if (this.state === SpyMissionState.Preparing) {
            const composition: UnitComposition = {
                SPY: 1,
                ADOG: Math.max(0, this.escortLevel - 1),
                MTNK: Math.max(0, this.escortLevel - 2),
            };
            const missingUnits = this.getMissingUnits(game, composition);
            if (missingUnits.length > 0) {
                return requestUnitsWithSamePriority(
                    missingUnits.map(([unitName]) => unitName),
                    this.priority,
                );
            }
            this.state = SpyMissionState.Infiltrating;
        }

        if (
            this.state === SpyMissionState.Infiltrating &&
            game.getCurrentTick() > this.lastInfiltrateAttemptTick + INFILTRATE_COOLDOWN_TICKS
        ) {
            const spy = spies[0];
            if (!canReachStructure(game, spy, target)) {
                return disbandMission(NO_PATH);
            }
            actionsApi.orderUnits([spy.id], OrderType.Occupy, this.infiltrateTargetId);
            const escortUnits = this.getUnitsOfTypes(game, "ADOG", "MTNK");
            if (escortUnits.length > 0) {
                actionsApi.orderUnits(
                    escortUnits.map((u) => u.id),
                    OrderType.Guard,
                    spy.id,
                );
            }
            this.lastInfiltrateAttemptTick = game.getCurrentTick();
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

function canReachStructure(gameApi: GameApi, spy: UnitData, target: GameObjectData) {
    const reachabilityMap = gameApi.map.getReachabilityMap(SpeedType.Foot, true);
    const range = computeAdjacentRect(toVector2(target.tile), target.foundation, 1);
    const adjacentTiles = getAdjacentTiles(gameApi, range, false);
    for (const tile of adjacentTiles) {
        if (
            reachabilityMap.isReachable(
                toPathNode(spy.tile, spy.onBridge ?? false) as any,
                toPathNode(tile, false) as any,
            )
        ) {
            return true;
        }
    }
    return false;
}

export class SpyMissionFactory {
    private lastCheckAt = 0;
    private lostSpyCounts: { [buildingId: number]: number } = {};
    private noPathCounts: { [buildingId: number]: number } = {};

    maybeCreateMissions(context: SupabotContext, missionController: MissionController, logger: DebugLogger): void {
        if (!context.botProfile?.useSpies) {
            return;
        }
        const { game } = context;
        const playerData = game.getPlayerData(context.player.name);
        if (playerData.country?.side !== SideType.GDI) {
            return;
        }
        if (!(game.getCurrentTick() > this.lastCheckAt + SPY_CHECK_INTERVAL_TICKS)) {
            return;
        }
        this.lastCheckAt = game.getCurrentTick();

        const activeSpyMissions = missionController
            .getMissions()
            .filter((m) => m.getUniqueName().startsWith("spy-"));
        if (activeSpyMissions.length >= 2) {
            return;
        }

        const targets: number[] = [];
        for (const name of HIGH_VALUE_SPY_TARGETS) {
            targets.push(...game.getVisibleUnits(playerData.name, "hostile", (r) => r.name === name));
        }

        for (const buildingId of targets) {
            if (
                (this.lostSpyCounts[buildingId] ?? 0) >= MAX_SPY_ATTEMPTS ||
                (this.noPathCounts[buildingId] ?? 0) >= MAX_SPY_ATTEMPTS
            ) {
                continue;
            }
            const escortLevel = (this.lostSpyCounts[buildingId] ?? 0) + 1;
            const added = missionController.addMission(
                new SpyMission("spy-" + buildingId, 95, buildingId, escortLevel, logger).withOnFinish(
                    (_unitIds, reason) => {
                        if (reason === LOST_SPY) {
                            this.lostSpyCounts[buildingId] = (this.lostSpyCounts[buildingId] ?? 0) + 1;
                        } else if (reason === NO_PATH) {
                            this.noPathCounts[buildingId] = (this.noPathCounts[buildingId] ?? 0) + 1;
                        }
                    },
                ),
            );
            if (added) {
                break;
            }
        }
    }
}
