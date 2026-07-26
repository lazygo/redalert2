/**
 * Tunable profiles for BuiltInBot difficulties.
 * Simple = legacy default behaviour; Normal/Brutal scale aggression & economy.
 */
export interface BotDifficultyProfile {
    id: 'simple' | 'normal' | 'brutal';
    /** Approximate actions per minute (tick throttling). */
    botApm: number;
    /** Ticks between attacking visible targets. */
    visibleAttackCooldownTicks: number;
    /** Ticks before attacks may target enemy bases / start locations. */
    baseAttackCooldownTicks: number;
    /** Max concurrent Preparing attack missions. */
    maxPreparingAttacks: number;
    /** Multiplier for squad min/max unit counts. */
    compositionSizeMultiplier: number;
    /** Do not start base expansions before this tick (after initial MCV deploy window). */
    expandBeforeTicks: number;
    /** Cooldown between packing a conyard to expand. */
    conyardPackCooldownTicks: number;
    /** If > 0, grant cheat credits every N ticks. */
    cheatCreditsIntervalTicks: number;
    cheatCreditsAmount: number;
}

/** Current BuiltInBot defaults — used for AI-简单. */
export const SIMPLE_BOT_PROFILE: BotDifficultyProfile = {
    id: 'simple',
    botApm: 300,
    visibleAttackCooldownTicks: 60,
    baseAttackCooldownTicks: 600,
    maxPreparingAttacks: 2,
    compositionSizeMultiplier: 1,
    expandBeforeTicks: 15 * 60 * 6,
    conyardPackCooldownTicks: 15 * 60 * 6,
    cheatCreditsIntervalTicks: 0,
    cheatCreditsAmount: 0,
};

/** Enhanced — AI-普通. */
export const NORMAL_BOT_PROFILE: BotDifficultyProfile = {
    id: 'normal',
    botApm: 360,
    visibleAttackCooldownTicks: 40,
    baseAttackCooldownTicks: 360,
    maxPreparingAttacks: 3,
    compositionSizeMultiplier: 1.4,
    expandBeforeTicks: 15 * 60 * 4,
    conyardPackCooldownTicks: 15 * 60 * 4,
    cheatCreditsIntervalTicks: 0,
    cheatCreditsAmount: 0,
};

/** Aggressive + light cheat economy — AI-冷酷. */
export const BRUTAL_BOT_PROFILE: BotDifficultyProfile = {
    id: 'brutal',
    botApm: 420,
    visibleAttackCooldownTicks: 25,
    baseAttackCooldownTicks: 200,
    maxPreparingAttacks: 4,
    compositionSizeMultiplier: 1.85,
    expandBeforeTicks: 15 * 60 * 2.5,
    conyardPackCooldownTicks: 15 * 60 * 3,
    cheatCreditsIntervalTicks: 15 * 20, // every ~20s at 15 tick/s
    cheatCreditsAmount: 800,
};

export function scaleCompositionCounts<T extends { minimumUnits: number; maximumUnits: number }>(
    composition: T,
    multiplier: number,
): T {
    if (multiplier === 1) {
        return composition;
    }
    return {
        ...composition,
        minimumUnits: Math.max(1, Math.round(composition.minimumUnits * multiplier)),
        maximumUnits: Math.max(1, Math.round(composition.maximumUnits * multiplier)),
    };
}
