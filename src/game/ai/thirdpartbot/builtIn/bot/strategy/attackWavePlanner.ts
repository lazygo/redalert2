import { SupabotContext } from "../logic/common/context";

/** Attack wave style — harassment probes vs main assault pushes. */
export type AttackWaveKind = "harass" | "assault";

/**
 * Picks harass vs assault with weighted randomness and situational bias.
 * Not a strict alternation — streaks and context shift the odds.
 */
export class AttackWavePlanner {
    private harassStreak = 0;
    private assaultStreak = 0;
    private lastWave: AttackWaveKind | null = null;

    recordLaunch(wave: AttackWaveKind): void {
        if (wave === "harass") {
            this.harassStreak++;
            this.assaultStreak = 0;
        } else {
            this.assaultStreak++;
            this.harassStreak = 0;
        }
        this.lastWave = wave;
    }

    chooseWave(context: SupabotContext): AttackWaveKind {
        const { game, player, matchAwareness } = context;
        const playerData = game.getPlayerData(player.name);

        let harassScore = 1;
        let assaultScore = 1.1;

        // Discourage long runs of the same wave type (soft, not a hard rule).
        if (this.harassStreak >= 2) {
            harassScore *= 0.4;
        }
        if (this.assaultStreak >= 2) {
            assaultScore *= 0.4;
        }
        if (this.harassStreak >= 3) {
            harassScore *= 0.15;
        }
        if (this.assaultStreak >= 3) {
            assaultScore *= 0.15;
        }

        // Nudge toward variety after the last wave — probabilistic, not alternating.
        if (this.lastWave === "assault") {
            harassScore += 0.3 + game.generateRandom() * 0.25;
        } else if (this.lastWave === "harass") {
            assaultScore += 0.25 + game.generateRandom() * 0.25;
        }

        const combatantCount = game.getVisibleUnits(
            player.name,
            "self",
            (r) => !!(r as { isSelectableCombatant?: boolean }).isSelectableCombatant,
        ).length;
        if (combatantCount >= 18) {
            assaultScore += 0.55;
        } else if (combatantCount >= 12) {
            assaultScore += 0.3;
        } else if (combatantCount <= 6) {
            harassScore += 0.5;
        }

        if (playerData.credits >= 10000) {
            assaultScore += 0.35;
        } else if (playerData.credits < 2500) {
            harassScore += 0.25;
        }

        const threat = matchAwareness.getThreatCache();
        if (threat) {
            if (threat.totalOffensiveLandThreat > 70) {
                harassScore += 0.3;
            }
            if (threat.totalOffensiveLandThreat < 35) {
                assaultScore += 0.25;
            }
        }

        // Random spice — sometimes favour one style for this cycle.
        const spice = game.generateRandom();
        if (spice < 0.15) {
            harassScore *= 1.4;
        } else if (spice > 0.85) {
            assaultScore *= 1.4;
        }

        harassScore += game.generateRandom() * 0.45;
        assaultScore += game.generateRandom() * 0.45;

        const total = harassScore + assaultScore;
        return game.generateRandom() * total < harassScore ? "harass" : "assault";
    }
}
