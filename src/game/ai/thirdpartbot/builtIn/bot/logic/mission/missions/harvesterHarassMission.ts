import { GameApi, PlayerData, SideType, UnitData, Vector2 } from "../../../../game-api";
import { DebugLogger } from "../../common/utils";
import { MissionContext, SupabotContext } from "../../common/context";
import { Mission, MissionAction, disbandMission, noop, requestUnitsWithSamePriority } from "../mission";
import { MissionController } from "../missionController";
import { manageAttackMicro, manageMoveMicro } from "./squads/common";

const CHECK_COOLDOWN_TICKS = 40;
const MISSION_TIMEOUT_TICKS = 15 * 45;
const ORDER_INTERVAL_TICKS = 25;
const HARASS_HOLD_PRIORITY = 44;
const HARASS_FILL_PRIORITY = 38;

const LIGHT_HARASS_UNITS: Record<SideType, string[]> = {
    [SideType.GDI]: ["E1", "FV", "MTNK"],
    [SideType.Nod]: ["E2", "HTK", "HTNK"],
    [SideType.Civilian]: [],
    [SideType.Mutant]: []
};

/**
 * Small independent raid targeting visible enemy harvesters.
 * Does not share the main assault rally blob.
 */
export class HarvesterHarassMission extends Mission {
    private lastOrderTick = -1;
    private createdAtTick: number;

    constructor(
        uniqueName: string,
        private targetHarvesterId: number,
        private targetPoint: Vector2,
        logger: DebugLogger,
        createdAtTick: number,
    ) {
        super(uniqueName, logger);
        this.createdAtTick = createdAtTick;
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        const { game, actionBatcher } = context;
        const tick = game.getCurrentTick();

        if (tick > this.createdAtTick + MISSION_TIMEOUT_TICKS) {
            return disbandMission("timeout");
        }

        const harvester = game.getUnitData(this.targetHarvesterId);
        if (!harvester || !harvester.rules.harvester) {
            return disbandMission("target_gone");
        }

        const attackPoint = new Vector2(harvester.tile.rx, harvester.tile.ry);
        const units = this.getUnits(game)
            .map((id) => game.getUnitData(id))
            .filter((unit): unit is UnitData => !!unit);

        if (units.length === 0) {
            const side = context.game.getPlayerData(context.player.name).country?.side;
            if (side === undefined) {
                return disbandMission("no_side");
            }
            const available = new Set(
                context.player.production.getAvailableObjects().map((object) => object.name),
            );
            const unitNames = LIGHT_HARASS_UNITS[side].filter((name) => available.has(name));
            if (unitNames.length === 0) {
                return disbandMission("no_units");
            }
            return requestUnitsWithSamePriority(unitNames, HARASS_FILL_PRIORITY);
        }

        if (tick < this.lastOrderTick + ORDER_INTERVAL_TICKS) {
            return noop();
        }
        this.lastOrderTick = tick;

        for (const unit of units) {
            const dist = Math.abs(unit.tile.rx - attackPoint.x) + Math.abs(unit.tile.ry - attackPoint.y);
            if (dist <= 8) {
                actionBatcher.push(manageAttackMicro(unit, harvester));
            } else {
                actionBatcher.push(manageMoveMicro(unit, attackPoint));
            }
        }

        return noop();
    }

    isUnitsLocked(): boolean {
        return this.getUnitIds().length > 0;
    }

    getGlobalDebugText(): string | undefined {
        return `harass-harvester@${this.targetPoint.x},${this.targetPoint.y}`;
    }

    getPriority() {
        return HARASS_HOLD_PRIORITY;
    }
}

function findBestHarvesterTarget(game: GameApi, playerData: PlayerData): { id: number; point: Vector2 } | null {
    const harvesters = game
        .getVisibleUnits(playerData.name, "enemy")
        .map((id) => game.getUnitData(id))
        .filter((unit): unit is UnitData => !!unit && !!unit.rules.harvester);

    if (!harvesters.length) {
        return null;
    }

    let best: UnitData | undefined;
    let bestScore = -Infinity;
    for (const harvester of harvesters) {
        const owner = game.getPlayerData(harvester.owner);
        if (!owner.isCombatant) {
            continue;
        }
        const dist = playerData.startLocation.distanceTo(new Vector2(harvester.tile.rx, harvester.tile.ry));
        const score = 1000 - dist;
        if (score > bestScore) {
            bestScore = score;
            best = harvester;
        }
    }

    if (!best) {
        return null;
    }

    return {
        id: best.id,
        point: new Vector2(best.tile.rx, best.tile.ry),
    };
}

export class HarvesterHarassMissionFactory {
    private lastCheckAt = -CHECK_COOLDOWN_TICKS;

    getName(): string {
        return "HarvesterHarassMissionFactory";
    }

    maybeCreateMissions(context: SupabotContext, missionController: MissionController, logger: DebugLogger): void {
        const { game } = context;
        const tick = game.getCurrentTick();
        if (tick < this.lastCheckAt + CHECK_COOLDOWN_TICKS) {
            return;
        }
        this.lastCheckAt = tick;

        const active = missionController
            .getMissions()
            .filter((mission) => mission.getUniqueName().startsWith("harass-harvester-"));
        if (active.length >= 1) {
            return;
        }

        const playerData = game.getPlayerData(context.player.name);
        const target = findBestHarvesterTarget(game, playerData);
        if (!target) {
            return;
        }

        const combatants = game.getVisibleUnits(
            context.player.name,
            "self",
            (r) => !!(r as { isSelectableCombatant?: boolean }).isSelectableCombatant,
        ).length;
        if (combatants < 4) {
            return;
        }

        const added = missionController.addMission(
            new HarvesterHarassMission(
                `harass-harvester-${target.id}`,
                target.id,
                target.point,
                logger,
                tick,
            ),
        );
        if (added) {
            logger(`Harvester harass mission vs harvester #${target.id}`);
        }
    }
}
