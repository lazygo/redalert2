import { OrderType, SideType, UnitData, Vector2 } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { numBuildingsOwnedOfName } from "../../building/buildingRules";
import { DebugLogger, isOwnedByNeutral } from "../../common/utils";
import { BatchableAction } from "../actionBatcher";
import { Mission, MissionAction, grabCombatants, noop, requestUnitsWithSamePriority } from "../mission";
import { MissionController } from "../missionController";
import { getAttackWeight, manageAttackMicro } from "./squads/common";

const GUARD_ORDER_INTERVAL_TICKS = 45;
const ENEMY_SCAN_RADIUS = 14;
const GRAB_RADIUS = 11;
/** Retention priority — below assault prep max (54) so forming attack waves keep their units. */
const BASE_GUARD_HOLD_PRIORITY = 48;
/** Production priority — must stay below attack missions so assault/harass waves get units. */
const BASE_GUARD_FILL_PRIORITY = 22;

/** ~25s before the first guard post appears — economy & attacks go first. */
const MIN_TICKS_BEFORE_GUARDS = 15 * 25;
/** ~40s between unlocking additional guard posts. */
const GUARD_POST_UNLOCK_INTERVAL_TICKS = 15 * 40;

const BARRACKS_NAMES = ["GAPILE", "NAHAND", "CAHAND"];
const WAR_FACTORY_NAMES = ["GAWEAP", "NAWEAP", "CAWEAP"];

/** Post index allowed to request barracks/warfactory production this tick (set by factory). */
let designatedFillPostIndex = -1;

/** Per-side full garrison quotas for one guard post. */
function getFullGuardComposition(side: SideType): Record<string, number> {
    switch (side) {
        case SideType.Nod:
            return { E2: 2, DOG: 1, HTNK: 1 };
        case SideType.GDI:
        default:
            return { E1: 2, ADOG: 1, MTNK: 1 };
    }
}

function hasBarracks(context: MissionContext): boolean {
    const playerData = context.game.getPlayerData(context.player.name);
    return BARRACKS_NAMES.some((name) => numBuildingsOwnedOfName(context.game, playerData, name) > 0);
}

function hasWarFactory(context: MissionContext): boolean {
    const playerData = context.game.getPlayerData(context.player.name);
    return WAR_FACTORY_NAMES.some((name) => numBuildingsOwnedOfName(context.game, playerData, name) > 0);
}

/**
 * Garrison strength ramps with game time and available structures.
 * Infantry → more infantry → dog → tank.
 */
function getProgressiveGuardComposition(context: MissionContext, side: SideType): Record<string, number> {
    const tick = context.game.getCurrentTick();
    const infantry = side === SideType.Nod ? "E2" : "E1";
    const dog = side === SideType.Nod ? "DOG" : "ADOG";

    if (!hasBarracks(context)) {
        return {};
    }

    let tier = 0;
    if (tick >= MIN_TICKS_BEFORE_GUARDS + 15 * 20) {
        tier = 1;
    }
    if (tick >= MIN_TICKS_BEFORE_GUARDS + 15 * 50) {
        tier = 2;
    }
    if (tick >= MIN_TICKS_BEFORE_GUARDS + 15 * 90 && hasWarFactory(context)) {
        tier = 3;
    }

    switch (tier) {
        case 0:
            return { [infantry]: 1 };
        case 1:
            return { [infantry]: 2 };
        case 2:
            return { [infantry]: 2, [dog]: 1 };
        default:
            return getFullGuardComposition(side);
    }
}

function getGuardPosts(missionController: MissionController): BaseGuardMission[] {
    return missionController
        .getMissions()
        .filter((mission): mission is BaseGuardMission => mission instanceof BaseGuardMission)
        .sort((a, b) => a.getPostIndex() - b.getPostIndex());
}

