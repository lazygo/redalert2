import { GameApi, PlayerData, TechnoRules } from "../../../game-api";
import { AiBuildingRules, getDefaultPlacementLocation } from "./buildingRules";
import { GlobalThreat } from "../threat/threat";

const BASIC_POWER_PLANT_NAMES = ["GAPOWR", "NAPOWR", "CAPOWR"];

function countBasicPowerPlants(game: GameApi, playerData: PlayerData): number {
    return game.getVisibleUnits(
        playerData.name,
        "self",
        (r) => BASIC_POWER_PLANT_NAMES.includes(r.name),
    ).length;
}

export class PowerPlant implements AiBuildingRules {
    getPlacementLocation(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
    ): { rx: number; ry: number } | undefined {
        return getDefaultPlacementLocation(game, playerData, playerData.startLocation, technoRules, false, 2);
    }

    getPriority(game: GameApi, playerData: PlayerData, technoRules: TechnoRules): number {
        if (playerData.power.total < playerData.power.drain) {
            return 100;
        } else if (playerData.power.total < playerData.power.drain + technoRules.power / 2) {
            return 20;
        } else {
            return 0;
        }
    }

    getMaxCount(
        _game: GameApi,
        _playerData: PlayerData,
        _technoRules: TechnoRules,
        _threatCache: GlobalThreat | null,
    ): number | null {
        return null;
    }
}

/**
 * Nuclear reactors are slow/expensive — never thrash with basic plants for
 * emergency power. Only compete once a couple of basic plants already exist.
 */
export class NuclearReactor implements AiBuildingRules {
    private readonly placement = new PowerPlant();

    getPlacementLocation(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
    ): { rx: number; ry: number } | undefined {
        return this.placement.getPlacementLocation(game, playerData, technoRules);
    }

    getPriority(game: GameApi, playerData: PlayerData, technoRules: TechnoRules): number {
        const basicOwned = countBasicPowerPlants(game, playerData);
        // Let basic plants handle blackouts / early buffer.
        if (basicOwned < 2) {
            return 0;
        }

        if (playerData.power.total < playerData.power.drain) {
            // Still well below basic emergency (100) so NAPOWR/GAPOWR win mid-build.
            return 40;
        }
        if (playerData.power.total < playerData.power.drain + technoRules.power / 2) {
            return 15;
        }
        return 0;
    }

    getMaxCount(
        _game: GameApi,
        _playerData: PlayerData,
        _technoRules: TechnoRules,
        _threatCache: GlobalThreat | null,
    ): number | null {
        return null;
    }
}
