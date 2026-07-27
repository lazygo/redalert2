import { GameApi, PlayerData, TechnoRules } from "../../../game-api";
import { GlobalThreat } from "../threat/threat";
import { BasicBuilding } from "./basicBuilding";
import { numBuildingsOwnedOfName, numBuildingsOwnedOfType } from "./buildingRules";

const WAR_FACTORY_NAMES = ["GAWEAP", "NAWEAP"];

function hasWarFactory(game: GameApi, playerData: PlayerData): boolean {
    return WAR_FACTORY_NAMES.some((name) => numBuildingsOwnedOfName(game, playerData, name) > 0);
}

/**
 * Repair depot unlocks MCV production. Build soon after the war factory is up
 * (no 10k-credit gate that delayed this for too long).
 */
export class RepairDepotBuilding extends BasicBuilding {
    constructor() {
        super(10, 1);
    }

    override getPriority(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number {
        const owned = numBuildingsOwnedOfType(game, playerData, technoRules);
        if (owned >= 1) {
            return -100;
        }
        if (!hasWarFactory(game, playerData)) {
            return 0;
        }
        return super.getPriority(game, playerData, technoRules, threatCache);
    }
}
