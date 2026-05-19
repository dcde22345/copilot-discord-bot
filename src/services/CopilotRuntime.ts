import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import {
  CopilotClient,
  CopilotSession,
  type PermissionHandler,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type ResumeSessionConfig,
  type SessionEvent,
  type MCPLocalServerConfig,
  type MCPRemoteServerConfig,
} from "@github/copilot-sdk";
import type { Logger } from "pino";
import type { SessionRecord } from "../models/SessionRecord.js";
import type { SessionConfigState } from "../models/SessionConfigState.js";
import { box, trimShort } from "../utils/discordUi.js";

export interface CopilotTurnOutcome {
  success: boolean;
  timedOut: boolean;
  errorMessage?: string;
}

export const CopilotTurnOutcome = {
  ok: (): CopilotTurnOutcome => ({ success: true, timedOut: false }),
  timeout: (): CopilotTurnOutcome => ({ success: false, timedOut: true }),
  failed: (error?: string): CopilotTurnOutcome => ({
    success: false,
    timedOut: false,
    errorMessage: error,
  }),
};

export class CopilotRuntime {
  private client: CopilotClient | null = null;
  private session: CopilotSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastToolLabel: string | null = null;
  private turnLocked = false;
  private turnQueue: Array<() => void> = [];
  private currentUserMessage: string | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly record: SessionRecord,
    private readonly cfg: SessionConfigState,
    private readonly cwd: string,
    private readonly cliPath: string | undefined,
    private readonly turnTimeoutMs: number,
    private readonly sendToDiscord: (text: string) => Promise<void>,
    private readonly sendProgress: (text: string) => Promise<void>,
    private readonly permissionHandler: PermissionHandler,
    private readonly onConversationComplete?: (userQuestion: string, assistantAnswer: string) => void,
    private readonly ragContext?: string
  ) {}

  async start(): Promise<void> {
    const effectiveCli = this.cliPath || "copilot";

    this.client = new CopilotClient({
      logLevel: "error",
      autoStart: true,
      cwd: this.cwd,
      cliPath: this.cliPath || undefined,
      useStdio: true,
    });

    try {
      await this.client.start();

      try {
        const auth = await this.client.getAuthStatus();
        if (!auth.isAuthenticated) {
          await this.sendToDiscord(
            box("Copilot auth required", [{ key: "authType", value: (auth as unknown as Record<string, string>)["authType"] ?? "?" }], {
              footer: "Run `copilot` once on the server to sign in (or set `GH_TOKEN`).",
              icon: "lock",
            })
          );
        }
      } catch {
        // Older CLI/runtime might not support auth status; ignore.
      }

      await this.ensureSession();
    } catch (err) {
      const probe = await this.probeCopilotCli(effectiveCli);

      const lines: string[] = [];
      lines.push("**Copilot runtime failed to start**");
      lines.push("```text");
      lines.push(`error   : ${(err as Error)?.message ?? String(err)}`);
      lines.push(`cli     : ${effectiveCli} --version`);
      lines.push(`exit    : ${probe.exitCode != null ? probe.exitCode : "(timeout)"}`);
      lines.push("```");

      if (probe.output) {
        lines.push("```text");
        lines.push(trimShort(probe.output, 1500));
        lines.push("```");
      }

      lines.push("Fixes:");
      lines.push("- Install: `winget install --id GitHub.Copilot.Prerelease -e`");
      lines.push("- Verify: `where copilot` + `copilot --version`");
      lines.push("- Auth: run `copilot` once (or set `GH_TOKEN`)");
      lines.push("- If PATH hits a shim, set `COPILOT_CLI_PATH` env var");

      await this.sendToDiscord(lines.join("\n"));
      throw err;
    }
  }

  private async probeCopilotCli(cli: string): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      try {
        const proc = spawn(cli, ["--version"], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });

        let output = "";
        proc.stdout.on("data", (d: Buffer) => { output += d.toString(); });
        proc.stderr.on("data", (d: Buffer) => { output += d.toString(); });

        const timer = setTimeout(() => {
          try { proc.kill(); } catch { /* ignore */ }
          resolve({ exitCode: null, output: "Timed out running copilot --version" });
        }, 5000);

        proc.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code, output: output.trim() });
        });

        proc.on("error", (err) => {
          clearTimeout(timer);
          resolve({ exitCode: null, output: `Failed to run copilot --version: ${err.message}` });
        });

        proc.stdin.end();
      } catch (err) {
        resolve({ exitCode: null, output: `Failed to run copilot --version: ${(err as Error).message}` });
      }
    });
  }

  private async ensureSession(): Promise<void> {
    if (!this.client) throw new Error("Client not started");

    const model = this.cfg.model || "gpt-5";

    const resumeConfig: ResumeSessionConfig = {
      streaming: this.cfg.streaming,
      onPermissionRequest: this.permissionHandler,
      mcpServers: buildMcpServers(this.cfg.mcpServers, this.logger),
      customAgents: this.cfg.customAgents ?? undefined,
      skillDirectories: this.cfg.skillDirectories,
      disabledSkills: this.cfg.disabledSkills,
    };

    try {
      this.session = await this.client.resumeSession(
        this.record.copilotSessionId,
        resumeConfig
      );
    } catch (err) {
      if (!looksLikeSessionNotFound(err)) {
        await this.sendToDiscord(
          box(
            "Session resume failed",
            [
              { key: "session", value: this.record.copilotSessionId },
              { key: "error", value: `${(err as Error).constructor?.name ?? "Error"}: ${(err as Error).message}` },
            ],
            {
              footer: "The bot did not create a new session automatically (to avoid losing context).",
              icon: "X",
            }
          )
        );
        throw err;
      }

      const createConfig: SessionConfig = {
        sessionId: this.record.copilotSessionId,
        model,
        streaming: this.cfg.streaming,
        availableTools: this.cfg.availableTools,
        excludedTools: this.cfg.excludedTools,
        onPermissionRequest: this.permissionHandler,
        mcpServers: buildMcpServers(this.cfg.mcpServers, this.logger),
        customAgents: this.cfg.customAgents ?? undefined,
        skillDirectories: this.cfg.skillDirectories,
        disabledSkills: this.cfg.disabledSkills,
        systemMessage: {
          mode: "append",
          content: this.buildSystemMessage(),
        },
      };

      this.session = await this.client.createSession(createConfig);
    }

    this.unsubscribe?.();
    this.unsubscribe = this.session.on(async (evt: SessionEvent) => {
      try {
        await this.handleSessionEvent(evt);
      } catch (err) {
        this.logger.error({ err }, "Failed to forward Copilot event to Discord");
      }
    });
  }

  private buildSystemMessage(): string {
    const baseInstructions = `<context>\nThe current working directory is: ${this.cwd}\n</context>\n\n<instructions>\n- You are running inside a Discord-controlled agent session.\n- Prefer small, safe changes; ask for clarification if needed.\n- If you need to edit files or run commands, do so within current repo.\n- Do not narrate your plan (avoid messages like "I'll do X next").\n- Use tools silently; let the bot's status message reflect progress.\n- When you respond, provide the useful result directly.\n</instructions>`;
    return this.ragContext ? `${this.ragContext}\n\n${baseInstructions}` : baseInstructions;
  }

  private async handleSessionEvent(evt: SessionEvent): Promise<void> {
    if (evt.type === "assistant.message") {
      const content = (evt.data as { content?: string }).content;
      if (content) {
        await this.sendToDiscord(content);

        if (this.currentUserMessage && this.onConversationComplete) {
          this.onConversationComplete(this.currentUserMessage, content);
          this.currentUserMessage = null;
        }
      }
    } else if (evt.type === "tool.execution_start") {
      const data = evt.data as { toolName?: string; toolCallId?: string };
      const label = this.extractToolLabel(data.toolName, data.toolCallId);
      if (!label) {
        await this.sendProgress("Running tool");
      } else if (!isNoisyTool(label)) {
        await this.sendProgress(`Running ${formatToolLabel(label)}`);
      }
    } else if (evt.type === "session.error") {
      const data = evt.data as { message?: string };
      await this.sendToDiscord(
        box("Copilot session error", [{ key: "message", value: data.message ?? "unknown" }], { icon: "X" })
      );
    }
  }

  private extractToolLabel(toolName?: string, toolCallId?: string): string | null {
    const label = toolName || toolCallId;
    if (!label) return null;
    if (label === this.lastToolLabel) return label;
    this.lastToolLabel = label;
    return label;
  }

  async sendUserMessage(userText: string): Promise<CopilotTurnOutcome> {
    if (!this.session) throw new Error("Session not started");

    this.currentUserMessage = userText;

    return new Promise((resolve) => {
      const run = async () => {
        try {
          await this.session!.sendAndWait(
            { prompt: userText },
            this.turnTimeoutMs
          );
          resolve(CopilotTurnOutcome.ok());
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          if (msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("timed out")) {
            resolve(CopilotTurnOutcome.timeout());
          } else {
            resolve(CopilotTurnOutcome.failed(msg));
          }
        } finally {
          this.turnLocked = false;
          const next = this.turnQueue.shift();
          if (next) next();
        }
      };

      if (this.turnLocked) {
        this.turnQueue.push(() => { this.turnLocked = true; void run(); });
      } else {
        this.turnLocked = true;
        void run();
      }
    });
  }

  async abort(): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.abort();
    } catch {
      // ignore
    }
  }

  async dispose(): Promise<void> {
    try { this.unsubscribe?.(); } catch { /* ignore */ }

    if (this.session) {
      try { await this.session.disconnect(); } catch { /* ignore */ }
    }

    if (this.client) {
      try { await this.client.stop(); } catch { /* ignore */ }
    }
  }
}

