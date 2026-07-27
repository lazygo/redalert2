/**
 * Tunable profiles for BuiltInBot difficulties.
 * Simple = legacy default behaviour; Normal/Brutal/Savage scale aggression & tactics.
 */
export interface BotDifficultyProfile {
    id: 'simple' | 'normal' | 'brutal' | 'savage';
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
    /** Build naval yards and include naval attack compositions when available. */
    enableNavy?: boolean;
    /** Prefer compositions that counter observed enemy air/ground mix. */
    counterCompositions?: boolean;
    /** Send Allied spies to infiltrate enemy production / tech. */
    useSpies?: boolean;
    /** Proactively fortify base (Tesla/Prism/AA/Gap Generator 裂缝产生器 / SpySat etc.). */
    fortifyBase?: boolean;
    /** Field specialists: Tanya, Sniper, Yuri, Ivan, Desolator, etc. when tech allows. */
    useSpecialists?: boolean;
    /** Prefer stronger air / artillery attack compositions (Kirov, Black Eagle, V3, Harriers). */
    boostAir?: boolean;
    /** Gather one larger wave at a time instead of many small squads (assault phase). */
    batchAttacks?: boolean;
    /** Weighted harass vs assault waves (not strict alternation). */
    alternateAttackWaves?: boolean;
    /** Floor for minimumUnits on standard assault compositions. */
    minAttackWaveUnits?: number;
    /** Ticks before shrinking desired assault squad size while preparing. */
    attackSquadDecayTicks?: number;
    /** Harass wave size (alternateAttackWaves). */
    harassWaveUnits?: number;
    harassWaveMaxUnits?: number;
    /** Cooldown between harassment raids (defaults to ~55% of visibleAttackCooldownTicks). */
    harassAttackCooldownTicks?: number;
    /** Faster decay while preparing a harass squad. */
    harassSquadDecayTicks?: number;
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

/** Harder than Brutal — multi-domain + counters + spies — AI-残暴. */
export const SAVAGE_BOT_PROFILE: BotDifficultyProfile = {
    id: 'savage',
    botApm: 480,
    visibleAttackCooldownTicks: 50,
    baseAttackCooldownTicks: 160,
    maxPreparingAttacks: 1,
    compositionSizeMultiplier: 2.2,
    expandBeforeTicks: 15 * 60 * 1.8,
    conyardPackCooldownTicks: 15 * 60 * 2,
    cheatCreditsIntervalTicks: 15 * 12, // every ~12s
    cheatCreditsAmount: 1200,
    enableNavy: true,
    counterCompositions: true,
    useSpies: true,
    fortifyBase: true,
    useSpecialists: true,
    boostAir: true,
    batchAttacks: true,
    alternateAttackWaves: true,
    minAttackWaveUnits: 12,
    attackSquadDecayTicks: 240,
    harassWaveUnits: 4,
    harassWaveMaxUnits: 6,
    harassAttackCooldownTicks: 32,
    harassSquadDecayTicks: 100,
};

export function scaleHarassComposition<T extends { minimumUnits: number; maximumUnits: number }>(
    composition: T,
    minUnits: number,
    maxUnits: number,
): T {
    return {
        ...composition,
        minimumUnits: minUnits,
        maximumUnits: Math.max(maxUnits, minUnits),
    };
}

export function scaleCompositionCounts<T extends { minimumUnits: number; maximumUnits: number }>(
    composition: T,
    multiplier: number,
    minWaveUnits?: number,
): T {
    if (multiplier === 1 && !minWaveUnits) {
        return composition;
    }
    let minimumUnits = Math.max(1, Math.round(composition.minimumUnits * multiplier));
    let maximumUnits = Math.max(1, Math.round(composition.maximumUnits * multiplier));
    if (minWaveUnits !== undefined) {
        minimumUnits = Math.max(minimumUnits, minWaveUnits);
        maximumUnits = Math.max(maximumUnits, minimumUnits + Math.round(minWaveUnits * 0.35));
    }
    return {
        ...composition,
        minimumUnits,
        maximumUnits,
    };
}
