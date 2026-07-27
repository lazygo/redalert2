import { GameApi, OrderType, PlayerData, SideType, Vector2 } from "../../../../game-api";
import { numBuildingsOwnedOfName } from "../../building/buildingRules";
import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { BatchableAction } from "../actionBatcher";
import { Mission, MissionAction, noop, releaseUnits, requestUnitsWithSamePriority } from "../mission";
import { MissionController } from "../missionController";

const PATROL_ORDER_INTERVAL_TICKS = 40;
const DOG_PATROL_FILL_PRIORITY = 26;
const DOG_PATROL_HOLD_PRIORITY = 55;
const MIN_TICKS_BEFORE_PATROLS = 15 * 30;
const PATROL_ROUTE_UNLOCK_INTERVAL_TICKS = 15 * 35;
const MAX_DOG_PATROL_ROUTES = 8;

const KEY_BUILDING_NAMES = [
    "GACNST",
    "NACNST",
    "CACNST",
    "GAWEAP",
    "NAWEAP",
    "CAWEAP",
    "GAPILE",
    "NAHAND",
    "CAHAND",
    "GATECH",
    "NATECH",
    "CATECH",
    "GAREFN",
    "NAREFN",
    "CAREFN",
    "AMRADR",
    "NARADR",
    "CARADR",
];

/** Waypoints around a building — dogs loop this path to sniff out spies. */
const PATROL_RING_OFFSETS = [
    { dx: 5, dy: 0 },
    { dx: 4, dy: 3 },
    { dx: 0, dy: 5 },
    { dx: -4, dy: 3 },
    { dx: -5, dy: 0 },
    { dx: -4, dy: -3 },
    { dx: 0, dy: -5 },
    { dx: 4, dy: -3 },
];

function getDogUnitName(side: SideType): string {
    return side === SideType.Nod ? "DOG" : "ADOG";
}

function getKeyBuildings(game: GameApi, playerData: PlayerData): { id: number; center: Vector2; name: string }[] {
    const results: { id: number; center: Vector2; name: string }[] = [];
    for (const name of KEY_BUILDING_NAMES) {
        if (numBuildingsOwnedOfName(game, playerData, name) <= 0) {
            continue;
        }
        const ids = game.getVisibleUnits(playerData.name, "self", (r) => r.name === name);
        for (const id of ids) {
            const data = game.getUnitData(id);
            if (!data?.tile) {
                continue;
            }
            const foundation = data.foundation;
            const center = new Vector2(
                data.tile.rx + Math.floor(foundation.width / 2),
                data.tile.ry + Math.floor(foundation.height / 2),
            );
            results.push({ id, center, name });
        }
    }
    return results.sort((a, b) => {
        const distA = playerData.startLocation.distanceTo(a.center);
        const distB = playerData.startLocation.distanceTo(b.center);
        return distA - distB;
    });
}

function buildPatrolWaypoints(center: Vector2): Vector2[] {
    return PATROL_RING_OFFSETS.map((offset) => new Vector2(center.x + offset.dx, center.y + offset.dy));
}

/**
 * Keeps an attack dog circling a key structure to detect disguised spies.
 */
export class DogPatrolMission extends Mission {
    private lastOrderTick = -1;
    private waypointIndex = 0;
    private createdAtTick: number;

    constructor(
        uniqueName: string,
        private buildingId: number,
        private waypoints: Vector2[],
        private dogUnitName: string,
        createdAtTick: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
        this.createdAtTick = createdAtTick;
    }

    getBuildingId(): number {
        return this.buildingId;
    }

    getCreatedAtTick(): number {
        return this.createdAtTick;
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        const { game, actionBatcher } = context;
        const tick = game.getCurrentTick();
        const building = game.getGameObjectData(this.buildingId);
        if (!building || building.owner !== context.player.name) {
            return noop();
        }

        // Release combat units that were wrongly grabbed before this fix — they would sit idle forever.
        const wronglyAssigned = this.getUnits(game).filter((unit) => unit.name !== this.dogUnitName);
        if (wronglyAssigned.length > 0) {
            return releaseUnits(wronglyAssigned.map((unit) => unit.id));
        }

        const dogs = this.getUnitsOfTypes(game, this.dogUnitName);
        if (dogs.length === 0) {
            return requestUnitsWithSamePriority([this.dogUnitName], DOG_PATROL_FILL_PRIORITY);
        }

        if (tick < this.lastOrderTick + PATROL_ORDER_INTERVAL_TICKS) {
            return noop();
        }
        this.lastOrderTick = tick;

        const dog = dogs[0];
        const waypoint = this.waypoints[this.waypointIndex];
        actionBatcher.push(BatchableAction.toPoint(dog.id, OrderType.Move, waypoint));

        const dist = new Vector2(dog.tile.rx, dog.tile.ry).distanceTo(waypoint);
        if (dist <= 2.5) {
            this.waypointIndex = (this.waypointIndex + 1) % this.waypoints.length;
        }

        return noop();
    }

    /** Only lock dogs — never trap tanks/infantry in a patrol-only mission. */
    isUnitsLocked(): boolean {
        return false;
    }

    getGlobalDebugText(): string | undefined {
        return `dog-patrol#${this.buildingId}`;
    }

    getPriority() {
        return DOG_PATROL_HOLD_PRIORITY;
    }
}

export class DogPatrolMissionFactory {
    getName(): string {
        return "DogPatrolMissionFactory";
    }

    maybeCreateMissions(context: SupabotContext, missionController: MissionController, logger: DebugLogger): void {
        if (!context.botProfile?.fortifyBase) {
            return;
        }

        const { game } = context;
        const tick = game.getCurrentTick();
        if (tick < MIN_TICKS_BEFORE_PATROLS) {
            return;
        }

        const playerData = game.getPlayerData(context.player.name);
        const side = playerData.country?.side;
        if (side === undefined || !hasBarracks(game, context.player.name)) {
            return;
        }

        const dogUnitName = getDogUnitName(side);
        const existing = missionController
            .getMissions()
            .filter((m): m is DogPatrolMission => m instanceof DogPatrolMission);
        if (existing.length >= MAX_DOG_PATROL_ROUTES) {
            return;
        }

        const coveredBuildingIds = new Set(existing.map((m) => m.getBuildingId()));
        const candidates = getKeyBuildings(game, playerData).filter((b) => !coveredBuildingIds.has(b.id));
        if (candidates.length === 0) {
            return;
        }

        if (existing.length > 0) {
            const last = existing.reduce((a, b) => (a.getCreatedAtTick() > b.getCreatedAtTick() ? a : b));
            if (tick < last.getCreatedAtTick() + PATROL_ROUTE_UNLOCK_INTERVAL_TICKS) {
                return;
            }
        }

        const next = candidates[0];
        const waypoints = buildPatrolWaypoints(next.center);
        const added = missionController.addMission(
            new DogPatrolMission(
                `dog-patrol-${next.name}-${next.id}`,
                next.id,
                waypoints,
                dogUnitName,
                tick,
                logger,
            ),
        );
        if (added) {
            logger(`Dog patrol route around ${next.name} (${next.id})`);
        }
    }
}

function hasBarracks(game: GameApi, playerName: string): boolean {
    const playerData = game.getPlayerData(playerName);
    return (
        numBuildingsOwnedOfName(game, playerData, "GAPILE") > 0 ||
        numBuildingsOwnedOfName(game, playerData, "NAHAND") > 0 ||
        numBuildingsOwnedOfName(game, playerData, "CAHAND") > 0
    );
}
