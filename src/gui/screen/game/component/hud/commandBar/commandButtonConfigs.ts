import { CommandBarButtonType } from "./CommandBarButtonType";
export interface CommandButtonConfig {
    type: CommandBarButtonType;
    icon: string;
    tooltip: (e: {
        get: (key: string) => string;
    }) => string;
}
export const commandButtonConfigs: CommandButtonConfig[] = [
    {
        type: CommandBarButtonType.CenterBase,
        icon: "button05.shp",
        tooltip: (e) => e.get("tip:centerbase") || e.get("txt_center_base") || "Center Base",
    },
    {
        type: CommandBarButtonType.NextUnit,
        icon: "button11.shp",
        tooltip: (e) => e.get("tip:nextobject") || e.get("txt_next_object") || "Next Unit",
    },
    {
        type: CommandBarButtonType.Team01,
        icon: "button00.shp",
        tooltip: (e) => e.get("tip:team01"),
    },
    {
        type: CommandBarButtonType.Team02,
        icon: "button01.shp",
        tooltip: (e) => e.get("tip:team02"),
    },
    {
        type: CommandBarButtonType.Team03,
        icon: "button02.shp",
        tooltip: (e) => e.get("tip:team03"),
    },
    {
        type: CommandBarButtonType.TypeSelect,
        icon: "button03.shp",
        tooltip: (e) => e.get("tip:typeselect"),
    },
    {
        type: CommandBarButtonType.Deploy,
        icon: "button04.shp",
        tooltip: (e) => e.get("tip:deploy"),
    },
    {
        type: CommandBarButtonType.Guard,
        icon: "button06.shp",
        tooltip: (e) => e.get("tip:guard"),
    },
    {
        type: CommandBarButtonType.Beacon,
        icon: "button07.shp",
        tooltip: (e) => e.get("tip:beacon"),
    },
    {
        type: CommandBarButtonType.Stop,
        icon: "button08.shp",
        tooltip: (e) => e.get("tip:stop"),
    },
    {
        type: CommandBarButtonType.PlanningMode,
        icon: "button09.shp",
        tooltip: (e) => e.get("tip:planningmode"),
    },
    {
        type: CommandBarButtonType.Cheer,
        icon: "button10.shp",
        tooltip: (e) => e.get("tip:cheer"),
    },
    {
        type: CommandBarButtonType.ReplayRewind,
        icon: "rewind.shp",
        tooltip: (e) => e.get("tip:replayrewind"),
    },
    {
        type: CommandBarButtonType.ReplayPlay,
        icon: "play.shp",
        tooltip: (e) => e.get("tip:play"),
    },
    {
        type: CommandBarButtonType.ReplayPause,
        icon: "pause.shp",
        tooltip: (e) => e.get("tip:pause"),
    },
    {
        type: CommandBarButtonType.ReplaySpeed,
        icon: "ffwd.shp",
        tooltip: (e) => e.get("tip:replayspeed"),
    },
];
