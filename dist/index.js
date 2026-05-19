import "dotenv/config";
import Fastify from "fastify";
import pino from "pino";
import * as sqliteVec from "sqlite-vec";
import { loadConfig } from "./config.js";
import { loadAppConfig } from "./appConfig.js";
import { SqliteSessionStore } from "./data/SqliteSessionStore.js";
import { SessionRuntimeManager } from "./services/SessionRuntimeManager.js";
import { DiscordBotService } from "./services/DiscordBotService.js";
const logger = pino({
    level: process.env["LOG_LEVEL"] ?? "info",
    transport: process.env["NODE_ENV"] === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
});
async function main() {
    const config = loadConfig();
    const appConfig = loadAppConfig();
    logger.info({ dataDir: config.DATA_DIR, reposRoot: config.REPOS_ROOT, requireRepoSelection: appConfig.requireRepoSelection }, "Starting Copilot Discord Bot");
    const store = new SqliteSessionStore(config.DATA_DIR);
    sqliteVec.load(store.db);
    logger.info("sqlite-vec extension loaded");
    const runtimeManager = new SessionRuntimeManager(logger, config, store);
    const botService = new DiscordBotService(logger, config, appConfig, store, runtimeManager);
    // Fastify HTTP server for health checks.
    const fastify = Fastify({ logger: false });
    fastify.get("/health", async () => ({
        status: "ok",
        utc: new Date().toISOString(),
    }));
    fastify.get("/", async (_req, reply) => {
        return reply.type("text/plain").send("Copilot Discord Bot is running. See /health");
    });
    // Graceful shutdown handler.
    let isShuttingDown = false;
    const shutdown = async (signal) => {
        if (isShuttingDown)
            return;
        isShuttingDown = true;
        logger.info({ signal }, "Shutdown signal received");
        try {
            await botService.stop();
        }
        catch (err) {
            logger.error({ err }, "Error stopping bot service");
        }
        try {
            store.close();
        }
        catch { /* ignore */ }
        try {
            await fastify.close();
        }
        catch { /* ignore */ }
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
    // Start HTTP server.
    await fastify.listen({ port: config.PORT, host: config.HOST });
    logger.info({ port: config.PORT, host: config.HOST }, "HTTP server listening");
    // Start Discord bot (non-blocking; runs until shutdown).
    try {
        await botService.start();
    }
    catch (err) {
        logger.error({ err }, "Discord bot failed to start; HTTP server remains up for health checks.");
    }
}
main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map