import { ThreadChannel } from "discord.js";
import type { Logger } from "pino";
import type { BotConfig } from "../config.js";
import type { SqliteSessionStore } from "../data/SqliteSessionStore.js";
import type { SessionRecord } from "../models/SessionRecord.js";
import { defaultSessionConfig } from "../models/SessionConfigState.js";
import { CopilotRuntime, CopilotTurnOutcome } from "./CopilotRuntime.js";
import { EmbeddingService } from "./EmbeddingService.js";
import type {
  PermissionHandler,
  PermissionRequest,
  PermissionRequestResult,
} from "@github/copilot-sdk";
import { box, trimShort } from "../utils/discordUi.js";
import { chunkForDiscord } from "../utils/textChunker.js";
import { normalizeFullPath, isWithinRoot } from "../utils/pathUtils.js";
import path from "path";
import fs from "fs";

interface ActiveTurnStatus {
  thread: ThreadChannel;
  messageId: string;
  startedAt: Date;
  lastUpdateAt: Date;
  state: string;
  repoDisplay: string;
  model: string;
  action: string;
}

interface PendingPermission {
  resolve: (result: PermissionRequestResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PermissionPromptEntry {
  threadId: bigint;
  toolCallId: string;
}

const RUNTIME_START_FAILURE_COOLDOWN_MS = 30_000;

export class SessionRuntimeManager {
  private runtimes = new Map<bigint, CopilotRuntime>();
  private runtimeLocks = new Map<bigint, Promise<CopilotRuntime>>();
  private pendingPermissions = new Map<bigint, Map<string, PendingPermission>>();
  private permissionPromptByMessageId = new Map<string, PermissionPromptEntry>();
  private activeTurnStatus = new Map<bigint, ActiveTurnStatus>();
  private lastRuntimeStartFailureAt = new Map<bigint, Date>();
  private readonly embeddingService: EmbeddingService;

  constructor(
    private readonly logger: Logger,
    private readonly config: BotConfig,
    private readonly store: SqliteSessionStore
  ) {
    this.embeddingService = new EmbeddingService(logger, config);
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(config.DATA_DIR, "copilot"), { recursive: true });
  }

  invalidateRuntime(threadId: bigint): void {
    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      this.runtimes.delete(threadId);
      void runtime.dispose();
    }
  }

