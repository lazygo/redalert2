import { GameApi, PlayerData, TechnoRules, Vector2 } from "../../../game-api";
import { numBuildingsOwnedOfName } from "./buildingRules";
import type { BotDifficultyProfile } from "../../BotDifficultyProfile";
import { isBrutalOrSavageProfile } from "../../BotDifficultyProfile";

const WALL_NAMES = new Set(["GAWALL", "NAWALL", "CAWALL"]);
/** How many wall segments to aim for around each construction yard. */
const WALLS_PER_CONYARD_TARGET = 12;
const MAX_TOTAL_WALLS = 48;
/** Below power/refinery/barracks so walls never starve the opening build. */
const WALL_FILL_PRIORITY = 8;

const BARRACKS_NAMES = ["GAPILE", "NAHAND", "CAHAND"];
const REFINERY_NAMES = ["GAREFN", "NAREFN", "CAREFN"];

export function isWallStructure(buildingName: string): boolean {
    return WALL_NAMES.has(buildingName);
}

function getConyardIds(game: GameApi, playerName: string): number[] {
    return game.getVisibleUnits(playerName, "self", (r) => !!r.constructionYard);
}

function hasBarracksAndRefinery(game: GameApi, playerData: PlayerData): boolean {
    const barracks = BARRACKS_NAMES.some((n) => numBuildingsOwnedOfName(game, playerData, n) > 0);
    const refinery = REFINERY_NAMES.some((n) => numBuildingsOwnedOfName(game, playerData, n) > 0);
    return barracks && refinery;
}

function getExitDirection(game: GameApi, playerData: PlayerData, conyardTile: { rx: number; ry: number }): Vector2 {
    const exits = game.getVisibleUnits(
        playerData.name,
        "self",
        (r) =>
            !!r.weaponsFactory ||
            r.name === "GAPILE" ||
            r.name === "NAHAND" ||
            r.name === "CAHAND" ||
            !!r.refinery,
    );
    let best: Vector2 | null = null;
    let bestDist = Infinity;
    for (const id of exits) {
        const data = game.getGameObjectData(id);
        if (!data?.tile) {
            continue;
        }
        const dx = data.tile.rx - conyardTile.rx;
        const dy = data.tile.ry - conyardTile.ry;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist > 0 && dist < bestDist) {
            bestDist = dist;
            best = new Vector2(Math.sign(dx), Math.sign(dy));
        }
    }
    return best ?? new Vector2(1, 0);
}

function isInMapBounds(game: GameApi, rx: number, ry: number): boolean {
    try {
        return !!game.mapApi.getTile(rx, ry);
    } catch {
        return false;
    }
}

function safeCanPlace(game: GameApi, playerName: string, buildingName: string, tile: { rx: number; ry: number }): boolean {
    if (!isInMapBounds(game, tile.rx, tile.ry)) {
        return false;
    }
    try {
        return !!game.canPlaceBuilding(playerName, buildingName, tile);
    } catch {
        return false;
    }
}

/**
 * Perimeter cells just outside a conyard foundation, with a gate opening toward
 * factories / barracks so units can leave the compound.
 */
export function collectConyardWallCandidates(
    game: GameApi,
    playerData: PlayerData,
): { rx: number; ry: number }[] {
    const candidates: { rx: number; ry: number; score: number }[] = [];
    const conyardIds = getConyardIds(game, playerData.name);

    for (const id of conyardIds) {
        const data = game.getGameObjectData(id);
        if (!data?.tile) {
            continue;
        }
        const foundation = data.foundation ?? { width: 2, height: 2 };
        const ox = data.tile.rx;
        const oy = data.tile.ry;
        const w = Math.max(1, foundation.width ?? 2);
        const h = Math.max(1, foundation.height ?? 2);
        const exit = getExitDirection(game, playerData, data.tile);

        for (let x = ox - 1; x <= ox + w; x++) {
            for (let y = oy - 1; y <= oy + h; y++) {
                const onPerimeter =
                    x === ox - 1 || x === ox + w || y === oy - 1 || y === oy + h;
                if (!onPerimeter) {
                    continue;
                }
                if (!isInMapBounds(game, x, y)) {
                    continue;
                }
                const cx = ox + (w - 1) / 2;
                const cy = oy + (h - 1) / 2;
                const towardExit =
                    (exit.x !== 0 && Math.sign(x - cx) === exit.x && Math.abs(y - cy) <= 1) ||
                    (exit.y !== 0 && Math.sign(y - cy) === exit.y && Math.abs(x - cx) <= 1);
                if (towardExit) {
                    continue;
                }
                const isCorner =
                    (x === ox - 1 || x === ox + w) && (y === oy - 1 || y === oy + h);
                candidates.push({ rx: x, ry: y, score: isCorner ? 2 : 1 });
            }
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.map(({ rx, ry }) => ({ rx, ry }));
}

export function getWallPlacementAroundConyards(
    game: GameApi,
    playerData: PlayerData,
    technoRules: TechnoRules,
): { rx: number; ry: number } | undefined {
    for (const tile of collectConyardWallCandidates(game, playerData)) {
        if (safeCanPlace(game, playerData.name, technoRules.name, tile)) {
            return tile;
        }
    }
    return undefined;
}

function countOwnedWalls(game: GameApi, playerData: PlayerData): number {
    return (
        numBuildingsOwnedOfName(game, playerData, "GAWALL") +
        numBuildingsOwnedOfName(game, playerData, "NAWALL")
    );
}

/**
 * Priority for walls — Brutal / Savage only.
 * Does NOT call canPlaceBuilding (that was freezing the AI when it threw).
 * Walls wait until barracks + refinery exist so the opening build is never starved.
 */
export function applyWallFortifyPriority(
    buildingName: string,
    basePriority: number,
    game: GameApi,
    playerData: PlayerData,
    profile?: BotDifficultyProfile,
): number {
    if (!isBrutalOrSavageProfile(profile) || !isWallStructure(buildingName)) {
        return basePriority;
    }

    const conyards = getConyardIds(game, playerData.name).length;
    if (conyards === 0) {
        return basePriority;
    }
    if (!hasBarracksAndRefinery(game, playerData)) {
        return basePriority;
    }

    const owned = countOwnedWalls(game, playerData);
    const target = Math.min(MAX_TOTAL_WALLS, conyards * WALLS_PER_CONYARD_TARGET);
    if (owned >= target) {
        return -100;
    }

    const progress = owned / Math.max(1, target);
    const priority = WALL_FILL_PRIORITY * (1.15 - progress);
    return Math.max(basePriority, priority);
}
