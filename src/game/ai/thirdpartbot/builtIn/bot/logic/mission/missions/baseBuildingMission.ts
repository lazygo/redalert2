import { GameApi, PlayerData, QueueType, TechnoRules } from "../../../../game-api";
import { MissionContext } from "../../common/context";
import { DebugLogger, maxBy } from "../../common/utils";
import { buildStructureAtLocation, Mission, MissionAction, noop } from "../mission";
import { GlobalThreat } from "../../threat/threat";
import {
    BUILDING_NAME_TO_RULES,
    DEFAULT_BUILDING_PRIORITY,
    getDefaultPlacementLocation,
} from "../../building/buildingRules";
import {
    applySavageStructurePriority,
    computeSavageRedundantProductionPriority,
    isSavageProductionStructure,
    isSavageStaticDefence,
    resolveSavageProductionMaxCount,
} from "../../building/savageBuildingPolicy";
import {
    applyWallFortifyPriority,
    getWallPlacementAroundConyards,
    isWallStructure,
} from "../../building/wallFortification";
import { getSavageStaticDefencePlacement } from "../../building/common";
import { queueTypeToName } from "../../building/queueController";
import { numBuildingsOwnedOfName } from "../../building/buildingRules";
import { isBrutalOrSavageProfile } from "../../../BotDifficultyProfile";

// Legacy mission encompassing the old "build queue" logic.
export class BaseBuildingMission extends Mission {
    constructor(
        private queueType: QueueType,
        logger: DebugLogger,
    ) {
        super(`building-mission-${queueTypeToName(queueType)}`, logger);
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        const options = context.player.production.getAvailableObjects(this.queueType);
        const playerData = context.game.getPlayerData(context.player.name);
        if (options.length === 0) {
            return noop();
        }

        const { game, matchAwareness } = context;
        const threatCache = matchAwareness.getThreatCache();

        const optionWithPriority = options.map((option) => {
            try {
                return {
                    option,
                    priority: this.getPriorityForBuildingOption(option, game, playerData, threatCache, context),
                };
            } catch (err) {
                this.logger(`Building priority error for ${option.name}: ${err}`);
                return { option, priority: -100 };
            }
        });

        const bestOption = maxBy(optionWithPriority, (option) => option.priority);

        // Only positive priorities may enter the production queue.
        if (!bestOption || bestOption.priority <= 0) {
            return noop();
        }

        let bestLocation: { rx: number; ry: number } | undefined;
        try {
            bestLocation = this.getBestLocationForStructure(game, playerData, bestOption.option, context);
        } catch (err) {
            this.logger(`Building placement error for ${bestOption.option.name}: ${err}`);
            return noop();
        }

        if (!bestLocation) {
            return noop();
        }

        return buildStructureAtLocation(bestOption.option.name, bestOption.priority, bestLocation.rx, bestLocation.ry);
    }

    getGlobalDebugText(): string | undefined {
        return undefined;
    }

    getPriority(): number {
        return 0;
    }

    private getPriorityForBuildingOption(
        option: TechnoRules,
        game: GameApi,
        playerStatus: PlayerData,
        threatCache: GlobalThreat | null,
        context: MissionContext,
    ) {
        if (BUILDING_NAME_TO_RULES.has(option.name)) {
            if ((option.name === "GAYARD" || option.name === "NAYARD" || option.name === "CAYARD") && !context.botProfile?.enableNavy) {
                return 0;
            }
            let logic = BUILDING_NAME_TO_RULES.get(option.name)!;
            let priority = logic.getPriority(game, playerStatus, option, threatCache);
            if (isBrutalOrSavageProfile(context.botProfile)) {
                priority = applyWallFortifyPriority(
                    option.name,
                    priority,
                    game,
                    playerStatus,
                    context.botProfile,
                );
            }
            if (context.botProfile?.fortifyBase) {
                if (isSavageProductionStructure(option.name)) {
                    const savageMax = resolveSavageProductionMaxCount(
                        option.name,
                        game,
                        playerStatus,
                        context.botProfile,
                    );
                    const owned = numBuildingsOwnedOfName(game, playerStatus, option.name);
                    if (savageMax !== null && owned >= savageMax) {
                        return -100;
                    }
                    if (priority <= -100 && savageMax !== null && owned < savageMax) {
                        priority = computeSavageRedundantProductionPriority(
                            option.name,
                            game,
                            playerStatus,
                            context.botProfile,
                        );
                    }
                }
                priority = applySavageStructurePriority(option.name, priority, game, playerStatus);
            }
            return priority;
        } else {
            // Fallback priority when there are no rules.
            return (
                DEFAULT_BUILDING_PRIORITY - game.getVisibleUnits(playerStatus.name, "self", (r) => r == option).length
            );
        }
    }

    private getBestLocationForStructure(
        game: GameApi,
        playerData: PlayerData,
        objectReady: TechnoRules,
        context: MissionContext,
    ): { rx: number; ry: number } | undefined {
        if (BUILDING_NAME_TO_RULES.has(objectReady.name)) {
            if (isBrutalOrSavageProfile(context.botProfile) && isWallStructure(objectReady.name)) {
                const wallLocation = getWallPlacementAroundConyards(game, playerData, objectReady);
                if (wallLocation) {
                    return wallLocation;
                }
            }
            if (context.botProfile?.fortifyBase && isSavageStaticDefence(objectReady.name)) {
                const savageLocation = getSavageStaticDefencePlacement(game, playerData, objectReady);
                if (savageLocation) {
                    return savageLocation;
                }
            }
            let logic = BUILDING_NAME_TO_RULES.get(objectReady.name)!;
            return logic.getPlacementLocation(game, playerData, objectReady);
        } else {
            // fallback placement logic
            return getDefaultPlacementLocation(game, playerData, playerData.startLocation, objectReady);
        }
    }

//     private handleBuildingReady(context: MissionContext, objectReady: TechnoRules) {
//         const { game, player } = context;
//         const { actions: actionsApi } = player;
//         const playerData = game.getPlayerData(player.name);
//         let location: { rx: number; ry: number } | undefined = this.getBestLocationForStructure(
//             game,
//             playerData,
//             objectReady,
//         );
//         if (location !== undefined) {
//             this.logger(
//                 `Completed (${queueTypeToName(this.queueType)}): ${objectReady.name}, placing at ${location.rx},${
//                     location.ry
//                 }`,
//             );
//             actionsApi.placeBuilding(objectReady.name, location.rx, location.ry);
//         } else {
//             this.logger(`Completed (${queueTypeToName(this.queueType)}): ${objectReady.name} but nowhere to place it`);
//         }
//     }
}
