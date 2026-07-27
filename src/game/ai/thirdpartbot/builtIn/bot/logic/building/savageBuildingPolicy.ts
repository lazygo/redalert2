import { GameApi, PlayerData } from "../../../game-api";
import { numBuildingsOwnedOfName } from "./buildingRules";

type SavageStructureTarget = {
    /** Build at least this many before falling back to normal priority logic. */
    min: number;
    /** Keep building up to this count with sustainPriority. */
    max?: number;
    priority: number;
    /** Priority while filling from min toward max. */
    sustainPriority?: number;
};

/**
 * Minimum counts / base priorities for Savage AI structure fortification & tech.
 * Applied on top of normal building rules so lower difficulties stay unchanged.
 */
const SAVAGE_STRUCTURE_TARGETS: Record<string, SavageStructureTarget> = {
    // Power redundancy — survive raiders targeting power plants.
    GAPOWR: { min: 3, max: 5, priority: 22, sustainPriority: 10 },
    NAPOWR: { min: 3, max: 5, priority: 22, sustainPriority: 10 },
    NANRCT: { min: 1, max: 2, priority: 20, sustainPriority: 12 },

    // Repair depots — unlock MCV production; build right after war factory.
    GADEPT: { min: 1, priority: 24 },
    NADEPT: { min: 1, priority: 24 },

    // Tech / late-game economy
    GATECH: { min: 1, priority: 24 },
    NATECH: { min: 1, priority: 24 },
    GASPYSAT: { min: 1, priority: 16 },
    GAGAP: { min: 2, max: 3, priority: 14, sustainPriority: 8 },
    NAPSIS: { min: 1, priority: 14 },

    // Air facilities
    GAAIRC: { min: 2, priority: 15 },
    AMRADR: { min: 2, priority: 15 },
    NARADR: { min: 1, priority: 13 },

    // Ground defenses — ring around base, not just the front line.
    ATESLA: { min: 6, max: 10, priority: 13, sustainPriority: 7 },
    TESLA: { min: 6, max: 10, priority: 13, sustainPriority: 7 },
    GAPILL: { min: 10, max: 16, priority: 11, sustainPriority: 6 },
    NALASR: { min: 10, max: 16, priority: 11, sustainPriority: 6 },

    // Anti-air
    NASAM: { min: 8, max: 12, priority: 12, sustainPriority: 6 },
    NAFLAK: { min: 8, max: 12, priority: 12, sustainPriority: 6 },
};

const STATIC_DEFENCE_NAMES = new Set([
    "GAPILL",
    "NALASR",
    "ATESLA",
    "TESLA",
    "NASAM",
    "NAFLAK",
]);

const POWER_PLANT_NAMES = new Set(["GAPOWR", "NAPOWR", "NANRCT"]);

export function isSavageStaticDefence(buildingName: string): boolean {
    return STATIC_DEFENCE_NAMES.has(buildingName);
}

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
    const maxCount = target.max ?? target.min;

    if (owned >= maxCount) {
        return basePriority;
    }

    if (owned >= target.min) {
        const sustain = target.sustainPriority ?? Math.floor(target.priority / 2);
        const progress = (owned - target.min) / Math.max(1, maxCount - target.min);
        const sustainPriority = sustain * (1 - progress);
        return Math.max(basePriority, sustainPriority);
    }

    let fillPriority = target.priority * (1 - owned / target.min);

    if (
        (buildingName === "GADEPT" || buildingName === "NADEPT") &&
        owned === 0 &&
        (numBuildingsOwnedOfName(game, playerData, "GAWEAP") > 0 ||
            numBuildingsOwnedOfName(game, playerData, "NAWEAP") > 0)
    ) {
        fillPriority = Math.max(fillPriority, target.priority + 4);
    }

    // Extra power buffer: keep ~40% surplus so one plant loss doesn't cripple the base.
    if (POWER_PLANT_NAMES.has(buildingName) && playerData.power.drain > 0) {
        const surplusRatio = playerData.power.total / playerData.power.drain;
        if (surplusRatio < 1.45) {
            fillPriority = Math.max(fillPriority, target.priority);
        }
    }

    return Math.max(basePriority, fillPriority);
}
