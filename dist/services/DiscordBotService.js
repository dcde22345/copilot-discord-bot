import { Client, GatewayIntentBits, Partials, Events, } from "discord.js";
import { DiscordCommandRouter } from "./DiscordCommandRouter.js";
import { existsSync } from "fs";
export class DiscordBotService {
    logger;
    config;
    appConfig;
    store;
    runtimeManager;
    client = null;
    router = null;
    constructor(logger, config, appConfig, store, runtimeManager) {
        this.logger = logger;
        this.config = config;
        this.appConfig = appConfig;
        this.store = store;
        this.runtimeManager = runtimeManager;
    }
    async start() {
        if (!this.config.DISCORD_BOT_TOKEN) {
            this.logger.fatal("DISCORD_BOT_TOKEN is empty. Discord bot will not start. Set the token in the environment.");
            return;
        }
        if (this.config.REPOS_ROOT && !existsSync(this.config.REPOS_ROOT)) {
            this.logger.warn({ reposRoot: this.config.REPOS_ROOT }, "REPOS_ROOT does not exist");
        }
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions,
            ],
            // Partials required for reactions on uncached messages
            partials: [Partials.Message, Partials.Channel, Partials.Reaction],
        });
        this.client.on(Events.Debug, (msg) => this.logger.debug({ msg }, "Discord debug"));
        this.client.on(Events.Warn, (msg) => this.logger.warn({ msg }, "Discord warn"));
        this.client.on(Events.Error, (err) => this.logger.error({ err }, "Discord error"));
        this.router = new DiscordCommandRouter(this.logger, this.config, this.appConfig, this.store, this.runtimeManager, this.client);
        this.client.on(Events.MessageCreate, (message) => {
            void (async () => {
                try {
                    await this.router.handleMessage(message);
                }
                catch (err) {
                    this.logger.error({ err }, "Message handler failed");
                }
            })();
        });
        this.client.on(Events.MessageReactionAdd, (reaction, user) => {
            void (async () => {
                try {
                    await this.router.handleReaction(reaction, user);
                }
                catch (err) {
                    this.logger.error({ err }, "Reaction handler failed");
                }
            })();
        });
        this.client.on(Events.ClientReady, () => {
            this.logger.info({ username: this.client?.user?.tag }, "Discord bot ready");
        });
        try {
            await this.client.login(this.config.DISCORD_BOT_TOKEN);
            this.logger.info("Discord bot started");
        }
        catch (err) {
            this.logger.fatal({ err }, "Failed to login/start Discord client. Check token and bot permissions.");
            throw err;
        }
    }
    async stop() {
        this.logger.info("Stopping Discord bot...");
        if (this.client) {
            try {
                await this.client.destroy();
            }
            catch { /* ignore */ }
            this.client = null;
        }
        await this.runtimeManager.disposeAll();
    }
}
//# sourceMappingURL=DiscordBotService.js.map