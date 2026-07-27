import { SupabotContext } from "../logic/common/context";
import { MissionController } from "../logic/mission/missionController";
import { hasActiveAttackMissions, hasLaunchedAttackMissions } from "../logic/mission/missions/bridgeRepairUtils";
import { countConyards, countMobileMcvs } from "../logic/mission/missions/mcvReserveMission";
import type { GrandAssaultPlanner } from "./grandAssaultPlanner";

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
    private hasLaunchedAttack = false;

    constructor(private grandAssault?: GrandAssaultPlanner) {}

    onTick(context: SupabotContext, missionController: MissionController): void {
        this.hasActiveAttack = hasActiveAttackMissions(context, missionController);
        this.hasLaunchedAttack = hasLaunchedAttackMissions(context, missionController);
        if (!context.botProfile?.grandAssaultMode) {
            this.maybeOpenExpandOpportunity(context);
        }
    }

    onAttackLaunched(context: SupabotContext): void {
        if (context.botProfile?.grandAssaultMode) {
            return;
        }
        this.expandWindowEndTick = 0;
    }

    onAttackFinished(context: SupabotContext): void {
        if (context.botProfile?.grandAssaultMode) {
            return;
        }
        if (this.countCombatants(context) >= MIN_ARMY_FOR_EXPAND && context.game.generateRandom() < 0.4) {
            this.openExpandWindow(context);
        }
    }

    onExpansionCommitted(context: SupabotContext): void {
        this.expandWindowEndTick = 0;
        this.grandAssault?.onExpansionCommitted(context);
    }

    isExpandWindowActive(context: SupabotContext): boolean {
        if (context.botProfile?.grandAssaultMode && this.grandAssault) {
            return this.grandAssault.isExpandWindowActive(context);
        }
        return context.game.getCurrentTick() < this.expandWindowEndTick;
    }

    shouldInvestInExpansion(context: SupabotContext): boolean {
        const combatBlocksExpansion = context.botProfile?.grandAssaultMode
            ? this.hasLaunchedAttack
            : this.hasActiveAttack;
        if (combatBlocksExpansion) {
            return false;
        }

        if (context.botProfile?.grandAssaultMode && this.grandAssault) {
            return this.grandAssault.shouldInvestInExpansion(context);
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
        if (context.botProfile?.grandAssaultMode && this.grandAssault) {
            return this.grandAssault.shouldPackConyardToExpand(context);
        }
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