/** Pick the earliest post that still needs trained units — only it may pull factory output. */
export function refreshGuardFillSlot(missionController: MissionController, context: SupabotContext): void {
    designatedFillPostIndex = -1;
    for (const post of getGuardPosts(missionController)) {
        if (post.needsProductionFill(context)) {
            designatedFillPostIndex = post.getPostIndex();
            break;
        }
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
        private postIndex: number,
        private createdAtTick: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    getPostIndex(): number {
        return this.postIndex;
    }

    getCreatedAtTick(): number {
        return this.createdAtTick;
    }

    getTargetComposition(context: MissionContext): Record<string, number> {
        const side = context.game.getPlayerData(context.player.name).country?.side;
        if (side === undefined) {
            return {};
        }
        return getProgressiveGuardComposition(context, side);
    }

    needsProductionFill(context: SupabotContext | MissionContext): boolean {
        const target = this.getTargetComposition(context as MissionContext);
        if (Object.keys(target).length === 0) {
            return false;
        }
        return this.getMissingUnits(context.game, target).length > 0;
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        const { game, actionBatcher } = context;
        const tick = game.getCurrentTick();
        const targetComposition = this.getTargetComposition(context);

        const missing = this.getMissingUnits(game, targetComposition);
        if (
            missing.length > 0 &&
            this.postIndex === designatedFillPostIndex &&
            Object.keys(targetComposition).length > 0
        ) {
            // One unit type at a time so garrison never floods the production queue.
            const [unitName] = missing[0];
            return requestUnitsWithSamePriority([unitName], BASE_GUARD_FILL_PRIORITY);
        }

        // Only pull idle units when the post still needs bodies — never strip a forming attack wave.
        const grabAction =
            missing.length > 0 && this.getUnitIds().length < Object.values(targetComposition).reduce((a, b) => a + b, 0)
                ? grabCombatants(this.guardPoint, GRAB_RADIUS)
                : noop();

        if (this.getUnitIds().length === 0) {
            return missing.length > 0 ? grabAction : noop();
        }

        if (tick < this.lastOrderTick + GUARD_ORDER_INTERVAL_TICKS) {
            return noop();
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

        return noop();
    }

    getGlobalDebugText(): string | undefined {
        return `guard#${this.postIndex}@${this.guardPoint.x},${this.guardPoint.y}`;
    }

    getPriority() {
        return BASE_GUARD_HOLD_PRIORITY;
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

function shouldUnlockNextPost(context: SupabotContext, existing: BaseGuardMission[]): boolean {
    const tick = context.game.getCurrentTick();
    if (tick < MIN_TICKS_BEFORE_GUARDS) {
        return false;
    }
    if (existing.length === 0) {
        return hasBarracks(context as MissionContext);
    }
    if (existing.length >= GUARD_POST_OFFSETS.length) {
        return false;
    }

    const lastPost = existing[existing.length - 1];
    if (tick < lastPost.getCreatedAtTick() + GUARD_POST_UNLOCK_INTERVAL_TICKS) {
        return false;
    }

    // Previous post needs at least one guard, or its current-tier quota is already met.
    if (lastPost.getUnitIds().length > 0) {
        return true;
    }
    return !lastPost.needsProductionFill(context);
}

export class BaseGuardMissionFactory {
    getName(): string {
        return "BaseGuardMissionFactory";
    }

    maybeCreateMissions(context: SupabotContext, missionController: MissionController, logger: DebugLogger): void {
        if (!context.botProfile?.fortifyBase) {
            return;
        }

        refreshGuardFillSlot(missionController, context);

        const existing = getGuardPosts(missionController);
        if (!shouldUnlockNextPost(context, existing)) {
            return;
        }

        const { game } = context;
        const playerData = game.getPlayerData(context.player.name);
        const side = playerData.country?.side;
        if (side === undefined) {
            return;
        }

        const postIndex = existing.length;
        const offset = GUARD_POST_OFFSETS[postIndex];
        const guardPoint = new Vector2(playerData.startLocation.x + offset.dx, playerData.startLocation.y + offset.dy);

        missionController.addMission(
            new BaseGuardMission(`base-guard-${offset.label}`, guardPoint, postIndex, game.getCurrentTick(), logger),
        );
        logger(`Unlocked base guard post ${offset.label} (${postIndex + 1}/${GUARD_POST_OFFSETS.length})`);
    }
}
