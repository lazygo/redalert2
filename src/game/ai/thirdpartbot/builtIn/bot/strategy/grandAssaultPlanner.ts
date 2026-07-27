import { SupabotContext } from "../logic/common/context";
import { countConyards } from "../logic/mission/missions/mcvReserveMission";
import { SideComposition } from "./compositionUtils";

/** Expansion window after factorial threshold is met (~90s — enough to produce+drive MCV). */
const EXPAND_WINDOW_TICKS = 15 * 90;
const MIN_ARMY_FOR_EXPAND = 8;
const MIN_CREDITS_FOR_EXPAND = 5000;

/** Grand-assault production sits below harass / specialists so side missions keep factory access. */
export const GRAND_ASSAULT_FILL_PRIORITY = 28;

function factorial(n: number): number {
    let result = 1;
    for (let i = 2; i <= n; i++) {
        result *= i;
    }
    return result;
}

/**
 * Savage "总攻" pacing: hoard at base, launch a grand push, immediately start the next hoard.
 * Expansion uses factorial gates: at n conyards, launch n! grand assaults before the next base.
 */
export class GrandAssaultPlanner {
    private grandAssaultsSinceLastExpansion = 0;
    private expandWindowEndTick = 0;

    /** Grand assaults required before the next conyard: 1→1!, 2→2!, 3→3!, … */
    attacksRequiredBeforeNextBase(conyardCount: number): number {
        return factorial(Math.max(1, conyardCount));
    }

    onGrandAssaultLaunched(context: SupabotContext): void {
        this.grandAssaultsSinceLastExpansion++;
        const conyards = countConyards(context.game, context.player.name);
        const required = this.attacksRequiredBeforeNextBase(conyards);
        if (this.grandAssaultsSinceLastExpansion >= required) {
            this.expandWindowEndTick = context.game.getCurrentTick() + EXPAND_WINDOW_TICKS;
            this.grandAssaultsSinceLastExpansion = 0;
        }
    }

    onExpansionCommitted(_context: SupabotContext): void {
        this.grandAssaultsSinceLastExpansion = 0;
        this.expandWindowEndTick = 0;
    }

    isExpandWindowActive(context: SupabotContext): boolean {
        return context.game.getCurrentTick() < this.expandWindowEndTick;
    }

    shouldInvestInExpansion(context: SupabotContext): boolean {
        if (!this.isExpandWindowActive(context)) {
            return false;
        }
        const tick = context.game.getCurrentTick();
        const profile = context.botProfile;
        if (profile && tick < profile.expandBeforeTicks * 0.4) {
            return false;
        }
        const combatants = this.countCombatants(context);
        if (combatants < MIN_ARMY_FOR_EXPAND) {
            return false;
        }
        const credits = context.game.getPlayerData(context.player.name).credits;
        return credits >= MIN_CREDITS_FOR_EXPAND;
    }

    shouldPackConyardToExpand(_context: SupabotContext): boolean {
        // Savage expands via factory-built MCV only — packing the CY freezes tech production.
        return false;
    }

    countCombatants(context: SupabotContext): number {
        return context.game
            .getVisibleUnits(
                context.player.name,
                "self",
                (r) => !!(r as { isSelectableCombatant?: boolean }).isSelectableCombatant,
            )
            .length;
    }

    /** Target army size for the next grand assault before launching. */
    getTargetHoardSize(context: SupabotContext, composition: SideComposition): number {
        const conyards = Math.max(1, countConyards(context.game, context.player.name));
        const combatants = this.countCombatants(context);
        const perBase = 6 + (conyards - 1) * 4;
        const fromArmy = Math.floor(combatants * 0.45);
        const target = Math.max(composition.minimumUnits, perBase, fromArmy);
        return Math.min(composition.maximumUnits, target);
    }

    getDebugProgress(context: SupabotContext): string {
        const conyards = countConyards(context.game, context.player.name);
        const required = this.attacksRequiredBeforeNextBase(conyards);
        return `grand:${this.grandAssaultsSinceLastExpansion}/${required} expandWin=${this.isExpandWindowActive(context)}`;
    }
}
