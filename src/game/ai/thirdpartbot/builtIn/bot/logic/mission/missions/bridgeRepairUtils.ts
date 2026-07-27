import { UnitData, Vector2 } from "../../../../game-api";
import { MatchAwareness } from "../../awareness";
import { SectorCache } from "../../map/sector";
import { MissionController } from "../missionController";
import { AttackMission, AttackMissionState } from "./attackMission";
import { SupabotContext } from "../../common/context";

export const BRIDGE_REPAIR_PRIORITY = 105;
export const BRIDGE_REPAIR_ATTACK_PATH_PRIORITY = 118;
/** Score at or above this → treat hut as blocking an active attack route. */
export const ATTACK_PATH_BRIDGE_SCORE_THRESHOLD = 45;

const PATH_DETOUR_FACTOR = 1.4;

export function getActiveAttackRoutePoints(
    context: SupabotContext,
    missionController: MissionController,
): Vector2[] {
    return missionController
        .getMissions()
        .filter((m): m is AttackMission => m instanceof AttackMission)
        .filter((m) => {
            const state = m.getState();
            return state === AttackMissionState.Attacking || state === AttackMissionState.Preparing;
        })
        .map((m) => m.getAttackArea());
}

export function hasActiveAttackMissions(context: SupabotContext, missionController: MissionController): boolean {
    return getActiveAttackRoutePoints(context, missionController).length > 0;
}

/** True when units are actively fighting — excludes grand-assault hoarding at the rally. */
export function hasLaunchedAttackMissions(
    _context: SupabotContext,
    missionController: MissionController,
): boolean {
    return missionController
        .getMissions()
        .filter((m): m is AttackMission => m instanceof AttackMission)
        .some((m) => m.getState() === AttackMissionState.Attacking);
}

function areSectorsConnected(
    sectorCache: SectorCache,
    from: Vector2,
    to: Vector2,
): boolean | null {
    const fromCell = sectorCache.getCell(from.x, from.y);
    const toCell = sectorCache.getCell(to.x, to.y);
    if (!fromCell?.value || !toCell?.value) {
        return null;
    }
    if (fromCell.value.id === toCell.value.id) {
        return true;
    }
    return fromCell.value.connectedSectorIds.includes(toCell.value.id);
}

/**
 * Higher score = bridge hut is more likely blocking an active attack path.
 */
export function scoreBridgeHutForAttackRoute(
    hut: UnitData,
    rallyPoint: Vector2,
    attackPoints: Vector2[],
    sectorCache: SectorCache,
): number {
    if (!hut.tile) {
        return 0;
    }
    const hutPoint = new Vector2(hut.tile.rx, hut.tile.ry);
    let score = 0;

    for (const attackPoint of attackPoints) {
        const rallyToAttack = rallyPoint.distanceTo(attackPoint);
        const rallyToHut = rallyPoint.distanceTo(hutPoint);
        const hutToAttack = hutPoint.distanceTo(attackPoint);

        if (rallyToHut + hutToAttack <= rallyToAttack * PATH_DETOUR_FACTOR) {
            score += 55;
        }

        score += Math.max(0, 35 - hutToAttack * 0.9);

        const connected = areSectorsConnected(sectorCache, rallyPoint, attackPoint);
        if (connected === false) {
            score += 40;
            if (rallyToHut + hutToAttack <= rallyToAttack * 1.6) {
                score += 25;
            }
        }
    }

    return score;
}

export function isBridgeHutOnAttackRoute(
    hut: UnitData,
    context: SupabotContext,
    missionController: MissionController,
): boolean {
    const attackPoints = getActiveAttackRoutePoints(context, missionController);
    if (attackPoints.length === 0) {
        return false;
    }
    return (
        scoreBridgeHutForAttackRoute(
            hut,
            context.matchAwareness.getMainRallyPoint(),
            attackPoints,
            context.matchAwareness.getSectorCache(),
        ) >= ATTACK_PATH_BRIDGE_SCORE_THRESHOLD
    );
}

export function getBridgeRepairPriorityForHut(
    hut: UnitData,
    context: SupabotContext,
    missionController: MissionController,
): number {
    if (isBridgeHutOnAttackRoute(hut, context, missionController)) {
        return BRIDGE_REPAIR_ATTACK_PATH_PRIORITY;
    }
    return BRIDGE_REPAIR_PRIORITY;
}
