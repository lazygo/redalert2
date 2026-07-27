import { Strategy } from "./strategy";
import { ExpansionMissionFactory } from "../logic/mission/missions/expansionMission";
import { ScoutingMissionFactory } from "../logic/mission/missions/scoutingMission";
import { AttackMissionFactory } from "../logic/mission/missions/attackMission";
import { DefenceMissionFactory } from "../logic/mission/missions/defenceMission";
import { EngineerMissionFactory } from "../logic/mission/missions/engineerMission";
import { BaseGuardMissionFactory } from "../logic/mission/missions/baseGuardMission";
import { DogPatrolMissionFactory } from "../logic/mission/missions/dogPatrolMission";
import { McvReserveMissionFactory } from "../logic/mission/missions/mcvReserveMissionFactory";
import { SpyMissionFactory } from "../logic/mission/missions/spyMission";
import { SupabotContext } from "../logic/common/context";
import { MissionController } from "../logic/mission/missionController";
import { DebugLogger } from "../logic/common/utils";
import { Compositions, getValidCompositions, SideComposition } from "./compositionUtils";
import { countNavalYards } from "../logic/building/navalYardBuilding";
import {
    SIMPLE_BOT_PROFILE,
    scaleCompositionCounts,
    scaleHarassComposition,
    type BotDifficultyProfile,
} from "../BotDifficultyProfile";
import type { GlobalThreat } from "../logic/threat/threat";
import { AttackWaveKind, AttackWavePlanner } from "./attackWavePlanner";
import { HarvesterHarassMissionFactory } from "../logic/mission/missions/harvesterHarassMission";
import { StrategicFocusPlanner } from "./strategicFocusPlanner";
import { GrandAssaultPlanner } from "./grandAssaultPlanner";

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
    // Naval — basic ships (no tech beyond naval yard).
    sovietNavy: {
        composition: { SUB: 4 },
        minimumUnits: 2,
        maximumUnits: 8,
    },
    alliedNavy: {
        composition: { DEST: 4 },
        minimumUnits: 2,
        maximumUnits: 8,
    },
    // Naval — mid tier (radar): escort / anti-air on water.
    sovietNavyEscort: {
        composition: { HYD: 3, SUB: 2 },
        minimumUnits: 3,
        maximumUnits: 10,
    },
    alliedNavyEscort: {
        composition: { AEGIS: 2, DEST: 3 },
        minimumUnits: 3,
        maximumUnits: 10,
    },
    // Naval — late tier (battle lab): heavy bombardment & carrier groups.
    sovietNavyHeavy: {
        composition: { DRED: 2, SUB: 2 },
        minimumUnits: 3,
        maximumUnits: 8,
    },
    alliedNavyHeavy: {
        composition: { CARRIER: 1, AEGIS: 2, DEST: 2 },
        minimumUnits: 4,
        maximumUnits: 10,
    },
    alliedNavyDolphins: {
        composition: { DLPH: 4, DEST: 2 },
        minimumUnits: 3,
        maximumUnits: 10,
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
const BASIC_NAVY_COMPOSITIONS = new Set(["sovietNavy", "alliedNavy"]);
const ADVANCED_NAVY_COMPOSITIONS = new Set([
    "sovietNavyEscort",
    "alliedNavyEscort",
    "sovietNavyHeavy",
    "alliedNavyHeavy",
    "alliedNavyDolphins",
]);
const NAVY_AA_ESCORT_COMPOSITIONS = new Set(["sovietNavyEscort", "alliedNavyEscort"]);
const NAVY_HEAVY_COMPOSITIONS = new Set(["sovietNavyHeavy", "alliedNavyHeavy"]);
const NAVY_COMPOSITIONS = new Set([...BASIC_NAVY_COMPOSITIONS, ...ADVANCED_NAVY_COMPOSITIONS]);
const SPECIALIST_COMPOSITIONS = new Set([
    "tanyaRaid",
    "sniperSquad",
    "sealTeam",
    "yuriStrike",
    "ivanSabotage",
    "desolatorPush",
]);
/** Small elite / air raids — do not apply mass-wave minimums. */
const SMALL_WAVE_COMPOSITIONS = new Set([...SPECIALIST_COMPOSITIONS, "kirovs", "blackEagles"]);
/** Compositions suited to fast, small harassment raids. */
const HARASS_COMPOSITIONS = new Set([
    "conscripts",
    "gis",
    "rocketeers",
    "sovietTanks",
    "alliedTanks",
    "sealTeam",
    "sniperSquad",
    "ivanSabotage",
    "alliedAirAssault",
    "blackEagles",
    "sovietNavy",
    "alliedNavy",
]);
const ARTILLERY_COMPOSITIONS = new Set(["sovietArtillery", "alliedArtillery"]);

export class DefaultStrategy implements Strategy {
    private expansionFactory: ExpansionMissionFactory;
    private scoutingFactory = new ScoutingMissionFactory();
    private attackFactory: AttackMissionFactory;
    private defenceFactory = new DefenceMissionFactory();
    private engineerFactory = new EngineerMissionFactory();
    private baseGuardFactory = new BaseGuardMissionFactory();
    private dogPatrolFactory = new DogPatrolMissionFactory();
    private harvesterHarassFactory = new HarvesterHarassMissionFactory();
    private mcvReserveFactory: McvReserveMissionFactory;
    private spyFactory = new SpyMissionFactory();
    private wavePlanner = new AttackWavePlanner();
    private grandAssaultPlanner = new GrandAssaultPlanner();
    private focusPlanner = new StrategicFocusPlanner(this.grandAssaultPlanner);
    private lastGrandDebugAt = -9999;

    constructor(private profile: BotDifficultyProfile = SIMPLE_BOT_PROFILE) {
        this.expansionFactory = new ExpansionMissionFactory(
            Number.MIN_VALUE,
            profile.expandBeforeTicks,
            profile.conyardPackCooldownTicks,
            this.focusPlanner,
        );
        this.attackFactory = new AttackMissionFactory(
            -profile.visibleAttackCooldownTicks,
            profile.visibleAttackCooldownTicks,
            profile.baseAttackCooldownTicks,
            profile.maxPreparingAttacks,
            this.wavePlanner,
            this.focusPlanner,
            this.grandAssaultPlanner,
        );
        this.mcvReserveFactory = new McvReserveMissionFactory(this.focusPlanner);
    }

    onAiUpdate(context: SupabotContext, missionController: MissionController, logger: DebugLogger) {
        // Ensure profile flags are visible to mission factories via context.
        if (!context.botProfile) {
            (context as { botProfile?: BotDifficultyProfile }).botProfile = this.profile;
        }

        this.focusPlanner.onTick(context, missionController);

        const tick = context.game.getCurrentTick();
        if (this.profile.grandAssaultMode && tick > this.lastGrandDebugAt + 15 * 30) {
            this.lastGrandDebugAt = tick;
            logger(this.grandAssaultPlanner.getDebugProgress(context), false);
        }

        this.expansionFactory.maybeCreateMissions(context, missionController, logger);
        this.mcvReserveFactory.maybeCreateMissions(context, missionController, logger);
        this.scoutingFactory.maybeCreateMissions(context, missionController, logger);
        this.engineerFactory.maybeCreateMissions(context, missionController, logger);
        this.harvesterHarassFactory.maybeCreateMissions(context, missionController, logger);

        this.attackFactory.maybeCreateMissions(context, missionController, logger, (wave) =>
            this.selectAttackComposition(context, logger, wave),
        );

        this.defenceFactory.maybeCreateMissions(context, missionController, logger);
        this.baseGuardFactory.maybeCreateMissions(context, missionController, logger);
        this.dogPatrolFactory.maybeCreateMissions(context, missionController, logger);
        this.spyFactory.maybeCreateMissions(context, missionController, logger);

        return this;
    }

    private selectAttackComposition(
        context: SupabotContext,
        logger: DebugLogger,
        wave: AttackWaveKind,
    ): SideComposition | null {
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
        else if (countNavalYards(context.game, playerData) === 0) {
            candidates = candidates.filter((id) => !NAVY_COMPOSITIONS.has(id));
        }
        if (!this.profile.useSpecialists) {
            candidates = candidates.filter((id) => !SPECIALIST_COMPOSITIONS.has(id));
        }

        if (candidates.length === 0) {
            return null;
        }

        if (wave === "harass") {
            const harassPool = candidates.filter((id) => HARASS_COMPOSITIONS.has(id));
            if (harassPool.length > 0) {
                candidates = harassPool;
            }
        } else if (wave === "grand_assault") {
            candidates = candidates.filter((id) => !NAVY_COMPOSITIONS.has(id));
        }

        let chosenId: string;
        if (this.profile.counterCompositions) {
            chosenId = this.selectCounterComposition(context, candidates, logger, wave);
        } else {
            const randomIndex = context.game.generateRandomInt(0, candidates.length - 1);
            chosenId = candidates[randomIndex];
        }

        const base = DEFAULT_COMPOSITIONS[chosenId];
        if (wave === "harass" && this.profile.alternateAttackWaves) {
            logger(`Attack composition (harass): ${chosenId}`);
            return scaleHarassComposition(
                base,
                this.profile.harassWaveUnits ?? 4,
                this.profile.harassWaveMaxUnits ?? 6,
            );
        }

        if (wave === "grand_assault") {
            logger(`Attack composition (grand assault): ${chosenId}`);
            const minWave = SMALL_WAVE_COMPOSITIONS.has(chosenId)
                ? undefined
                : this.profile.minAttackWaveUnits;
            return scaleCompositionCounts(base, this.profile.compositionSizeMultiplier, minWave);
        }

        logger(`Attack composition (assault): ${chosenId} (from ${candidates.join(", ")})`);
        const minWave =
            this.profile.batchAttacks && !SMALL_WAVE_COMPOSITIONS.has(chosenId)
                ? this.profile.minAttackWaveUnits
                : undefined;
        const scaled = scaleCompositionCounts(base, this.profile.compositionSizeMultiplier, minWave);
        if (this.profile.batchAttacks) {
            const launchFloor = scaled.minimumUnits;
            const assaultCap =
                launchFloor + Math.max(2, Math.round((this.profile.minAttackWaveUnits ?? 4) * 0.75));
            return {
                ...scaled,
                maximumUnits: Math.min(scaled.maximumUnits, assaultCap),
            };
        }
        return scaled;
    }

    /**
     * Weight compositions by observed enemy threat: air-heavy → AA / rocketeers;
     * ground-heavy → tanks / artillery; weak AA → air assault; navy when enabled & available.
     */
    private selectCounterComposition(
        context: SupabotContext,
        candidates: string[],
        logger: DebugLogger,
        wave: AttackWaveKind,
    ): string {
        const threat = context.matchAwareness.getThreatCache();
        const preferred = this.rankCompositions(candidates, threat, wave);
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

    private rankCompositions(candidates: string[], threat: GlobalThreat | null, wave: AttackWaveKind): string[] {
        const scored = candidates.map((id) => {
            let score = 1;
            if (wave === "harass") {
                if (HARASS_COMPOSITIONS.has(id)) {
                    score += 5;
                }
                if (id === "conscripts" || id === "gis" || id === "rocketeers") {
                    score += 3;
                }
                if (SPECIALIST_COMPOSITIONS.has(id)) {
                    score += 4;
                }
            }
            if (wave === "grand_assault") {
                if (ANTI_GROUND_COMPOSITIONS.has(id)) {
                    score += 6;
                }
                if (ARTILLERY_COMPOSITIONS.has(id)) {
                    score += 3;
                }
                if (SPECIALIST_COMPOSITIONS.has(id)) {
                    score -= 4;
                }
            }
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
                if (ADVANCED_NAVY_COMPOSITIONS.has(id)) {
                    score += 7;
                }
                if (NAVY_AA_ESCORT_COMPOSITIONS.has(id) && airThreat > groundThreat * 0.65 && airThreat > 35) {
                    score += 6;
                }
                if (NAVY_HEAVY_COMPOSITIONS.has(id) && groundThreat > 40) {
                    score += 5;
                }
                if (id === "alliedNavyDolphins" && enemyAa < 50) {
                    score += 4;
                }
                if (BASIC_NAVY_COMPOSITIONS.has(id) && candidates.some((c) => ADVANCED_NAVY_COMPOSITIONS.has(c))) {
                    score -= 4;
                }
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
