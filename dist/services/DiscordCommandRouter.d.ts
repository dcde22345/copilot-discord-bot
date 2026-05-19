import { Client, Message, MessageReaction, PartialMessageReaction, User, PartialUser } from "discord.js";
import type { Logger } from "pino";
import type { BotConfig } from "../config.js";
import type { AppConfig } from "../appConfig.js";
import type { SqliteSessionStore } from "../data/SqliteSessionStore.js";
import type { SessionRuntimeManager } from "./SessionRuntimeManager.js";
export declare class DiscordCommandRouter {
    private readonly logger;
    private readonly config;
    private readonly appConfig;
    private readonly store;
    private readonly runtimeManager;
    private readonly client;
    private repoPickers;
    constructor(logger: Logger, config: BotConfig, appConfig: AppConfig, store: SqliteSessionStore, runtimeManager: SessionRuntimeManager, client: Client);
    handleMessage(message: Message): Promise<void>;
    handleReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void>;
    private createThreadAndRespond;
    private sendRepoPickerToThread;
    private handleCommand;
}
//# sourceMappingURL=DiscordCommandRouter.d.ts.map