  async disposeAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      try { await runtime.dispose(); } catch { /* ignore */ }
    }
    this.runtimes.clear();
  }

  async ensureSessionRecord(thread: ThreadChannel): Promise<SessionRecord> {
    const existing = this.store.getByThreadId(BigInt(thread.id));
    if (existing) return existing;

    const guildId = thread.guildId ? BigInt(thread.guildId) : 0n;
    const parentId = thread.parentId ? BigInt(thread.parentId) : 0n;
    const copilotSessionId = `discord-${guildId}-${thread.id}`;

    const cfg = defaultSessionConfig(this.config.DEFAULT_MODEL);
    cfg.autoApprovePermissions = this.config.DEFAULT_AUTO_APPROVE_PERMISSIONS;

    const now = new Date();
    const record: SessionRecord = {
      threadId: BigInt(thread.id),
      guildId,
      parentChannelId: parentId,
      copilotSessionId,
      repoPath: null,
      configJson: JSON.stringify(cfg, null, 2),
      createdUtc: now,
      updatedUtc: now,
    };

    this.store.upsert(record);
    return record;
  }

  private buildRagContext(relatedConversations: Array<{ userQuestion: string; assistantAnswer: string; distance?: number }>): string {
    if (relatedConversations.length === 0) return "";

    const lines = ["<related_conversations>"];
    for (let i = 0; i < relatedConversations.length; i++) {
      const conv = relatedConversations[i];
      const dateStr = conv.distance
        ? `distance: ${conv.distance.toFixed(4)}`
        : "similar context";
      lines.push(`Conversation ${i + 1} (${dateStr}):`);
      lines.push(`User: ${conv.userQuestion}`);
      lines.push(`Assistant: ${conv.assistantAnswer}`);
      lines.push("");
    }
    lines.push("</related_conversations>");
    return lines.join("\n");
  }

  async sendUserMessage(thread: ThreadChannel, record: SessionRecord, userText: string): Promise<void> {
    let statusMessageId: string | null = null;

    try { await thread.sendTyping(); } catch { /* ignore */ }

    const cfg = this.store.readConfig(record);
    const repoDisplay = this.buildRepoDisplay(record.repoPath);
    const model = cfg.model || this.config.DEFAULT_MODEL;
    const startedAt = new Date();

    try {
      const statusMessage = await thread.send(
        buildStatusMessage({ state: "Working", repoDisplay, model, action: "Searching history...", elapsedSeconds: 0 })
      );
      statusMessageId = statusMessage.id;
      this.activeTurnStatus.set(BigInt(thread.id), {
        thread,
        messageId: statusMessageId,
        startedAt,
        lastUpdateAt: startedAt,
        state: "Working",
        repoDisplay,
        model,
        action: "Searching history...",
      });
    } catch { /* ignore */ }

    let ragContext = "";
    try {
      const queryEmbedding = await this.embeddingService.getEmbedding(userText);
      if (queryEmbedding) {
        const topK = this.config.RAG_TOP_K || 3;
        const relatedConversations = this.store.searchTopKConversations(queryEmbedding, topK);
        this.logger.info({ count: relatedConversations.length }, "Found related conversations");
        ragContext = this.buildRagContext(relatedConversations);
      }
    } catch (err) {
      this.logger.error({ err }, "Failed to search for related conversations");
    }

    try {
      await this.tryUpdateTurnStatus(BigInt(thread.id), { state: "Working", action: "Starting...", force: true });
    } catch { /* ignore */ }

    let outcome: CopilotTurnOutcome = CopilotTurnOutcome.failed("unknown");
    try {
      const runtime = await this.getOrCreateRuntime(thread, record, ragContext);
      outcome = await runtime.sendUserMessage(userText);
    } catch (err) {
      await this.tryUpdateTurnStatus(BigInt(thread.id), { state: "Failed", action: (err as Error).message, force: true });
      outcome = CopilotTurnOutcome.failed((err as Error).message);
    }

    const finalState = outcome.success
      ? "Done"
      : outcome.timedOut
      ? "Timed out"
      : "Failed";

    const finalAction = outcome.success
      ? "Completed"
      : outcome.timedOut
      ? "Timed out (try `cp abort`)"
      : outcome.errorMessage
      ? trimShort(outcome.errorMessage, 120)
      : "Error";

    await this.tryUpdateTurnStatus(BigInt(thread.id), { state: finalState, action: finalAction, force: true });
    this.activeTurnStatus.delete(BigInt(thread.id));

    if (!statusMessageId && !outcome.success) {
      const icon = outcome.timedOut ? "timer" : "X";
      const title = outcome.timedOut ? "Timed out" : "Failed";
      await thread.send(
        box(title, [
          { key: "repo", value: trimShort(repoDisplay, 80) },
          { key: "model", value: trimShort(model, 40) },
          { key: "detail", value: trimShort(finalAction, 180) },
        ], { icon })
      );
    }
  }

  async updateTurnProgress(threadId: bigint, progressText: string): Promise<void> {
    await this.tryUpdateTurnStatus(threadId, { state: "Working", action: progressText });
  }

  async notifyWaitingForApproval(threadId: bigint, permissionKind: string): Promise<void> {
    await this.tryUpdateTurnStatus(threadId, { state: "Waiting", action: permissionKind, force: true });
  }

  async notifyApprovalResolved(threadId: bigint): Promise<void> {
    await this.tryUpdateTurnStatus(threadId, { state: "Working", action: "Resuming...", force: true });
  }

  private async tryUpdateTurnStatus(
    threadId: bigint,
    options: { state?: string; action?: string; force?: boolean }
  ): Promise<void> {
    const st = this.activeTurnStatus.get(threadId);
    if (!st) return;

    const now = new Date();
    if (!options.force && now.getTime() - st.lastUpdateAt.getTime() < 1000) return;

    const nextState = options.state || st.state;
    const nextAction = options.action || st.action;
    const elapsedSeconds = Math.max(0, Math.round((now.getTime() - st.startedAt.getTime()) / 1000));

    const content = buildStatusMessage({
      state: nextState,
      repoDisplay: st.repoDisplay,
      model: st.model,
      action: nextAction,
      elapsedSeconds,
    });

    try {
      const msg = await st.thread.messages.fetch(st.messageId);
      await msg.edit(content);
      this.activeTurnStatus.set(threadId, {
        ...st,
        lastUpdateAt: now,
        state: nextState,
        action: nextAction,
      });
    } catch { /* ignore */ }
  }

  async abort(threadId: bigint): Promise<void> {
    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      await runtime.abort();
    }
  }

  tryResolvePermission(threadId: bigint, approve: boolean, toolCallId?: string): boolean {
    const dict = this.pendingPermissions.get(threadId);
    if (!dict) return false;

    const kind: PermissionRequestResult["kind"] = approve
      ? "approved"
      : "denied-interactively-by-user";

    if (toolCallId) {
      const pending = dict.get(toolCallId);
      if (pending) {
        clearTimeout(pending.timer);
        dict.delete(toolCallId);
        pending.resolve({ kind });
        return true;
      }
      return false;
    }

    // No id provided: resolve the oldest pending entry.
    const firstKey = dict.keys().next().value as string | undefined;
    if (firstKey === undefined) return false;

    const pending = dict.get(firstKey);
    if (pending) {
      clearTimeout(pending.timer);
      dict.delete(firstKey);
      pending.resolve({ kind });
      return true;
    }

    return false;
  }

  tryResolvePermissionByPromptMessageId(
    promptMessageId: string,
    approve: boolean
  ): { threadId: bigint } | null {
    const entry = this.permissionPromptByMessageId.get(promptMessageId);
    if (!entry) return null;

    this.permissionPromptByMessageId.delete(promptMessageId);
    const resolved = this.tryResolvePermission(entry.threadId, approve, entry.toolCallId);
    return resolved ? { threadId: entry.threadId } : null;
  }

  buildPermissionHandler(thread: ThreadChannel, cfg: ReturnType<SqliteSessionStore["readConfig"]>): PermissionHandler {
    return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
      const autoApprove = cfg.autoApprovePermissions ?? this.config.DEFAULT_AUTO_APPROVE_PERMISSIONS;
      if (autoApprove) return { kind: "approved" };

      const kindLower = (request.kind ?? "").toLowerCase();
      if (this.config.AUTO_APPROVE_READ_PERMISSIONS && looksLikeReadOnly(kindLower)) {
        return { kind: "approved" };
      }

      const toolCallId = (request as { toolCallId?: string }).toolCallId ?? crypto.randomUUID();
      const threadId = BigInt(thread.id);
      const perThread = this.pendingPermissions.get(threadId) ?? new Map<string, PendingPermission>();
      this.pendingPermissions.set(threadId, perThread);

      // Set up the deferred result first, then show UI.
      let resolvePermission!: (result: PermissionRequestResult) => void;
      const resultPromise = new Promise<PermissionRequestResult>((resolve) => {
        resolvePermission = resolve;
      });

      const timer = setTimeout(() => {
        perThread.delete(toolCallId);
        resolvePermission({ kind: "denied-interactively-by-user" });
      }, 10 * 60 * 1000);

      perThread.set(toolCallId, { resolve: resolvePermission, timer });

      // Show the UI.
      const kind = request.kind ?? "permission";
      const detail = buildPermissionDetail(request);
      await this.notifyWaitingForApproval(threadId, `${kind}: ${trimShort(detail, 80)}`);

      try {
        const promptMessage = await thread.send(
          box(
            "Permission required",
            [{ key: "kind", value: kind }, { key: "detail", value: detail }],
            { footer: "React thumbsup / thumbsdown", icon: "pause" }
          )
        );

        this.permissionPromptByMessageId.set(promptMessage.id, { threadId, toolCallId });

        try {
          await promptMessage.react("👍");
          await promptMessage.react("👎");
        } catch { /* ignore */ }
      } catch { /* ignore */ }

      return resultPromise;
    };
  }

  private async getOrCreateRuntime(thread: ThreadChannel, record: SessionRecord, ragContext: string = ""): Promise<CopilotRuntime> {
    const cached = this.runtimes.get(BigInt(thread.id));
    if (cached) return cached;

    const existing = this.runtimeLocks.get(BigInt(thread.id));
    if (existing) return existing;

    const createPromise = this.createRuntime(thread, record, ragContext)
      .then((rt) => {
        this.runtimeLocks.delete(BigInt(thread.id));
        return rt;
      })
      .catch((err) => {
        this.runtimeLocks.delete(BigInt(thread.id));
        throw err;
      });

    this.runtimeLocks.set(BigInt(thread.id), createPromise);
    return createPromise;
  }

  private async createRuntime(thread: ThreadChannel, record: SessionRecord, ragContext: string = ""): Promise<CopilotRuntime> {
    const lastFail = this.lastRuntimeStartFailureAt.get(BigInt(thread.id));
    if (lastFail && Date.now() - lastFail.getTime() < RUNTIME_START_FAILURE_COOLDOWN_MS) {
      throw new Error("Copilot runtime previously failed to start; retrying shortly.");
    }

    const cfg = this.store.readConfig(record);
    const repoPath = record.repoPath;
    let cwd = repoPath || this.config.REPOS_ROOT;
    cwd = normalizeFullPath(cwd);

    if (!isWithinRoot(cwd, this.config.REPOS_ROOT)) {
      cwd = normalizeFullPath(this.config.REPOS_ROOT);
    }

    const sendToDiscord = async (text: string): Promise<void> => {
      for (const chunk of chunkForDiscord(text)) {
        try { await thread.send(chunk); } catch { /* ignore */ }
      }
    };

    const sendProgress = async (progressText: string): Promise<void> => {
      await this.updateTurnProgress(BigInt(thread.id), progressText);
    };

    const onConversationComplete = async (userQuestion: string, assistantAnswer: string): Promise<void> => {
      try {
        const embedding = await this.embeddingService.getCombinedEmbedding(userQuestion, assistantAnswer);
        if (embedding) {
          const embeddingBuffer = Buffer.from(embedding.buffer);
          this.store.saveConversationUnit(
            record.threadId.toString(),
            userQuestion,
            assistantAnswer,
            embeddingBuffer
          );
          this.logger.debug({ threadId: record.threadId.toString() }, "Saved conversation unit");
        }
      } catch (err) {
        this.logger.error({ err }, "Failed to save conversation unit");
      }
    };

    const runtime = new CopilotRuntime(
      this.logger,
      record,
      cfg,
      cwd,
      this.config.COPILOT_CLI_PATH,
      this.config.TURN_TIMEOUT_SECONDS * 1000,
      sendToDiscord,
      sendProgress,
      this.buildPermissionHandler(thread, cfg),
      onConversationComplete,
      ragContext
    );

    if (ragContext) {
      try {
        await this.updateTurnProgress(BigInt(thread.id), "Applying RAG context...");
      } catch (err) {
        this.logger.error({ err }, "Failed to apply RAG context");
      }
    }

    try {
      await runtime.start();
      this.runtimes.set(BigInt(thread.id), runtime);
      this.lastRuntimeStartFailureAt.delete(BigInt(thread.id));
      return runtime;
    } catch (err) {
      this.lastRuntimeStartFailureAt.set(BigInt(thread.id), new Date());
      throw err;
    }
  }

  private buildRepoDisplay(repoPath: string | null): string {
    if (!repoPath) return "(unset)";
    try {
      const full = normalizeFullPath(repoPath);
      if (isWithinRoot(full, this.config.REPOS_ROOT)) {
        const rel = path.relative(this.config.REPOS_ROOT, full);
        return rel.replace(/\\/g, "/");
      }
      return path.basename(full);
    } catch {
      return repoPath;
    }
  }
}

