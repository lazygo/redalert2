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

const INFILTRATE_COOLDOWN_TICKS = 40;
const SPY_CHECK_INTERVAL_TICKS = 120;
const MAX_SPY_ATTEMPTS = 4;
/** Keep requesting spies this long after an infiltrate order (spy is unspawned on success). */
const INFILTRATE_SUCCESS_GRACE_TICKS = 90;

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
    "GADEPT",
    "NADEPT",
]);

enum SpyMissionState {
    Preparing = 0,
    Hunting = 1,
    Infiltrating = 2,
}

const LOST_SPY = "lost_spy";
// const NO_PATH = "no_path";
const SUCCESS = "success";

/**
 * Allied spy infiltration. No attack-dog escorts (dogs kill spies).
 * Can start without a target (standby) so production is requested even before scouting reveals bases.
 */
export class SpyMission extends Mission {
    private state = SpyMissionState.Preparing;
    private lastInfiltrateAttemptTick = -1;
    private infiltrateOrderedAt = -1;

    constructor(
        uniqueName: string,
        private priority: number,
        private infiltrateTargetId: number | null,
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

        // Successful infiltration unspawns the spy — treat recent disappearances as success.
        if (
            spies.length === 0 &&
            this.state === SpyMissionState.Infiltrating &&
            this.infiltrateOrderedAt >= 0 &&
            game.getCurrentTick() - this.infiltrateOrderedAt < INFILTRATE_SUCCESS_GRACE_TICKS
        ) {
            return disbandMission(SUCCESS);
        }

        if (spies.length === 0 && this.state === SpyMissionState.Infiltrating) {
            return disbandMission(LOST_SPY);
        }

        if (this.state === SpyMissionState.Preparing) {
            const composition: UnitComposition = { SPY: 1 };
            const missingUnits = this.getMissingUnits(game, composition);
            if (missingUnits.length > 0) {
                return requestUnitsWithSamePriority(
                    missingUnits.map(([unitName]) => unitName),
                    this.priority,
                );
            }
            this.state = this.infiltrateTargetId != null ? SpyMissionState.Infiltrating : SpyMissionState.Hunting;
        }

        if (this.state === SpyMissionState.Hunting || this.infiltrateTargetId == null) {
            const targetId = pickBestSpyTarget(game, playerData.name);
            if (targetId == null) {
                // Keep the spy ready; keep priority so production / assignment stays alive.
                return requestUnitsWithSamePriority(["SPY"], this.priority);
            }
            this.infiltrateTargetId = targetId;
            this.state = SpyMissionState.Infiltrating;
            this.logger(`Spy mission acquired target ${targetId}`);
        }

        const target = game.getGameObjectData(this.infiltrateTargetId!);
        if (!target || target.owner === playerData.name) {
            // Target gone / captured — hunt again with existing spy.
            this.infiltrateTargetId = null;
            this.state = SpyMissionState.Hunting;
            this.infiltrateOrderedAt = -1;
            return noop();
        }

        if (
            this.state === SpyMissionState.Infiltrating &&
            game.getCurrentTick() > this.lastInfiltrateAttemptTick + INFILTRATE_COOLDOWN_TICKS
        ) {
            const spy = spies[0];
            if (!spy) {
                return requestUnitsWithSamePriority(["SPY"], this.priority);
            }
            if (!canReachStructure(game, spy, target)) {
                // Try another building instead of permanently blacklisting via NO_PATH on first failure.
                this.infiltrateTargetId = null;
                this.state = SpyMissionState.Hunting;
                return noop();
            }
            actionsApi.orderUnits([spy.id], OrderType.Occupy, this.infiltrateTargetId!);
            this.lastInfiltrateAttemptTick = game.getCurrentTick();
            this.infiltrateOrderedAt = game.getCurrentTick();
            this.logger(`Spy ${spy.id} infiltrating building ${this.infiltrateTargetId}`);
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

function pickBestSpyTarget(game: GameApi, playerName: string): number | null {
    const targets = game.getVisibleUnits(
        playerName,
        "enemy",
        (r) => !!(r as { spyable?: boolean }).spyable || HIGH_VALUE_SPY_TARGETS.has(r.name),
    );
    if (targets.length === 0) {
        return null;
    }
    // Prefer battle lab / war factory / radar / power.
    const prefer = ["GATECH", "NATECH", "GAWEAP", "NAWEAP", "AMRADR", "NARADR", "GAPOWR", "NAPOWR", "NANRCT"];
    for (const name of prefer) {
        const hit = targets.find((id) => game.getGameObjectData(id)?.name === name);
        if (hit != null) {
            return hit;
        }
    }
    return targets[0];
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
        // Always keep one standby/active spy mission so SPY is actually produced.
        if (activeSpyMissions.length >= 1) {
            return;
        }

        const targetId = pickBestSpyTarget(game, playerData.name);
        if (targetId != null) {
            if ((this.lostSpyCounts[targetId] ?? 0) >= MAX_SPY_ATTEMPTS) {
                // Fall through to standby so we still train spies for other buildings later.
            } else {
                const added = missionController.addMission(
                    new SpyMission("spy-" + targetId, 110, targetId, logger).withOnFinish((_unitIds, reason) => {
                        if (reason === LOST_SPY) {
                            this.lostSpyCounts[targetId] = (this.lostSpyCounts[targetId] ?? 0) + 1;
                        }
                    }),
                );
                if (added) {
                    logger(`Created spy mission for building ${targetId}`);
                    return;
                }
            }
        }

        // Standby: train a spy before enemy buildings are revealed.
        const added = missionController.addMission(new SpyMission("spy-standby", 100, null, logger));
        if (added) {
            logger(`Created standby spy mission (waiting for targets)`);
        }
    }
}
