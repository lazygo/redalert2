import { GameApi, PlayerData } from "../../../game-api";
import { numBuildingsOwnedOfName } from "./buildingRules";

/**
 * Minimum counts / base priorities for Savage AI structure fortification & tech.
 * Applied on top of normal building rules so lower difficulties stay unchanged.
 */
const SAVAGE_STRUCTURE_TARGETS: Record<string, { min: number; priority: number }> = {
    // Tech / late-game economy
    GATECH: { min: 1, priority: 24 },
    NATECH: { min: 1, priority: 24 },
    GASPYSAT: { min: 1, priority: 16 },
    GAGAP: { min: 2, priority: 14 }, // 裂缝产生器
    NAPSIS: { min: 1, priority: 14 },
    NANRCT: { min: 1, priority: 18 },

    // Air facilities
    GAAIRC: { min: 2, priority: 15 },
    AMRADR: { min: 2, priority: 15 },
    NARADR: { min: 1, priority: 13 },

    // Ground defenses
    ATESLA: { min: 5, priority: 12 },
    TESLA: { min: 5, priority: 12 },
    GAPILL: { min: 7, priority: 9 },
    NALASR: { min: 7, priority: 9 },

    // Anti-air
    NASAM: { min: 6, priority: 11 },
    NAFLAK: { min: 6, priority: 11 },
};

/**
 * Ensure Savage bots keep building key defenses / tech even when threat cache
 * would otherwise leave static-defence priority at 0.
 */
export function applySavageStructurePriority(
    buildingName: string,
    basePriority: number,
    game: GameApi,
    playerData: PlayerData,
): number {
    const target = SAVAGE_STRUCTURE_TARGETS[buildingName];
    if (!target) {
        return basePriority;
    }
    const owned = numBuildingsOwnedOfName(game, playerData, buildingName);
    if (owned >= target.min) {
        return basePriority;
    }
    const fillPriority = target.priority * (1 - owned / target.min);
    return Math.max(basePriority, fillPriority);
}
