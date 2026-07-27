import { OrderType, SideType, UnitData, Vector2 } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger, isOwnedByNeutral } from "../../common/utils";
import { BatchableAction } from "../actionBatcher";
import { Mission, MissionAction, grabCombatants, noop, requestUnitsWithSamePriority } from "../mission";
import { MissionController } from "../missionController";
import { getAttackWeight, manageAttackMicro, manageMoveMicro } from "./squads/common";

const GUARD_ORDER_INTERVAL_TICKS = 45;
const ENEMY_SCAN_RADIUS = 14;
const GRAB_RADIUS = 11;
const BASE_GUARD_PRIORITY = 52;

/** Per-side garrison quotas for one guard post. */
function getGuardComposition(side: SideType): Record<string, number> {
    switch (side) {
        case SideType.Nod:
            return { E2: 2, DOG: 1, HTNK: 1 };
        case SideType.GDI:
        default:
            return { E1: 2, ADOG: 1, MTNK: 1 };
    }
}

/**
 * Permanent base garrison — keeps infantry, dogs and tanks near a guard post.
 * Unlike reactive DefenceMission, units are never released when the map is quiet.
 */
export class BaseGuardMission extends Mission {
    private lastOrderTick = -1;

    constructor(
        uniqueName: string,
        private guardPoint: Vector2,
        private composition: Record<string, number>,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        const { game, actionBatcher } = context;
        const tick = game.getCurrentTick();

        const missing = this.getMissingUnits(game, this.composition);
        if (missing.length > 0) {
            return requestUnitsWithSamePriority(
                missing.map(([unitName]) => unitName),
                BASE_GUARD_PRIORITY,
            );
        }

        const grabAction = grabCombatants(this.guardPoint, GRAB_RADIUS);

        if (this.getUnitIds().length === 0) {
            return grabAction;
        }

        if (tick < this.lastOrderTick + GUARD_ORDER_INTERVAL_TICKS) {
            return grabAction;
        }
        this.lastOrderTick = tick;

        const units = this.getUnits(game);
        const hostiles = context.matchAwareness
            .getHostilesNearPoint2d(this.guardPoint, ENEMY_SCAN_RADIUS)
            .map(({ unitId }) => game.getUnitData(unitId))
            .filter((unit): unit is UnitData => !!unit && !isOwnedByNeutral(unit));

        if (hostiles.length > 0) {
            for (const unit of units) {
                let bestTarget: UnitData | undefined;
                let bestWeight = -Infinity;
                for (const hostile of hostiles) {
                    const weight = getAttackWeight(unit, hostile);
                    if (weight > bestWeight) {
                        bestWeight = weight;
                        bestTarget = hostile;
                    }
                }
                if (bestTarget) {
                    actionBatcher.push(manageAttackMicro(unit, bestTarget));
                }
            }
        } else {
            for (const unit of units) {
                actionBatcher.push(BatchableAction.toPoint(unit.id, OrderType.GuardArea, this.guardPoint));
            }
        }

        return grabAction;
    }

    getGlobalDebugText(): string | undefined {
        return `guard@${this.guardPoint.x},${this.guardPoint.y}`;
    }

    getPriority() {
        return BASE_GUARD_PRIORITY;
    }
}

const GUARD_POST_OFFSETS = [
    { dx: 0, dy: -8, label: "n" },
    { dx: 8, dy: 0, label: "e" },
    { dx: 0, dy: 8, label: "s" },
    { dx: -8, dy: 0, label: "w" },
    { dx: 6, dy: -6, label: "ne" },
    { dx: -6, dy: -6, label: "nw" },
];

export class BaseGuardMissionFactory {
    private initialized = false;

    getName(): string {
        return "BaseGuardMissionFactory";
    }

    maybeCreateMissions(context: SupabotContext, missionController: MissionController, logger: DebugLogger): void {
        if (!context.botProfile?.fortifyBase) {
            return;
        }
        if (this.initialized) {
            return;
        }

        const { game } = context;
        const playerData = game.getPlayerData(context.player.name);
        const side = playerData.country?.side;
        if (side === undefined) {
            return;
        }

        const composition = getGuardComposition(side);
        const start = playerData.startLocation;

        for (const offset of GUARD_POST_OFFSETS) {
            const guardPoint = new Vector2(start.x + offset.dx, start.y + offset.dy);
            missionController.addMission(
                new BaseGuardMission(`base-guard-${offset.label}`, guardPoint, composition, logger),
            );
        }

        this.initialized = true;
        logger("Created permanent base guard posts for Savage AI");
    }
}
