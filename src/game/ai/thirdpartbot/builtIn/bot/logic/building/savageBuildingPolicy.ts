import { GameApi, PlayerData } from "../../../game-api";
import { numBuildingsOwnedOfName } from "./buildingRules";
import { countConyards } from "../mission/missions/mcvReserveMission";
import type { BotDifficultyProfile } from "../../BotDifficultyProfile";
import { isSavageProfile } from "../../BotDifficultyProfile";

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
    // Redundant production — parallel infantry / vehicle queues (gated by economy below).
    GAPILE: { min: 1, max: 3, priority: 17, sustainPriority: 8 },
    NAHAND: { min: 1, max: 3, priority: 17, sustainPriority: 8 },
    GAWEAP: { min: 1, max: 3, priority: 19, sustainPriority: 9 },
    NAWEAP: { min: 1, max: 3, priority: 19, sustainPriority: 9 },

    // Power redundancy — survive raiders targeting power plants.
    GAPOWR: { min: 2, max: 4, priority: 22, sustainPriority: 8 },
    NAPOWR: { min: 2, max: 4, priority: 22, sustainPriority: 8 },
    NANRCT: { min: 1, max: 2, priority: 20, sustainPriority: 10 },

    // Repair depots — unlock MCV production; build right after war factory.
    GADEPT: { min: 1, priority: 24 },
    NADEPT: { min: 1, priority: 24 },

    // Tech / late-game — beat redundant power & production spam once prerequisites exist.
    GATECH: { min: 1, priority: 30 },
    NATECH: { min: 1, priority: 30 },
    GASPYSAT: { min: 1, priority: 22 },
    GAGAP: { min: 2, max: 3, priority: 14, sustainPriority: 8 },
    NAPSIS: { min: 1, priority: 18 },

    // Air / radar — unlock battle lab; must outrank static-defence sustain.
    GAAIRC: { min: 1, max: 2, priority: 26, sustainPriority: 12 },
    AMRADR: { min: 1, max: 2, priority: 26, sustainPriority: 12 },
    NARADR: { min: 1, priority: 26 },

    // Ground defenses — ring around base, not just the front line.
    ATESLA: { min: 4, max: 8, priority: 13, sustainPriority: 5 },
    TESLA: { min: 4, max: 8, priority: 13, sustainPriority: 5 },
    GAPILL: { min: 6, max: 12, priority: 10, sustainPriority: 4 },
    NALASR: { min: 6, max: 12, priority: 10, sustainPriority: 4 },

    // Anti-air
    NASAM: { min: 4, max: 8, priority: 11, sustainPriority: 5 },
    NAFLAK: { min: 4, max: 8, priority: 11, sustainPriority: 5 },
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

const PRODUCTION_STRUCTURE_NAMES = new Set(["GAPILE", "NAHAND", "GAWEAP", "NAWEAP"]);
const REFINERY_NAMES = ["GAREFN", "NAREFN"];
const BARRACKS_NAMES = ["GAPILE", "NAHAND"];
const WAR_FACTORY_NAMES = ["GAWEAP", "NAWEAP"];

function countRefineries(game: GameApi, playerData: PlayerData): number {
    return REFINERY_NAMES.reduce((sum, name) => sum + numBuildingsOwnedOfName(game, playerData, name), 0);
}

function hasPowerHeadroom(playerData: PlayerData, minSurplusRatio = 1.22): boolean {
    if (playerData.power.drain <= 0) {
        return true;
    }
    return playerData.power.total / playerData.power.drain >= minSurplusRatio;
}

function countCombatants(game: GameApi, playerName: string): number {
    return game.getVisibleUnits(
        playerName,
        "self",
        (r) => !!(r as { isSelectableCombatant?: boolean }).isSelectableCombatant,
    ).length;
}

/**
 * How many barracks / war factories Savage may build right now (economy-gated).
 * First of each type still follows normal building rules.
 */
export function resolveSavageProductionMaxCount(
    buildingName: string,
    game: GameApi,
    playerData: PlayerData,
    profile?: BotDifficultyProfile,
): number | null {
    if (!isSavageProfile(profile) || !PRODUCTION_STRUCTURE_NAMES.has(buildingName)) {
        return null;
    }

    const target = SAVAGE_STRUCTURE_TARGETS[buildingName];
    if (!target) {
        return null;
    }

    const owned = numBuildingsOwnedOfName(game, playerData, buildingName);
    const hardMax = target.max ?? target.min;

    if (owned === 0) {
        return 1;
    }

    if (countRefineries(game, playerData) < 1) {
        return owned;
    }

    const isBarracks = BARRACKS_NAMES.includes(buildingName);
    const isWarFactory = WAR_FACTORY_NAMES.includes(buildingName);

    if (isBarracks && !WAR_FACTORY_NAMES.some((name) => numBuildingsOwnedOfName(game, playerData, name) > 0)) {
        return owned;
    }
    if (isWarFactory && !BARRACKS_NAMES.some((name) => numBuildingsOwnedOfName(game, playerData, name) > 0)) {
        return owned;
    }

    if (playerData.credits < 3500 || !hasPowerHeadroom(playerData)) {
        return owned;
    }

    let allowed = 2;

    const conyards = countConyards(game, playerData.name);
    const army = countCombatants(game, playerData.name);
    const canSupportThird =
        playerData.credits >= 9000 &&
        hasPowerHeadroom(playerData, 1.3) &&
        (conyards >= 2 || army >= 14);

    if (canSupportThird) {
        allowed = hardMax;
    }

    return Math.min(hardMax, Math.max(owned, allowed));
}

/** Priority for 2nd+ production buildings when base rules cap at 1. */
export function computeSavageRedundantProductionPriority(
    buildingName: string,
    game: GameApi,
    playerData: PlayerData,
    profile?: BotDifficultyProfile,
): number {
    const maxCount = resolveSavageProductionMaxCount(buildingName, game, playerData, profile);
    const target = SAVAGE_STRUCTURE_TARGETS[buildingName];
    if (!maxCount || !target) {
        return 0;
    }

    const owned = numBuildingsOwnedOfName(game, playerData, buildingName);
    if (owned >= maxCount) {
        return -100;
    }
    if (owned < target.min) {
        return 0;
    }

    const sustain = target.sustainPriority ?? Math.floor(target.priority / 2);
    const span = Math.max(1, maxCount - target.min);
    const progress = (owned - target.min) / span;
    return Math.max(0, sustain * (1 - progress));
}

export function isSavageProductionStructure(buildingName: string): boolean {
    return PRODUCTION_STRUCTURE_NAMES.has(buildingName);
}

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

    // Extra power buffer: keep ~25% surplus — don't starve tech for endless plants.
    if (POWER_PLANT_NAMES.has(buildingName) && playerData.power.drain > 0) {
        const surplusRatio = playerData.power.total / playerData.power.drain;
        if (surplusRatio < 1.25) {
            fillPriority = Math.max(fillPriority, target.priority);
        }
    }

    return Math.max(basePriority, fillPriority);
}
