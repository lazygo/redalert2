import {
    BuildingPlacementData,
    GameApi,
    ObjectType,
    PlayerData,
    TechnoRules,
    Tile,
    Vector2,
} from "../../../game-api";
import { GlobalThreat } from "../threat/threat";
import { AntiGroundStaticDefence } from "./antiGroundStaticDefence";
import { ArtilleryUnit } from "./artilleryUnit";
import { BasicAirUnit } from "./basicAirUnit";
import { BasicBuilding } from "./basicBuilding";
import { BasicGroundUnit } from "./basicGroundUnit";
import { PowerPlant, NuclearReactor } from "./powerPlant";
import { ResourceCollectionBuilding } from "./resourceCollectionBuilding";
import { Harvester } from "./harvester";
import { uniqBy } from "../common/utils";
import { AntiAirStaticDefence } from "./antiAirStaticDefence";
import { NavalYardBuilding } from "./navalYardBuilding";
import { RepairDepotBuilding } from "./repairDepot";
import { computeAdjacentRect, getAdjacentTiles } from "../common/tileUtils";

export interface AiBuildingRules {
    getPriority(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number;

    getPlacementLocation(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
    ): { rx: number; ry: number } | undefined;

    getMaxCount(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number | null;
}

export function numBuildingsOwnedOfType(game: GameApi, playerData: PlayerData, technoRules: TechnoRules): number {
    return game.getVisibleUnits(playerData.name, "self", (r) => r == technoRules).length;
}

export function numBuildingsOwnedOfName(game: GameApi, playerData: PlayerData, name: string): number {
    return game.getVisibleUnits(playerData.name, "self", (r) => r.name === name).length;
}

export function getAdjacencyTiles(
    game: GameApi,
    playerData: PlayerData,
    technoRules: TechnoRules,
    onWater: boolean,
    minimumSpace: number,
): Tile[] {
    const placementRules = game.getBuildingPlacementData(technoRules.name);
    const { width: newBuildingWidth, height: newBuildingHeight } = placementRules.foundation;
    const tiles = [];
    const buildings = game.getVisibleUnits(playerData.name, "self", (r: TechnoRules) => r.type === ObjectType.Building);
    const removedTiles = new Set<string>();
    for (let buildingId of buildings) {
        const building = game.getUnitData(buildingId);
        if (!building?.rules?.baseNormal) {
            // This building is not considered for adjacency checks.
            continue;
        }
        const { foundation, tile } = building;
        const buildingBase = new Vector2(tile.rx, tile.ry);
        const buildingSize = {
            width: foundation?.width,
            height: foundation?.height,
        };
        const range = computeAdjacentRect(buildingBase, buildingSize, technoRules.adjacent, placementRules.foundation);
        const adjacentTiles = getAdjacentTiles(game, range, onWater);
        if (adjacentTiles.length === 0) {
            continue;
        }
        tiles.push(...adjacentTiles);

        // Prevent placing the new building on tiles that would cause it to overlap with this building.
        const modifiedBase = new Vector2(
            buildingBase.x - (newBuildingWidth - 1),
            buildingBase.y - (newBuildingHeight - 1),
        );
        const modifiedSize = {
            width: buildingSize.width + (newBuildingWidth - 1),
            height: buildingSize.height + (newBuildingHeight - 1),
        };
        const blockedRect = computeAdjacentRect(modifiedBase, modifiedSize, minimumSpace);
        const buildingTiles = adjacentTiles.filter((tile) => {
            return (
                tile.rx >= blockedRect.x &&
                tile.rx < blockedRect.x + blockedRect.width &&
                tile.ry >= blockedRect.y &&
                tile.ry < blockedRect.y + blockedRect.height
            );
        });
        buildingTiles.forEach((buildingTile) => removedTiles.add(buildingTile.id));
    }
    // Remove duplicate tiles.
    const withDuplicatesRemoved = uniqBy(tiles, (tile) => tile.id);
    // Remove tiles containing buildings and potentially area around them removed as well.
    return withDuplicatesRemoved.filter((tile) => !removedTiles.has(tile.id));
}

// function getTileDistances(startPoint: Vector2, tiles: Tile[]) {
//     return tiles
//         .map((tile) => ({
//             tile,
//             distance: distance(tile.rx, tile.ry, startPoint.x, startPoint.y),
//         }))
//         .sort((a, b) => {
//             return a.distance - b.distance;
//         });
// }

/** Squared Euclidean distance — avoids GameMath.sqrt Newton loops on hot AI paths. */
function distanceSq(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x1 - x2;
    const dy = y1 - y2;
    return dx * dx + dy * dy;
}

export function getDefaultPlacementLocation(
    game: GameApi,
    playerData: PlayerData,
    idealPoint: Vector2,
    technoRules: TechnoRules,
    onWater: boolean = false,
    minSpace: number = 2,
): { rx: number; ry: number } | undefined {
    // Closest possible location near `startPoint`.
    const size: BuildingPlacementData = game.getBuildingPlacementData(technoRules.name) as any;
    if (!size) {
        return undefined;
    }
    const tiles = getAdjacencyTiles(game, playerData, technoRules, onWater, minSpace);
    if (tiles.length === 0) {
        return undefined;
    }

    // Score tiles: prefer close to ideal point but penalize crowding near many buildings.
    // This encourages a more spread-out base layout with room for unit movement.
    const buildings = game.getVisibleUnits(playerData.name, "self", (r: TechnoRules) => r.type === ObjectType.Building) as any;
    const buildingPositions: { x: number; y: number }[] = [];
    for (const bid of buildings) {
        const bd = game.getGameObjectData(bid);
        if (bd?.tile) {
            buildingPositions.push({ x: bd.tile.rx, y: bd.tile.ry });
        }
    }

    // Crowding radius 4 → compare against 16 in squared space; weight keeps relative order.
    const CROWD_RADIUS_SQ = 16;
    const scored = tiles.map((tile) => {
        const distToIdealSq = distanceSq(tile.rx, tile.ry, idealPoint.x, idealPoint.y);
        let crowding = 0;
        for (const bp of buildingPositions) {
            const dSq = distanceSq(tile.rx, tile.ry, bp.x, bp.y);
            if (dSq < CROWD_RADIUS_SQ) {
                crowding += CROWD_RADIUS_SQ - dSq;
            }
        }
        const score = distToIdealSq + crowding * 0.8;
        return { tile, score };
    });
    scored.sort((a, b) => a.score - b.score);

    for (const entry of scored) {
        if (entry.tile && game.canPlaceBuilding(playerData.name, technoRules.name, entry.tile)) {
            return entry.tile;
        }
    }
    return undefined;
}

// Priority 0 = don't build.
export type TechnoRulesWithPriority = { unit: TechnoRules; priority: number };

export const DEFAULT_BUILDING_PRIORITY = 0;

export const BUILDING_NAME_TO_RULES = new Map<string, AiBuildingRules>([
    // Allied
    ["GAPOWR", new PowerPlant()],
    ["GAREFN", new ResourceCollectionBuilding(10, 3)], // Refinery
    ["GAWEAP", new BasicBuilding(15, 3)], // War Factory
    ["GAPILE", new BasicBuilding(12, 1)], // Barracks
    ["CMIN", new Harvester(15, 4, 2)], // Chrono Miner
    ["GADEPT", new RepairDepotBuilding()], // Repair Depot — unlocks MCV
    ["GAAIRC", new BasicBuilding(12, 2, 400)], // Airforce Command
    ["AMRADR", new BasicBuilding(12, 2, 400)], // Airforce Command (USA)

    ["GATECH", new BasicBuilding(22, 1, 2800)], // Allied Battle Lab
    ["GAYARD", new NavalYardBuilding(8)], // Naval Yard
    ["GASPYSAT", new BasicBuilding(16, 1, 2000)], // Spy Satellite Uplink
    ["GAGAP", new BasicBuilding(14, 2, 1500)], // 裂缝产生器 (Gap Generator)

    ["GAPILL", new AntiGroundStaticDefence(3, 2, 7.5, 8)], // Pillbox
    ["ATESLA", new AntiGroundStaticDefence(4, 2, 10, 6)], // Prism Cannon
    ["NASAM", new AntiAirStaticDefence(2, 2, 7.5)], // Patriot Missile
    ["GAWALL", new AntiGroundStaticDefence(0, 0, 0, 0)], // Walls

    ["E1", new BasicGroundUnit(2, 2, 0.2, 0)], // GI
    ["ENGINEER", new BasicGroundUnit(1, 0, 0)], // Engineer
    ["SPY", new BasicGroundUnit(6, 2, 0, 0)], // Spy — Savage/Allied infiltration
    ["ADOG", new BasicGroundUnit(1, 1, 0, 0)], // Allied Attack Dog
    ["SNIPE", new BasicGroundUnit(5, 1, 1.5, 0)], // Sniper (Britain)
    ["TANY", new BasicGroundUnit(8, 1, 3, 0)], // Tanya
    ["GHOST", new BasicGroundUnit(6, 1, 2, 0)], // SEAL
    ["MTNK", new BasicGroundUnit(10, 3, 2, 0)], // Grizzly Tank
    ["MGTK", new BasicGroundUnit(10, 1, 2.5, 0)], // Mirage Tank
    ["FV", new BasicGroundUnit(5, 2, 0.5, 1)], // IFV
    ["JUMPJET", new BasicAirUnit(10, 1, 1, 1)], // Rocketeer
    ["ORCA", new BasicAirUnit(8, 2, 2, 0)], // Harrier
    ["BEAG", new BasicAirUnit(8, 2, 2.5, 0)], // Black Eagle (Korea)
    ["SREF", new ArtilleryUnit(10, 5, 3, 3)], // Prism Tank
    ["CLEG", new BasicGroundUnit(0, 0)], // Chrono Legionnaire (Disabled - we don't handle the warped out phase properly and it tends to bug both bots out)
    ["SHAD", new BasicGroundUnit(0, 0)], // Nighthawk (Disabled — transport, not attack)

    // Soviet
    ["NAPOWR", new PowerPlant()],
    ["NAREFN", new ResourceCollectionBuilding(10, 3)], // Refinery
    ["NAWEAP", new BasicBuilding(15, 3)], // War Factory
    ["NAHAND", new BasicBuilding(12, 1)], // Barracks
    ["HARV", new Harvester(15, 4, 2)], // War Miner
    ["NADEPT", new RepairDepotBuilding()], // Repair Depot — unlocks MCV
    ["NARADR", new BasicBuilding(12, 1, 400)], // Radar
    ["NANRCT", new NuclearReactor()], // Nuclear Reactor
    ["NAYARD", new NavalYardBuilding(8)], // Naval Yard

    ["NATECH", new BasicBuilding(22, 1, 2800)], // Soviet Battle Lab
    ["NAPSIS", new BasicBuilding(14, 1, 1500)], // Psychic Sensor (gap / detection)

    ["NALASR", new AntiGroundStaticDefence(3, 2, 7.5, 8)], // Sentry Gun
    ["NAFLAK", new AntiAirStaticDefence(2, 2, 7.5)], // Flak Cannon
    ["TESLA", new AntiGroundStaticDefence(4, 2, 10, 6)], // Tesla Coil
    ["NAWALL", new AntiGroundStaticDefence(0, 0, 0, 0)], // Walls

    ["E2", new BasicGroundUnit(2, 2, 0.2, 0)], // Conscript
    ["SENGINEER", new BasicGroundUnit(1, 0, 0)], // Soviet Engineer
    ["FLAKT", new BasicGroundUnit(2, 2, 0.1, 0.3)], // Flak Trooper
    ["YURI", new BasicGroundUnit(7, 1, 2, 0)], // Yuri
    ["IVAN", new BasicGroundUnit(5, 1, 1.5, 0)], // Crazy Ivan
    ["DESO", new BasicGroundUnit(6, 1, 2, 0)], // Desolator (Libya)
    ["DOG", new BasicGroundUnit(1, 1, 0, 0)], // Soviet Attack Dog
    ["HTNK", new BasicGroundUnit(10, 3, 3, 0)], // Rhino Tank
    ["APOC", new BasicGroundUnit(6, 1, 5, 0)], // Apocalypse Tank
    ["HTK", new BasicGroundUnit(5, 2, 0.33, 1.5)], // Flak Track
    ["ZEP", new BasicAirUnit(8, 2, 5, 1)], // Kirov
    ["V3", new ArtilleryUnit(10, 10, 0, 4)], // V3 Rocket Launcher

    // China (Confederation / CMCV→CACNST) — without these, AI priority stays 0 and freezes after deploy.
    ["CAPOWR", new PowerPlant()],
    ["CAREFN", new ResourceCollectionBuilding(10, 3)],
    ["CAWEAP", new BasicBuilding(15, 3)],
    ["CAHAND", new BasicBuilding(12, 1)],
    ["CHAR", new Harvester(15, 4, 2)],
    ["CADEPT", new RepairDepotBuilding()],
    ["CARADR", new BasicBuilding(12, 2, 400)],
    ["CANRCT", new NuclearReactor()],
    ["CAYARD", new NavalYardBuilding(8)],
    ["CATECH", new BasicBuilding(22, 1, 2800)],
    ["CASPYSAT", new BasicBuilding(16, 1, 2000)],
    ["CAWALL", new AntiGroundStaticDefence(0, 0, 0, 0)],
    ["CAPILL", new AntiGroundStaticDefence(3, 2, 7.5, 8)],
    ["CTESLA", new AntiGroundStaticDefence(4, 2, 10, 6)],
    ["MSAM", new AntiAirStaticDefence(2, 2, 7.5)],
    // China combat units (CAHAND / CAWEAP / CATECH tree — NOT Soviet NA* units).
    ["PLA", new BasicGroundUnit(2, 2, 0.2, 0)],
    ["LTNK", new BasicGroundUnit(10, 3, 2, 0)],
    ["BGGY", new BasicGroundUnit(5, 2, 0.5, 1)],
    ["HOWI", new BasicGroundUnit(6, 1, 5, 0)], // China Apocalypse
    ["V32", new ArtilleryUnit(10, 10, 0, 4)], // China V3
    ["SEEK", new BasicGroundUnit(6, 1, 2, 0.5)],
    ["J10", new BasicAirUnit(8, 2, 2.5, 0)], // China Black Eagle
    ["HOVI", new BasicGroundUnit(0, 0)], // Chrono-style — disabled like CLEG
    ["SUB2", new BasicGroundUnit(6, 2, 2, 0)],
    ["DEST2", new BasicGroundUnit(6, 2, 2, 0)],
    ["MBOAT", new ArtilleryUnit(8, 2, 0, 4)],
    ["CARRIER2", new BasicAirUnit(8, 1, 3, 1)],
    ["CMCV", new BasicGroundUnit(0, 0)], // Mobile construction — produced via McvReserve, not attack
]);
