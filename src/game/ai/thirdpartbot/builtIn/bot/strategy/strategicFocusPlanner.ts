import { SupabotContext } from "../logic/common/context";
import { MissionController } from "../logic/mission/missionController";
import { hasActiveAttackMissions } from "../logic/mission/missions/bridgeRepairUtils";
import { countConyards, countMobileMcvs } from "../logic/mission/missions/mcvReserveMission";

/** ~45s expand window at 15 tps */
const EXPAND_WINDOW_TICKS = 15 * 45;
const MIN_ARMY_FOR_EXPAND = 10;
const MIN_CREDITS_FOR_MCV = 5000;
const EXPAND_OPPORTUNITY_CHECK_TICKS = 15 * 40;

/**
 * Rotates between military production / attacks and expansion (MCV, new bases).
 * Prevents the war factory from queueing MCVs non-stop at the expense of combat units.
 */
export class StrategicFocusPlanner {
    private expandWindowEndTick = 0;
    private lastOpportunityCheckTick = 0;
    private hasActiveAttack = false;

    onTick(context: SupabotContext, missionController: MissionController): void {
        this.hasActiveAttack = hasActiveAttackMissions(context, missionController);
        this.maybeOpenExpandOpportunity(context);
    }

    onAttackLaunched(context: SupabotContext): void {
        this.expandWindowEndTick = 0;
    }

    onAttackFinished(context: SupabotContext): void {
        if (this.countCombatants(context) >= MIN_ARMY_FOR_EXPAND && context.game.generateRandom() < 0.4) {
            this.openExpandWindow(context);
        }
    }

    isExpandWindowActive(context: SupabotContext): boolean {
        return context.game.getCurrentTick() < this.expandWindowEndTick;
    }

    shouldInvestInExpansion(context: SupabotContext): boolean {
        if (this.hasActiveAttack) {
            return false;
        }

        const tick = context.game.getCurrentTick();
        const profile = context.botProfile;
        if (profile && tick < profile.expandBeforeTicks * 0.55) {
            return false;
        }

        const combatants = this.countCombatants(context);
        if (combatants < MIN_ARMY_FOR_EXPAND) {
            return false;
        }

        const credits = context.game.getPlayerData(context.player.name).credits;
        if (credits < MIN_CREDITS_FOR_MCV) {
            return false;
        }

        return this.isExpandWindowActive(context);
    }

    shouldPackConyardToExpand(context: SupabotContext): boolean {
        return this.shouldInvestInExpansion(context) && this.isExpandWindowActive(context);
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

    private openExpandWindow(context: SupabotContext): void {
        this.expandWindowEndTick = context.game.getCurrentTick() + EXPAND_WINDOW_TICKS;
    }

    private maybeOpenExpandOpportunity(context: SupabotContext): void {
        if (this.hasActiveAttack || this.isExpandWindowActive(context)) {
            return;
        }

        const tick = context.game.getCurrentTick();
        const profile = context.botProfile;
        if (profile && tick < profile.expandBeforeTicks) {
            return;
        }
        if (tick < this.lastOpportunityCheckTick + EXPAND_OPPORTUNITY_CHECK_TICKS) {
            return;
        }
        this.lastOpportunityCheckTick = tick;

        const combatants = this.countCombatants(context);
        const credits = context.game.getPlayerData(context.player.name).credits;
        const conyards = countConyards(context.game, context.player.name);
        const mobileMcvs = countMobileMcvs(context.game, context.player.name);

        if (
            combatants >= MIN_ARMY_FOR_EXPAND + 2 &&
            credits >= 8000 &&
            conyards <= 2 &&
            mobileMcvs === 0 &&
            context.game.generateRandom() < 0.22
        ) {
            this.openExpandWindow(context);
        }
    }
}
