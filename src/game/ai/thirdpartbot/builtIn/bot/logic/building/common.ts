import { GameApi, GameMath, PlayerData, TechnoRules, Vector2 } from "../../../game-api";
import { getPointTowardsOtherPoint } from "../map/map";
import { getDefaultPlacementLocation } from "./buildingRules";

/**
 * Place static defences in a ring around the base core (and key economy buildings),
 * with a bias toward the enemy — better coverage than a single front arc.
 */
export const getSavageStaticDefencePlacement = (
    game: GameApi,
    playerData: PlayerData,
    technoRules: TechnoRules,
): { rx: number; ry: number } | undefined => {
    const candidates: Vector2[] = [];
    const { startLocation, name: currentName } = playerData;

    const ringAngles = 12;
    for (let i = 0; i < ringAngles; i++) {
        const angle = (i / ringAngles) * Math.PI * 2 + game.generateRandom() * 0.25;
        const dist = 4 + Math.floor(game.generateRandom() * 5);
        candidates.push(
            new Vector2(
                Math.round(startLocation.x + GameMath.cos(angle) * dist),
                Math.round(startLocation.y + GameMath.sin(angle) * dist),
            ),
        );
    }

    const keyBuildingIds = game.getVisibleUnits(
        playerData.name,
        "self",
        (r) =>
            !!r.constructionYard ||
            r.name === "GAREF" ||
            r.name === "NAREF" ||
            r.name === "GAPOWR" ||
            r.name === "NAPOWR" ||
            r.name === "CAPOWR" ||
            r.name === "GAWEAP" ||
            r.name === "NAWEAP" ||
            r.name === "CAWEAP",
    );
    for (const buildingId of keyBuildingIds) {
        const building = game.getGameObjectData(buildingId);
        if (!building?.tile) {
            continue;
        }
        for (let i = 0; i < 4; i++) {
            const angle = (i / 4) * Math.PI * 2 + game.generateRandom() * 0.4;
            const dist = 3 + Math.floor(game.generateRandom() * 3);
            candidates.push(
                new Vector2(
                    Math.round(building.tile.rx + GameMath.cos(angle) * dist),
                    Math.round(building.tile.ry + GameMath.sin(angle) * dist),
                ),
            );
        }
    }

    const enemyDirections = game
        .getPlayers()
        .filter((otherName) => otherName !== currentName && !game.areAlliedPlayers(otherName, currentName))
        .map((otherName) => {
            const enemyPlayer = game.getPlayerData(otherName);
            return getPointTowardsOtherPoint(game, startLocation, enemyPlayer.startLocation, 5, 14, 1.2);
        });
    candidates.push(...enemyDirections);

    for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(game.generateRandom() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    for (const candidate of candidates) {
        const location = getDefaultPlacementLocation(game, playerData, candidate, technoRules, false, 2);
        if (location) {
            return location;
        }
    }

    return getStaticDefencePlacement(game, playerData, technoRules);
};

export const getStaticDefencePlacement = (game: GameApi, playerData: PlayerData, technoRules: TechnoRules) => {
    // Prefer front towards enemy.
    const { startLocation, name: currentName } = playerData;
    const allNames = game.getPlayers();
    // Create a list of positions that point roughly towards hostile player start locatoins.
    const candidates = allNames
        .filter((otherName) => otherName !== currentName && !game.areAlliedPlayers(otherName, currentName))
        .map((otherName) => {
            const enemyPlayer = game.getPlayerData(otherName);
            return getPointTowardsOtherPoint(game, startLocation, enemyPlayer.startLocation, 4, 16, 1.5);
        });
    if (candidates.length === 0) {
        return undefined;
    }
    const selectedLocation = candidates[Math.floor(game.generateRandom() * candidates.length)];
    return getDefaultPlacementLocation(game, playerData, selectedLocation, technoRules, false, 2);
};
