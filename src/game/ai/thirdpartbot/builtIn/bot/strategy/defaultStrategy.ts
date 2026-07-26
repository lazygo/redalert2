import { Strategy } from "./strategy";
import { ExpansionMissionFactory } from "../logic/mission/missions/expansionMission";
import { ScoutingMissionFactory } from "../logic/mission/missions/scoutingMission";
import { AttackMissionFactory } from "../logic/mission/missions/attackMission";
import { DefenceMissionFactory } from "../logic/mission/missions/defenceMission";
import { EngineerMissionFactory } from "../logic/mission/missions/engineerMission";
import { SpyMissionFactory } from "../logic/mission/missions/spyMission";
import { SupabotContext } from "../logic/common/context";
import { MissionController } from "../logic/mission/missionController";
import { DebugLogger } from "../logic/common/utils";
import { Compositions, getValidCompositions, SideComposition } from "./compositionUtils";
import {
    SIMPLE_BOT_PROFILE,
    scaleCompositionCounts,
    type BotDifficultyProfile,
} from "../BotDifficultyProfile";
import type { GlobalThreat } from "../logic/threat/threat";

const DEFAULT_COMPOSITIONS: Compositions = {
    conscripts: {
        composition: { E2: 1 },
        minimumUnits: 3,
        maximumUnits: 10,
    },
    gis: {
        composition: { E1: 1 },
        minimumUnits: 3,
        maximumUnits: 10,
    },
    sovietTanks: {
        composition: { HTNK: 5, HTK: 1 },
        minimumUnits: 2,
        maximumUnits: 20,
    },
    alliedTanks: {
        composition: { MTNK: 5, FV: 1 },
        minimumUnits: 2,
        maximumUnits: 20,
    },
    kirovs: {
        composition: { ZEP: 1 },
        minimumUnits: 1,
        maximumUnits: 4,
    },
    rocketeers: {
        composition: { JUMPJET: 1 },
        minimumUnits: 2,
        maximumUnits: 8,
    },
    heavySovietTanks: {
        composition: { APOC: 2, HTNK: 1 },
        minimumUnits: 2,
        maximumUnits: 10,
    },
    heavyAlliedTanks: {
        composition: { MTNK: 2, MGTK: 1 },
        minimumUnits: 2,
        maximumUnits: 10,
    },
    sovietArtillery: {
        composition: { V3: 3, HTNK: 1 },
        minimumUnits: 3,
        maximumUnits: 12,
    },
    alliedArtillery: {
        composition: { SREF: 2, MTNK: 1 },
        minimumUnits: 3,
        maximumUnits: 10,
    },
    // Anti-air focused (Savage counters).
    sovietAntiAir: {
        composition: { HTK: 4, FLAKT: 2 },
        minimumUnits: 3,
        maximumUnits: 12,
    },
    alliedAntiAir: {
        composition: { FV: 4, JUMPJET: 2 },
        minimumUnits: 3,
        maximumUnits: 12,
    },
    // Naval (Savage + naval yard).
    sovietNavy: {
        composition: { SUB: 2, DRED: 1, HYD: 2 },
        minimumUnits: 2,
        maximumUnits: 8,
    },
    alliedNavy: {
        composition: { DEST: 2, AEGIS: 1, DLPH: 2 },
        minimumUnits: 2,
        maximumUnits: 8,
    },
    // Mixed air assault.
    sovietAirAssault: {
        composition: { ZEP: 2, HTK: 2 },
        minimumUnits: 2,
        maximumUnits: 8,
    },
    alliedAirAssault: {
        composition: { ORCA: 3, FV: 2 },
        minimumUnits: 2,
        maximumUnits: 10,
    },
    blackEagles: {
        composition: { BEAG: 2 },
        minimumUnits: 2,
        maximumUnits: 8,
    },
    // Specialists (Savage — house/tech gated via getValidCompositions).
    tanyaRaid: {
        composition: { TANY: 1, E1: 2 },
        minimumUnits: 1,
        maximumUnits: 4,
    },
    sniperSquad: {
        composition: { SNIPE: 2, E1: 2 },
        minimumUnits: 2,
        maximumUnits: 8,
    },
    sealTeam: {
        composition: { GHOST: 2, E1: 1 },
        minimumUnits: 2,
        maximumUnits: 6,
    },
    yuriStrike: {
        composition: { YURI: 2, E2: 2 },
        minimumUnits: 2,
        maximumUnits: 6,
    },
    ivanSabotage: {
        composition: { IVAN: 2, DOG: 1 },
        minimumUnits: 2,
        maximumUnits: 6,
    },
    desolatorPush: {
        composition: { DESO: 2, HTNK: 1 },
        minimumUnits: 2,
        maximumUnits: 8,
    },
};

