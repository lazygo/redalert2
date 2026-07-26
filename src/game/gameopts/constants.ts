import { AiDifficulty } from "./GameOpts";
export const RANDOM_COUNTRY_ID = -2;
export const RANDOM_COLOR_ID = -2;
export const RANDOM_START_POS = -2;
export const NO_TEAM_ID = -2;
export const OBS_TEAM_ID = -3;
export const OBS_COUNTRY_ID = -3;
export const OBS_COLOR_ID = -2;
export const RANDOM_COUNTRY_NAME = "Random";
export const OBS_COUNTRY_NAME = "Observer";
export const aiUiNames = new Map<AiDifficulty, string>()
    .set(AiDifficulty.Easy, "GUI:AIDummy")
    .set(AiDifficulty.Normal, "GUI:AISimple")
    .set(AiDifficulty.Hard, "GUI:AINormal")
    .set(AiDifficulty.Brutal, "GUI:AIBrutal")
    .set(AiDifficulty.Custom, "GUI:AICustom");
export const aiUiTooltips = new Map<AiDifficulty, string>()
    .set(AiDifficulty.Easy, "GUI:AIDummy:Tooltip")
    .set(AiDifficulty.Normal, "GUI:AISimple:Tooltip")
    .set(AiDifficulty.Hard, "GUI:AINormal:Tooltip")
    .set(AiDifficulty.Brutal, "GUI:AIBrutal:Tooltip")
    .set(AiDifficulty.Custom, "GUI:AICustom:Tooltip");
export const RANDOM_COUNTRY_UI_NAME = "GUI:RandomEx";
export const RANDOM_COUNTRY_UI_TOOLTIP = "STT:PlayerSideRandom";
export const OBS_COUNTRY_UI_NAME = "GUI:Observer";
export const OBS_COUNTRY_UI_TOOLTIP = "STT:PlayerSideObserver";
export const RANDOM_COLOR_NAME = "";
