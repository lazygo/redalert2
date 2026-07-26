import { BotContext } from "../../../game-api";
import { MatchAwareness } from "../awareness";
import { ActionBatcher } from "../mission/actionBatcher";
import type { BotDifficultyProfile } from "../../BotDifficultyProfile";

export interface SupabotContext extends BotContext {
    readonly matchAwareness: MatchAwareness;
    /** Present for BuiltInBot so missions can gate navy / advanced tactics. */
    readonly botProfile?: BotDifficultyProfile;
}

export interface MissionContext extends SupabotContext {
    readonly actionBatcher: ActionBatcher;
}