/** Prefer these when enemy air threat dominates. */
const ANTI_AIR_COMPOSITIONS = new Set(["sovietAntiAir", "alliedAntiAir", "rocketeers"]);
/** Prefer these when enemy ground threat dominates. */
const ANTI_GROUND_COMPOSITIONS = new Set([
    "sovietTanks",
    "alliedTanks",
    "heavySovietTanks",
    "heavyAlliedTanks",
    "sovietArtillery",
    "alliedArtillery",
]);
const AIR_ASSAULT_COMPOSITIONS = new Set([
    "kirovs",
    "sovietAirAssault",
    "alliedAirAssault",
    "rocketeers",
    "blackEagles",
]);
const NAVY_COMPOSITIONS = new Set(["sovietNavy", "alliedNavy"]);
const SPECIALIST_COMPOSITIONS = new Set([
    "tanyaRaid",
    "sniperSquad",
    "sealTeam",
    "yuriStrike",
    "ivanSabotage",
    "desolatorPush",
]);
const ARTILLERY_COMPOSITIONS = new Set(["sovietArtillery", "alliedArtillery"]);

export class DefaultStrategy implements Strategy {
    private expansionFactory: ExpansionMissionFactory;
    private scoutingFactory = new ScoutingMissionFactory();
    private attackFactory: AttackMissionFactory;
    private defenceFactory = new DefenceMissionFactory();
    private engineerFactory = new EngineerMissionFactory();
    private spyFactory = new SpyMissionFactory();

    constructor(private profile: BotDifficultyProfile = SIMPLE_BOT_PROFILE) {
        this.expansionFactory = new ExpansionMissionFactory(
            Number.MIN_VALUE,
            profile.expandBeforeTicks,
            profile.conyardPackCooldownTicks,
        );
        this.attackFactory = new AttackMissionFactory(
            -profile.visibleAttackCooldownTicks,
            profile.visibleAttackCooldownTicks,
            profile.baseAttackCooldownTicks,
            profile.maxPreparingAttacks,
        );
    }

    onAiUpdate(context: SupabotContext, missionController: MissionController, logger: DebugLogger) {
        // Ensure profile flags are visible to mission factories via context.
        if (!context.botProfile) {
            (context as { botProfile?: BotDifficultyProfile }).botProfile = this.profile;
        }

        this.expansionFactory.maybeCreateMissions(context, missionController, logger);
        this.scoutingFactory.maybeCreateMissions(context, missionController, logger);

        const composition = this.selectAttackComposition(context, logger);
        if (composition) {
            this.attackFactory.maybeCreateMissions(context, missionController, logger, composition);
        }

        this.defenceFactory.maybeCreateMissions(context, missionController, logger);
        this.engineerFactory.maybeCreateMissions(context, missionController, logger);
        this.spyFactory.maybeCreateMissions(context, missionController, logger);

        return this;
    }

