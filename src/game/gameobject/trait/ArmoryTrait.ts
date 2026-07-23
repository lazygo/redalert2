import { ObjectType } from '@/engine/type/ObjectType';
import { GameSpeed } from '@/game/GameSpeed';
import { RadialTileFinder } from '@/game/map/tileFinder/RadialTileFinder';
import { ScatterTask } from '@/game/gameobject/task/ScatterTask';
import { NotifyDestroy } from '@/game/gameobject/trait/interface/NotifyDestroy';
import { NotifyTick } from '@/game/gameobject/trait/interface/NotifyTick';
import { GameObject } from '@/game/gameobject/GameObject';

/**
 * Infantry enter an Armory (e.g. CAARMR / 国民兵训练中心) to gain one veteran rank,
 * consuming ammo charges. Mirrors HospitalTrait's enter/queue/evac flow.
 */
export class ArmoryTrait {
    private trainQueue: GameObject[] = [];
    private unit?: GameObject;
    private trainTicks?: number;

    addToTrainQueue(unit: GameObject): number {
        this.trainQueue.push(unit);
        return this.trainQueue.length - 1;
    }

    unitIsFirstInTrainQueue(unit: GameObject): boolean {
        return this.trainQueue[0] === unit;
    }

    removeFromTrainQueue(unit: GameObject): void {
        const index = this.trainQueue.indexOf(unit);
        if (index !== -1) {
            this.trainQueue.splice(index, 1);
        }
    }

    startTraining(unit: GameObject): void {
        if (this.unit) {
            throw new Error(`Already busy training unit ${ObjectType[this.unit.type]}#${this.unit.id}`);
        }
        this.unit = unit;
        this.trainTicks = 5 * GameSpeed.BASE_TICKS_PER_SECOND;
    }

    [NotifyTick.onTick](armory: GameObject, game: any): void {
        this.trainQueue = this.trainQueue.filter((unit) => !unit.isDestroyed && !unit.isCrashing);
        if (this.unit && this.trainTicks !== undefined) {
            if (this.trainTicks > 0) {
                this.trainTicks--;
            }
            if (this.trainTicks <= 0) {
                this.trainTicks = undefined;
                this.removeFromTrainQueue(this.unit);
                if (this.unit.veteranTrait) {
                    this.unit.veteranTrait.promote(1, game);
                }
                if (armory.ammoTrait) {
                    armory.ammoTrait.ammo--;
                }
                this.evacuate(this.unit, armory, game);
                this.unit = undefined;
            }
        }
    }

    [NotifyDestroy.onDestroy](_armory: GameObject, game: any, source: any): void {
        if (this.unit) {
            game.destroyObject(this.unit, source, true);
            this.unit = undefined;
        }
    }

    private evacuate(unit: GameObject, armory: GameObject, game: any): void {
        let targetTile;
        const exitPoint = {
            x: armory.tile.rx,
            y: armory.tile.ry + armory.art.foundation.height
        };
        let tile = game.map.tiles.getByMapCoords(exitPoint.x, exitPoint.y);
        if (tile &&
            game.map.isWithinBounds(tile) &&
            this.canEvacuateTo(tile, unit, armory, game)) {
            targetTile = tile;
        }
        if (!targetTile) {
            targetTile = new RadialTileFinder(game.map.tiles, game.map.mapBounds, armory.tile, armory.art.foundation, 1, 1, (t: any) => this.canEvacuateTo(t, unit, armory, game)).getNextTile();
        }
        if (targetTile) {
            game.unlimboObject(unit, targetTile);
            unit.unitOrderTrait.addTask(new ScatterTask(game));
        }
        else {
            game.destroyObject(unit, { player: unit.owner });
        }
    }

    private canEvacuateTo(tile: any, unit: GameObject, armory: GameObject, game: any): boolean {
        return (game.map.terrain.getPassableSpeed(tile, unit.rules.speedType, unit.isInfantry(), false) > 0 &&
            Math.abs(tile.z - armory.tile.z) < 2 &&
            !game.map.terrain.findObstacles({ tile, onBridge: undefined }, unit).length);
    }
}
