import { GameApi, PlayerData } from "../../../game-api";
import { numBuildingsOwnedOfName } from "./buildingRules";
import { Mission, MissionAction, noop, requestUnitsWithSamePriority } from "../mission/mission";
import { MissionContext } from "../common/context";
import { DebugLogger } from "../common/utils";

const REPAIR_DEPOT_NAMES = ["GADEPT", "NADEPT"];
const WAR_FACTORY_NAMES = ["GAWEAP", "NAWEAP"];

export const MCV_UNIT_NAMES = ["AMCV", "SMCV"] as const;
const ABSOLUTE_MAX_MOBILE_MCVS = 3;

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
 * How many undeployed MCVs Savage AI should keep in reserve.
 * - Needs war factory + repair depot (MCV prerequisites).
 * - 1 spare with one base; +1 per extra conyard (expansion), capped at 3.
 */
export function getDesiredMobileMcvCount(game: GameApi, playerData: PlayerData): number {
    if (!hasWarFactory(game, playerData) || !hasRepairDepot(game, playerData)) {
        return 0;
    }
    const conyards = countConyards(game, playerData.name);
    if (conyards === 0) {
        return 1;
    }
    return Math.min(ABSOLUTE_MAX_MOBILE_MCVS, conyards);
}

export function canProduceMcv(context: {
    player: { production: { getAvailableObjects: () => { name: string }[] } };
}): boolean {
    const available = new Set(context.player.production.getAvailableObjects().map((o) => o.name));
    return MCV_UNIT_NAMES.some((name) => available.has(name));
}

const MCV_RESERVE_PRIORITY = 46;

/**
 * Keeps a stockpile of mobile MCVs once repair depot + war factory are online.
 */
export class McvReserveMission extends Mission {
    constructor(logger: DebugLogger) {
        super("mcv-reserve", logger);
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        if (!context.botProfile?.fortifyBase) {
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

        const desired = getDesiredMobileMcvCount(game, playerData);
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