    private selectAttackComposition(context: SupabotContext, logger: DebugLogger): SideComposition | null {
        const playerData = context.game.getPlayerData(context.player.name);
        const side = playerData.country?.side;
        if (side === undefined) {
            return null;
        }

        const validCompositions = getValidCompositions(context, DEFAULT_COMPOSITIONS);
        if (validCompositions.length === 0) {
            return null;
        }

        let candidates = validCompositions;
        if (!this.profile.enableNavy) {
            candidates = candidates.filter((id) => !NAVY_COMPOSITIONS.has(id));
        }
        if (!this.profile.useSpecialists) {
            candidates = candidates.filter((id) => !SPECIALIST_COMPOSITIONS.has(id));
        }

        if (candidates.length === 0) {
            return null;
        }

        let chosenId: string;
        if (this.profile.counterCompositions) {
            chosenId = this.selectCounterComposition(context, candidates, logger);
        } else {
            const randomIndex = context.game.generateRandomInt(0, candidates.length - 1);
            chosenId = candidates[randomIndex];
        }

        logger(`Attack composition: ${chosenId} (from ${candidates.join(", ")})`);
        return scaleCompositionCounts(DEFAULT_COMPOSITIONS[chosenId], this.profile.compositionSizeMultiplier);
    }

    /**
     * Weight compositions by observed enemy threat: air-heavy → AA / rocketeers;
     * ground-heavy → tanks / artillery; weak AA → air assault; navy when enabled & available.
     */
    private selectCounterComposition(
        context: SupabotContext,
        candidates: string[],
        logger: DebugLogger,
    ): string {
        const threat = context.matchAwareness.getThreatCache();
        const preferred = this.rankCompositions(candidates, threat);
        if (preferred.length === 0) {
            return candidates[context.game.generateRandomInt(0, candidates.length - 1)];
        }
        // Soft-random among top-weighted picks so play stays varied.
        const top = preferred.slice(0, Math.min(3, preferred.length));
        const pick = top[context.game.generateRandomInt(0, top.length - 1)];
        logger(
            `Counter pick weights: ${preferred
                .slice(0, 5)
                .map((id) => id)
                .join(", ")}`,
        );
        return pick;
    }

    private rankCompositions(candidates: string[], threat: GlobalThreat | null): string[] {
        const scored = candidates.map((id) => {
            let score = 1;
            if (!threat) {
                if (this.profile.useSpecialists && SPECIALIST_COMPOSITIONS.has(id)) score += 4;
                if (this.profile.boostAir && AIR_ASSAULT_COMPOSITIONS.has(id)) score += 3;
                return { id, score };
            }
            const airThreat = threat.totalOffensiveAirThreat;
            const groundThreat = threat.totalOffensiveLandThreat;
            const enemyAa = threat.totalOffensiveAntiAirThreat;
            const ourAa = threat.totalAvailableAntiAirFirepower;

            if (airThreat > groundThreat * 0.85 && airThreat > 50) {
                if (ANTI_AIR_COMPOSITIONS.has(id)) score += 8;
                if (id === "rocketeers") score += 3;
            }
            if (groundThreat > airThreat * 1.1) {
                if (ANTI_GROUND_COMPOSITIONS.has(id)) score += 6;
                if (ARTILLERY_COMPOSITIONS.has(id)) score += 2;
            }
            // Enemy weak vs air → send air.
            if (enemyAa < ourAa * 0.6 || enemyAa < 40) {
                if (AIR_ASSAULT_COMPOSITIONS.has(id)) score += 5;
            }
            if (this.profile.enableNavy && NAVY_COMPOSITIONS.has(id)) {
                score += 4;
            }
            if (this.profile.boostAir) {
                if (AIR_ASSAULT_COMPOSITIONS.has(id)) score += 4;
                if (id === "kirovs" || id === "blackEagles" || id === "alliedAirAssault") score += 3;
                if (ARTILLERY_COMPOSITIONS.has(id)) score += 3;
            }
            // Specialists: occasional high-value raids when tech unlocks them.
            if (this.profile.useSpecialists && SPECIALIST_COMPOSITIONS.has(id)) {
                score += 5;
                if (id === "tanyaRaid" || id === "yuriStrike") score += 2;
            }
            return { id, score };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored.map((s) => s.id);
    }
}
