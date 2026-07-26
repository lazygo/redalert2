export function isHumanPlayerInfo(info: any): boolean {
    return "name" in info;
}
export enum AiDifficulty {
    /** AI-冷酷 — aggressive BuiltInBot. */
    Brutal = 0,
    Medium = 1,
    /** AI-弱智 — training dummy (DummyBot). */
    Easy = 2,
    MediumSea = 3,
    /** AI-简单 — legacy BuiltInBot defaults. */
    Normal = 4,
    Custom = 5,
    /** AI-普通 — enhanced BuiltInBot. */
    Hard = 6,
    /** AI-残暴 — multi-domain counters + spies; harder than Brutal. */
    Savage = 7,
}
export interface HumanPlayerInfo {
    name: string;
    countryId: number;
    colorId: number;
    startPos: number;
    teamId: number;
}
export interface AiPlayerInfo {
    difficulty: AiDifficulty;
    customBotId?: string;
    countryId: number;
    colorId: number;
    startPos: number;
    teamId: number;
}
export interface GameOpts {
    gameMode: number;
    gameSpeed: number;
    credits: number;
    unitCount: number;
    shortGame: boolean;
    superWeapons: boolean;
    buildOffAlly: boolean;
    mcvRepacks: boolean;
    cratesAppear: boolean;
    hostTeams?: boolean;
    destroyableBridges: boolean;
    multiEngineer: boolean;
    noDogEngiKills: boolean;
    mapName: string;
    mapTitle: string;
    mapDigest: string;
    mapSizeBytes: number;
    maxSlots: number;
    mapOfficial: boolean;
    humanPlayers: HumanPlayerInfo[];
    aiPlayers: (AiPlayerInfo | undefined)[];
    unknown?: string;
}