function looksLikeSessionNotFound(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() ?? "";
  return (
    msg.includes("not found") ||
    msg.includes("unknown session") ||
    msg.includes("session not found") ||
    msg.includes("404")
  );
}

function isNoisyTool(label: string): boolean {
  const lower = label.trim().toLowerCase();
  return lower === "report_intent" || lower === "report-intent";
}

function formatToolLabel(label: string): string {
  label = label.trim();
  // shell(git status) -> git status
  if (label.toLowerCase().startsWith("shell(") && label.endsWith(")")) {
    return label.slice(6, -1);
  }
  // snake_case -> space separated
  if (label.includes("_")) {
    return label.replace(/_/g, " ");
  }
  return label;
}

/** Raw shape from project `.mcp.json` (Copilot / VS Code style). */
interface McpJsonServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  headers?: Record<string, string>;
  tools?: string[];
  cwd?: string;
}

interface McpJsonRoot {
  mcpServers?: Record<string, McpJsonServerEntry>;
}

function findMcpJsonPath(): string | null {
  const cwdCandidate = path.resolve(process.cwd(), ".mcp.json");
  if (existsSync(cwdCandidate)) return cwdCandidate;
  const fromModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".mcp.json");
  if (existsSync(fromModule)) return fromModule;
  return null;
}

