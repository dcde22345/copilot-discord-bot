import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
import path from "path";
const CONFIG_PATH = path.resolve("config.yml");
const DEFAULT_CONFIG = {
    requireRepoSelection: true,
};
export function loadAppConfig() {
    if (!existsSync(CONFIG_PATH)) {
        return { ...DEFAULT_CONFIG };
    }
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = parse(raw);
    return {
        requireRepoSelection: typeof parsed["requireRepoSelection"] === "boolean"
            ? parsed["requireRepoSelection"]
            : DEFAULT_CONFIG.requireRepoSelection,
    };
}
//# sourceMappingURL=appConfig.js.map