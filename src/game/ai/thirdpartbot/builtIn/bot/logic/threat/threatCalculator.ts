import {
    GameApi,
    GameMath,
    GameObjectData,
    MovementZone,
    ObjectType,
    PlayerData,
    ProjectileRules,
    WeaponRules,
} from "../../../game-api";
import { GlobalThreat } from "./threat";
import { getCachedTechnoRules } from "../common/rulesCache";

/**
 * Single-pass threat estimate — avoids 8× getVisibleUnits full-map scans per refresh.
 */
export function calculateGlobalThreat(game: GameApi, playerData: PlayerData, visibleAreaPercent: number): GlobalThreat {
    const enemyIds = game.getVisibleUnits(playerData.name, "enemy");
    const selfIds = game.getVisibleUnits(playerData.name, "self");

    let observedGroundThreat = 0;
    let observedAirThreat = 0;
    let observedAntiAirThreat = 0;
    let observedGroundDefence = 0;

    for (const unitId of enemyIds) {
        const data = game.getGameObjectData(unitId);
        if (!data?.rules) {
            continue;
        }
        const rules = data.rules;
        const fp = calculateFirepowerForUnit(game, data);
        const isBuilding = rules.type === ObjectType.Building;
        const isGroundArmy =
            rules.type === ObjectType.Vehicle || rules.type === ObjectType.Infantry;
        const isFlyer = rules.movementZone === MovementZone.Fly;

        if (isGroundArmy) {
            observedGroundThreat += fp;
        }
        if (isFlyer) {
            observedAirThreat += fp;
        }
        if (isBuilding && isAntiGround(game, unitId)) {
            observedGroundDefence += fp;
        }
        if (!isBuilding && isAntiAir(game, unitId)) {
            observedAntiAirThreat += fp;
        }
    }

    let ourAntiGroundPower = 0;
    let ourAntiAirPower = 0;
    let ourAirPower = 0;
    let ourGroundDefencePower = 0;

    for (const unitId of selfIds) {
        const data = game.getGameObjectData(unitId);
        if (!data?.rules) {
            continue;
        }
        const rules = data.rules;
        const fp = calculateFirepowerForUnit(game, data);
        const isBuilding = rules.type === ObjectType.Building;
        const combatant = !!(rules as { isSelectableCombatant?: boolean }).isSelectableCombatant;

        if (combatant && isAntiGround(game, unitId)) {
            ourAntiGroundPower += fp;
        }
        if ((combatant || isBuilding) && isAntiAir(game, unitId)) {
            ourAntiAirPower += fp;
        }
        if (isBuilding && isAntiGround(game, unitId)) {
            ourGroundDefencePower += fp;
        }
        if (rules.movementZone === MovementZone.Fly && combatant) {
            ourAirPower += fp;
        }
    }

    return new GlobalThreat(
        visibleAreaPercent,
        observedGroundThreat,
        observedAirThreat,
        observedAntiAirThreat,
        observedGroundDefence,
        ourGroundDefencePower,
        ourAntiGroundPower,
        ourAntiAirPower,
        ourAirPower,
    );
}

function isAntiGround(gameApi: GameApi, unitId: any): boolean {
    return testProjectile(gameApi, unitId, (p) => p.isAntiGround);
}
function isAntiAir(gameApi: GameApi, unitId: any): boolean {
    return testProjectile(gameApi, unitId, (p) => p.isAntiAir);
}

function testProjectile(gameApi: GameApi, unitId: any, test: (p: ProjectileRules) => boolean) {
    const rules = getCachedTechnoRules(gameApi, unitId);
    if (!rules || !(rules.primary || rules.secondary)) {
        return false;
    }

    const primaryWeapon = rules.primary ? gameApi.rulesApi.getWeapon(rules.primary) : null;
    const primaryProjectile = getProjectileRules(gameApi, primaryWeapon);
    if (primaryProjectile && test(primaryProjectile)) {
        return true;
    }

    const secondaryWeapon = rules.secondary ? gameApi.rulesApi.getWeapon(rules.secondary) : null;
    const secondaryProjectile = getProjectileRules(gameApi, secondaryWeapon);
    if (secondaryProjectile && test(secondaryProjectile)) {
        return true;
    }

    return false;
}

function getProjectileRules(gameApi: GameApi, weapon: WeaponRules | null): ProjectileRules | null {
    return weapon ? gameApi.rulesApi.getProjectile(weapon.projectile) : null;
}

function calculateFirepowerForUnit(gameApi: GameApi, gameObjectData: GameObjectData): number {
    const rules = getCachedTechnoRules(gameApi, gameObjectData.id);
    if (!rules) {
        return 0;
    }
    const currentHp = gameObjectData?.hitPoints || 0;
    const maxHp = gameObjectData?.maxHitPoints || 0;
    let threat = 0;
    const hpRatio = currentHp / Math.max(1, maxHp);

    if (rules.primary) {
        const weapon = gameApi.rulesApi.getWeapon(rules.primary);
        threat += (hpRatio * ((weapon.damage + 1) * GameMath.sqrt(weapon.range + 1))) / Math.max(weapon.rof, 1);
    }
    if (rules.secondary) {
        const weapon = gameApi.rulesApi.getWeapon(rules.secondary);
        threat += (hpRatio * ((weapon.damage + 1) * GameMath.sqrt(weapon.range + 1))) / Math.max(weapon.rof, 1);
    }
    return Math.min(800, threat);
}
