import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
import path from "path";

export interface AppConfig {
  requireRepoSelection: boolean;
}

const CONFIG_PATH = path.resolve("config.yml");

const DEFAULT_CONFIG: AppConfig = {
  requireRepoSelection: true,
};

export function loadAppConfig(): AppConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = parse(raw) as Record<string, unknown>;

  return {
    requireRepoSelection:
      typeof parsed["requireRepoSelection"] === "boolean"
        ? parsed["requireRepoSelection"]
        : DEFAULT_CONFIG.requireRepoSelection,
  };
}