function expandEnvPlaceholders(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => process.env[key] ?? "");
}

function expandEnvRecord(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = expandEnvPlaceholders(v);
  }
  return out;
}

function mcpJsonEntryToSdk(_name: string, entry: McpJsonServerEntry): MCPLocalServerConfig | MCPRemoteServerConfig | null {
  const t = (entry.type ?? "").toLowerCase();
  const hasUrl = typeof entry.url === "string" && entry.url.length > 0;

  if (hasUrl || t === "http" || t === "sse") {
    if (!entry.url) return null;
    const remoteType: "http" | "sse" = t === "sse" ? "sse" : "http";
    const cfg: MCPRemoteServerConfig = {
      type: remoteType,
      url: entry.url,
      tools: entry.tools ?? ["*"],
    };
    if (entry.headers && Object.keys(entry.headers).length > 0) {
      const h: Record<string, string> = {};
      for (const [hk, hv] of Object.entries(entry.headers)) {
        h[hk] = expandEnvPlaceholders(hv);
      }
      cfg.headers = h;
    }
    return cfg;
  }

  if (typeof entry.command === "string" && entry.command.length > 0) {
    const local: MCPLocalServerConfig = {
      type: "local",
      command: entry.command,
      args: entry.args ?? [],
      tools: entry.tools ?? ["*"],
    };
    const expanded = expandEnvRecord(entry.env);
    if (expanded && Object.keys(expanded).length > 0) {
      local.env = expanded;
    }
    if (entry.cwd) {
      local.cwd = expandEnvPlaceholders(entry.cwd);
    }
    return local;
  }

  return null;
}

function loadMcpServersFromMcpJson(logger: Logger): Record<string, MCPLocalServerConfig | MCPRemoteServerConfig> {
  const p = findMcpJsonPath();
  if (!p) return {};

  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as McpJsonRoot;
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object") return {};

    const result: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig> = {};
    for (const [name, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== "object") continue;
      const sdk = mcpJsonEntryToSdk(name, entry as McpJsonServerEntry);
      if (sdk) {
        result[name] = sdk;
      } else {
        logger.warn({ server: name, path: p }, "Skipping invalid MCP entry in .mcp.json");
      }
    }
    return result;
  } catch (err) {
    logger.warn({ err, path: p }, "Failed to read or parse .mcp.json");
    return {};
  }
}

function sessionMcpToSdk(
  mcpServers: NonNullable<SessionConfigState["mcpServers"]>
): Record<string, MCPLocalServerConfig | MCPRemoteServerConfig> {
  const result: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig> = {};
  for (const [name, cfg] of Object.entries(mcpServers)) {
    if (cfg.type === "http" || cfg.type === "sse") {
      const remote = cfg as import("../models/SessionConfigState.js").McpRemoteServerConfig;
      result[name] = {
        type: remote.type,
        url: remote.url,
        tools: remote.tools ?? ["*"],
      } as MCPRemoteServerConfig;
    } else {
      const local = cfg as import("../models/SessionConfigState.js").McpLocalServerConfig;
      const out: MCPLocalServerConfig = {
        type: "local",
        command: local.command,
        args: local.args ?? [],
        tools: local.tools ?? ["*"],
      };
      const expanded = expandEnvRecord(local.env);
      if (expanded && Object.keys(expanded).length > 0) {
        out.env = expanded;
      }
      result[name] = out;
    }
  }
  return result;
}

/**
 * Merges project `.mcp.json` with per-session `mcpServers` from SQLite.
 * Session entries override file entries with the same name.
 */
function buildMcpServers(
  mcpServers: SessionConfigState["mcpServers"],
  logger: Logger
): Record<string, MCPLocalServerConfig | MCPRemoteServerConfig> | undefined {
  const fromFile = loadMcpServersFromMcpJson(logger);
  const fromSession = mcpServers ? sessionMcpToSdk(mcpServers) : {};

  const merged: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig> = {
    ...fromFile,
    ...fromSession,
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}
