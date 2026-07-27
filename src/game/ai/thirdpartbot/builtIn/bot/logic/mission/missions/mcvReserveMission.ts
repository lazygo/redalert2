import { GameApi, PlayerData } from "../../../../game-api";
import { numBuildingsOwnedOfName } from "../../building/buildingRules";
import { Mission, MissionAction, noop, requestUnitsWithSamePriority } from "../mission";
import { MissionContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import type { StrategicFocusPlanner } from "../../../strategy/strategicFocusPlanner";

const REPAIR_DEPOT_NAMES = ["GADEPT", "NADEPT"];
const WAR_FACTORY_NAMES = ["GAWEAP", "NAWEAP"];

export const MCV_UNIT_NAMES = ["AMCV", "SMCV"] as const;
const ABSOLUTE_MAX_MOBILE_MCVS = 2;

/** During expand windows MCV must outrank harass fill (~38) but stay below oil/spy. */
const MCV_RESERVE_PRIORITY = 48;

export function hasRepairDepot(game: GameApi, playerData: PlayerData): boolean {
    return REPAIR_DEPOT_NAMES.some((name) => numBuildingsOwnedOfName(game, playerData, name) > 0);
}

export function hasWarFactory(game: GameApi, playerData: PlayerData): boolean {
    return WAR_FACTORY_NAMES.some((name) => numBuildingsOwnedOfName(game, playerData, name) > 0);
}

export function countMobileMcvs(game: GameApi, playerName: string): number {
    return game
        .getVisibleUnits(playerName, "self", (r) => game.getGeneralRules().baseUnit.includes(r.name))
        .length;
}

export function countConyards(game: GameApi, playerName: string): number {
    return game.getVisibleUnits(playerName, "self", (r) => r.constructionYard).length;
}

/**
 * Spare MCV target — only during an active expand window, not permanently at 1 per base.
 */
export function getDesiredMobileMcvCount(
    game: GameApi,
    playerData: PlayerData,
    expansionInvesting: boolean,
): number {
    if (!expansionInvesting || !hasWarFactory(game, playerData) || !hasRepairDepot(game, playerData)) {
        return 0;
    }
    const conyards = countConyards(game, playerData.name);
    if (conyards <= 1) {
        return 1;
    }
    return Math.min(ABSOLUTE_MAX_MOBILE_MCVS, conyards - 1);
}

export function canProduceMcv(context: {
    player: { production: { getAvailableObjects: () => { name: string }[] } };
}): boolean {
    const available = new Set(context.player.production.getAvailableObjects().map((o) => o.name));
    return MCV_UNIT_NAMES.some((name) => available.has(name));
}

/**
 * Keeps a spare MCV only during expansion windows, after a minimum army exists.
 */
export class McvReserveMission extends Mission {
    constructor(
        logger: DebugLogger,
        private focusPlanner: StrategicFocusPlanner,
    ) {
        super("mcv-reserve", logger);
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        if (!context.botProfile?.fortifyBase) {
            return noop();
        }

        if (!this.focusPlanner.shouldInvestInExpansion(context)) {
            return noop();
        }

        const { game } = context;
        const playerData = game.getPlayerData(context.player.name);

        if (!hasWarFactory(game, playerData) || !hasRepairDepot(game, playerData)) {
            return noop();
        }
        if (!canProduceMcv(context)) {
            return noop();
        }

        const desired = getDesiredMobileMcvCount(game, playerData, true);
        const owned = countMobileMcvs(game, context.player.name);
        if (owned >= desired) {
            return noop();
        }

        return requestUnitsWithSamePriority([...MCV_UNIT_NAMES], MCV_RESERVE_PRIORITY);
    }

    getGlobalDebugText(): string | undefined {
        return "mcv-reserve";
    }

    getPriority() {
        return MCV_RESERVE_PRIORITY;
    }
}