function buildStatusMessage(options: {
  state: string;
  repoDisplay: string;
  model: string;
  action: string;
  elapsedSeconds: number;
}): string {
  const { state, repoDisplay, model, action, elapsedSeconds } = options;

  const icon =
    state === "Done" ? "check" :
    state === "Failed" ? "X" :
    state === "Timed out" ? "timer" :
    state === "Waiting" ? "pause" :
    "hourglass";

  return box(
    state,
    [
      { key: "elapsed", value: `${elapsedSeconds}s` },
      { key: "repo", value: trimShort(repoDisplay, 80) },
      { key: "model", value: trimShort(model, 40) },
      { key: "doing", value: trimShort(action, 220) },
    ],
    { icon }
  );
}

function looksLikeReadOnly(kindLower: string): boolean {
  if (!kindLower) return false;
  if (
    kindLower.includes("write") ||
    kindLower.includes("delete") ||
    kindLower.includes("exec") ||
    kindLower.includes("run")
  ) {
    return false;
  }
  return kindLower === "read" || kindLower.startsWith("read");
}

function buildPermissionDetail(request: PermissionRequest): string {
  const extra = request as Record<string, unknown>;
  const filePath = extra["path"] ?? extra["filePath"] ?? extra["targetPath"];
  const url = extra["url"] ?? extra["URL"];
  const command = extra["command"] ?? extra["commandLine"] ?? extra["cmd"];

  if (command && typeof command === "string") return `command: ${trimShort(command, 160)}`;
  if (filePath && typeof filePath === "string") return `path: ${trimShort(filePath, 180)}`;
  if (url && typeof url === "string") return `url: ${trimShort(url, 180)}`;
  return `kind: ${request.kind}`;
}
