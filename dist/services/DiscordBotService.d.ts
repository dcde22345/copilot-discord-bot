import type { Logger } from "pino";
import type { BotConfig } from "../config.js";
import type { AppConfig } from "../appConfig.js";
import type { SqliteSessionStore } from "../data/SqliteSessionStore.js";
import type { SessionRuntimeManager } from "./SessionRuntimeManager.js";
export declare class DiscordBotService {
    private readonly logger;
    private readonly config;
    private readonly appConfig;
    private readonly store;
    private readonly runtimeManager;
    private client;
    private router;
    constructor(logger: Logger, config: BotConfig, appConfig: AppConfig, store: SqliteSessionStore, runtimeManager: SessionRuntimeManager);
    start(): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=DiscordBotService.d.ts.map