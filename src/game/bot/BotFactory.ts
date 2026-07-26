import { AiDifficulty } from '../gameopts/GameOpts';
import { Bot } from './Bot';
import { DummyBot } from './DummyBot';
import { BuiltInBotAdapter } from '../ai/thirdpartbot/builtIn/BuiltInBotAdapter';
import { BotRegistry } from '../ai/thirdpartbot/BotRegistry';
import { ThirdPartyBotAdapter } from '../ai/thirdpartbot/ThirdPartyBotAdapter';
import {
    BRUTAL_BOT_PROFILE,
    NORMAL_BOT_PROFILE,
    SAVAGE_BOT_PROFILE,
    SIMPLE_BOT_PROFILE,
    type BotDifficultyProfile,
} from '../ai/thirdpartbot/builtIn/bot/BotDifficultyProfile';

export class BotFactory {
    private botsLib: any;
    constructor(botsLib: any) {
        this.botsLib = botsLib;
    }
    create(player: {
        isAi: boolean;
        name: string;
        aiDifficulty: AiDifficulty;
        country: {
            name: string;
        };
        customBotId?: string;
    }): Bot {
        if (!player.isAi) {
            throw new Error(`Player "${player.name}" is not an AI`);
        }

        if (player.aiDifficulty === AiDifficulty.Custom) {
            const registry = BotRegistry.getInstance();
            if (player.customBotId) {
                const meta = registry.get(player.customBotId);
                if (meta) {
                    console.info(`[BotFactory] Using bot "${meta.displayName}" for "${player.name}"`);
                    return new ThirdPartyBotAdapter(player.name, player.country.name, meta);
                }
                console.warn(`[BotFactory] Custom bot "${player.customBotId}" not found, trying fallback`);
            }
            const uploadedBots = registry.getUploadedBots();
            if (uploadedBots.length > 0) {
                const meta = uploadedBots[0];
                console.info(`[BotFactory] Using uploaded bot "${meta.displayName}" for "${player.name}"`);
                return new ThirdPartyBotAdapter(player.name, player.country.name, meta);
            }
            console.warn(`[BotFactory] Custom AI selected but no uploaded bot found, falling back to BuiltInBotAdapter`);
            return new BuiltInBotAdapter(player.name, player.country.name, SIMPLE_BOT_PROFILE);
        }

        const profile = this.profileForDifficulty(player.aiDifficulty);
        if (profile) {
            return new BuiltInBotAdapter(player.name, player.country.name, profile);
        }

        if (
            player.aiDifficulty === AiDifficulty.Easy ||
            player.aiDifficulty === AiDifficulty.Medium ||
            player.aiDifficulty === AiDifficulty.MediumSea
        ) {
            return new DummyBot(player.name, player.country.name);
        }

        throw new Error(`Unsupported AI difficulty "${player.aiDifficulty}"`);
    }

    private profileForDifficulty(difficulty: AiDifficulty): BotDifficultyProfile | undefined {
        switch (difficulty) {
            case AiDifficulty.Normal:
                return SIMPLE_BOT_PROFILE;
            case AiDifficulty.Hard:
                return NORMAL_BOT_PROFILE;
            case AiDifficulty.Brutal:
                return BRUTAL_BOT_PROFILE;
            case AiDifficulty.Savage:
                return SAVAGE_BOT_PROFILE;
            default:
                return undefined;
        }
    }
}
