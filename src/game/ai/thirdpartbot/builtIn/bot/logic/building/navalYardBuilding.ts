import { GameApi, PlayerData, TechnoRules, Tile, Vector2 } from "../../../game-api";
import { GlobalThreat } from "../threat/threat";
import { BasicBuilding } from "./basicBuilding";
import { getDefaultPlacementLocation, numBuildingsOwnedOfName } from "./buildingRules";

const NAVAL_YARD_NAMES = new Set(["GAYARD", "NAYARD", "CAYARD"]);
const ABSOLUTE_MAX_NAVAL_YARDS = 3;

/** Naval yard — placed on water; count scales with coastline capacity, not a fixed cap of 1. */
export class NavalYardBuilding extends BasicBuilding {
    constructor(basePriority: number = 8) {
        super(basePriority, ABSOLUTE_MAX_NAVAL_YARDS);
    }

    override getPlacementLocation(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
    ): { rx: number; ry: number } | undefined {
        for (const anchor of getNavalAnchors(game, playerData)) {
            const location = getDefaultPlacementLocation(game, playerData, anchor, technoRules, true, 1);
            if (location) {
                return location;
            }
        }
        return undefined;
    }

    override getPriority(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        _threatCache: GlobalThreat | null,
    ): number {
        const max = getDesiredNavalYardCount(game, playerData, technoRules);
        const owned = countNavalYards(game, playerData);

        if (max === 0 || owned >= max) {
            return owned >= max && max > 0 ? -100 : 0;
        }
        if (!this.getPlacementLocation(game, playerData, technoRules)) {
            return 0;
        }

        return this.basePriority * (1.0 - owned / max);
    }

    override getMaxCount(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        _threatCache: GlobalThreat | null,
    ): number | null {
        return getDesiredNavalYardCount(game, playerData, technoRules);
    }
}

function getNavalAnchors(game: GameApi, playerData: PlayerData): Vector2[] {
    const anchors = game
        .getVisibleUnits(playerData.name, "self", (r) => r.constructionYard || r.naval)
        .map((id) => game.getGameObjectData(id)?.tile)
        .filter((t): t is Tile => !!t)
        .map((t) => new Vector2(t.rx, t.ry));

    if (anchors.length === 0) {
        const start = playerData.startLocation;
        if (start) {
            anchors.push(new Vector2(start.x, start.y));
        }
    }

    return anchors;
}

/** How many distinct anchor points can each support at least one naval yard placement. */
export function countNavalPlacementCapacity(
    game: GameApi,
    playerData: PlayerData,
    technoRules: TechnoRules,
): number {
    let capacity = 0;
    for (const anchor of getNavalAnchors(game, playerData)) {
        if (getDefaultPlacementLocation(game, playerData, anchor, technoRules, true, 1)) {
            capacity++;
        }
    }
    return capacity;
}

/**
 * Desired naval yard count from map layout and base size — not a hard cap of 1.
 * - 0 when there is no valid water placement
 * - 1 when water is available (minimum for navy)
 * - 2 when the map supports multiple placements (redundancy)
 * - 3 only with 2+ conyards and enough coastline (expansion bases)
 */
export function getDesiredNavalYardCount(
    game: GameApi,
    playerData: PlayerData,
    technoRules: TechnoRules,
): number {
    const capacity = countNavalPlacementCapacity(game, playerData, technoRules);
    if (capacity === 0) {
        return 0;
    }

    const conyardCount = game.getVisibleUnits(playerData.name, "self", (r) => r.constructionYard).length;

    let desired = 1;
    if (capacity >= 2) {
        desired = 2;
    }
    if (capacity >= 3 && conyardCount >= 2) {
        desired = 3;
    }

    return Math.min(desired, capacity, ABSOLUTE_MAX_NAVAL_YARDS);
}

export function countNavalYards(game: GameApi, playerData: PlayerData): number {
    let total = 0;
    for (const name of NAVAL_YARD_NAMES) {
        total += numBuildingsOwnedOfName(game, playerData, name);
    }
    return total;
}

export function isNavalYardName(name: string): boolean {
    return NAVAL_YARD_NAMES.has(name);
}
