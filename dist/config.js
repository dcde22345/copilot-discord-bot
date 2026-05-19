import { z } from "zod";
const BotConfigSchema = z.object({
    DISCORD_BOT_TOKEN: z.string().default(""),
    OWNER_DISCORD_USER_ID: z
        .string()
        .optional()
        .transform((v) => (v ? BigInt(v) : 0n)),
    REPOS_ROOT: z.string().default(""),
    DATA_DIR: z.string().default("data"),
    DEFAULT_MODEL: z.string().default("gpt-5"),
    COPILOT_CLI_PATH: z.string().optional(),
    DEFAULT_AUTO_APPROVE_PERMISSIONS: z
        .string()
        .optional()
        .transform((v) => v === "true"),
    AUTO_APPROVE_READ_PERMISSIONS: z
        .string()
        .optional()
        .transform((v) => v !== "false"),
    TURN_TIMEOUT_SECONDS: z
        .string()
        .optional()
        .transform((v) => {
        const n = parseInt(v ?? "900", 10);
        return Math.min(3600, Math.max(10, isNaN(n) ? 900 : n));
    }),
    DEBUG_PERMISSION_PAYLOAD: z
        .string()
        .optional()
        .transform((v) => v === "true"),
    PORT: z
        .string()
        .optional()
        .transform((v) => parseInt(v ?? "5000", 10)),
    HOST: z.string().default("127.0.0.1"),
    OPENAI_API_KEY: z.string().optional(),
    EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
    RAG_TOP_K: z
        .string()
        .optional()
        .transform((v) => {
        const n = parseInt(v ?? "3", 10);
        return Math.min(10, Math.max(1, isNaN(n) ? 3 : n));
    }),
});
export function loadConfig() {
    return BotConfigSchema.parse(process.env);
}
//# sourceMappingURL=config.js.map