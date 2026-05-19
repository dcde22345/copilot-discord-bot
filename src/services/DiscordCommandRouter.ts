import {
  Client,
  Message,
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
  TextChannel,
  ThreadChannel,
  ChannelType,
  ThreadAutoArchiveDuration,
} from "discord.js";
import type { Logger } from "pino";
import type { BotConfig } from "../config.js";
import type { AppConfig } from "../appConfig.js";
import type { SqliteSessionStore } from "../data/SqliteSessionStore.js";
import type { SessionRuntimeManager } from "./SessionRuntimeManager.js";
import { box } from "../utils/discordUi.js";
import { chunkForDiscord } from "../utils/textChunker.js";
import { resolveRepoPath, isWithinRoot } from "../utils/pathUtils.js";
import { existsSync, readdirSync } from "fs";
import path from "path";

const REPO_PICK_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

interface RepoPickerState {
  threadId: bigint;
  repoFullPaths: string[];
  createdAt: Date;
  // Stored when the picker was triggered by a mention — sent to Copilot after repo is chosen.
  deferredPrompt?: string;
}

export class DiscordCommandRouter {
  private repoPickers = new Map<string, RepoPickerState>();

  constructor(
    private readonly logger: Logger,
    private readonly config: BotConfig,
    private readonly appConfig: AppConfig,
    private readonly store: SqliteSessionStore,
    private readonly runtimeManager: SessionRuntimeManager,
    private readonly client: Client
  ) {}

  // -------------------------------------------------------------------------
  // Public entry points
  // -------------------------------------------------------------------------

  async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;

    if (
      this.config.OWNER_DISCORD_USER_ID !== 0n &&
      BigInt(message.author.id) !== this.config.OWNER_DISCORD_USER_ID
    ) {
      return;
    }

    const content = (message.content ?? "").trim();
    if (!content) return;

    const isMentioned = this.client.user !== null && message.mentions.has(this.client.user);

    // ------------------------------------------------------------------
    // Messages inside a session thread
    // ------------------------------------------------------------------
    if (message.channel.isThread()) {
      const thread = message.channel as ThreadChannel;

      // cp commands and approve/deny work without a mention.
      const approval = tryParseApproval(content);
      if (approval !== null) {
        const resolved = this.runtimeManager.tryResolvePermission(
          BigInt(thread.id),
          approval.approve,
          approval.toolCallId
        );
        if (resolved) {
          await thread.send(approval.approve ? "Approved" : "Denied");
        } else {
          await thread.send("No pending approval found.");
        }
        return;
      }

      if (isCommand(content)) {
        await this.handleCommand(message, content);
        return;
      }

      // For plain chat in a thread, require a mention.
      if (!isMentioned) return;

      const userPrompt = stripMention(content, this.client.user?.id ?? "");
      if (!userPrompt) return;

      let session = this.store.getByThreadId(BigInt(thread.id));
      if (!session) {
        session = await this.runtimeManager.ensureSessionRecord(thread);
      }

      if (this.appConfig.requireRepoSelection && (!session.repoPath || !existsSync(session.repoPath))) {
        await this.sendRepoPickerToThread(thread, userPrompt);
        await thread.send("Repo not set — pick one above to continue.");
        return;
      }

      await this.runtimeManager.sendUserMessage(thread, session, userPrompt);
      return;
    }

    // ------------------------------------------------------------------
    // Messages in a normal text channel — only act when bot is mentioned
    // ------------------------------------------------------------------
    if (message.channel.type !== ChannelType.GuildText) return;
    if (!isMentioned) return;

    // cp commands still work from a text channel.
    if (isCommand(content)) {
      await this.handleCommand(message, content);
      return;
    }

    const userPrompt = stripMention(content, this.client.user?.id ?? "");
    if (!userPrompt) return;

    await this.createThreadAndRespond(message, userPrompt);
  }

  async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> {
    if (
      this.config.OWNER_DISCORD_USER_ID !== 0n &&
      BigInt(user.id) !== this.config.OWNER_DISCORD_USER_ID
    ) {
      return;
    }

    if (user.id === this.client.user?.id) return;

    const emoji = reaction.emoji.name ?? "";
    const messageId = reaction.message.id;

    if (emoji === "👍" || emoji === "👎") {
      const approve = emoji === "👍";
      const resolved = this.runtimeManager.tryResolvePermissionByPromptMessageId(messageId, approve);
      if (resolved) {
        try {
          const msg = reaction.message.partial
            ? await reaction.message.fetch()
            : reaction.message;
          if (msg) {
            const suffix = approve ? "\nApproved" : "\nDenied";
            await msg.edit(msg.content + suffix);
            try { await msg.reactions.removeAll(); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }

        if (resolved.threadId !== 0n) {
          await this.runtimeManager.notifyApprovalResolved(resolved.threadId);
        }
      }
      return;
    }

    const picker = this.repoPickers.get(messageId);
    if (picker) {
      const idx = REPO_PICK_EMOJIS.indexOf(emoji);
      if (idx < 0 || idx >= picker.repoFullPaths.length) return;

      const pickedPath = picker.repoFullPaths[idx];
      const channel = this.client.channels.cache.get(picker.threadId.toString());
      if (!channel || !channel.isThread()) return;
      const thread = channel as ThreadChannel;

      let record = this.store.getByThreadId(picker.threadId);
      if (!record) {
        record = await this.runtimeManager.ensureSessionRecord(thread);
      }

      if (!existsSync(pickedPath)) {
        await thread.send(box("Repo not found", [{ key: "path", value: pickedPath }], { icon: "X" }));
        return;
      }

      if (!isWithinRoot(pickedPath, this.config.REPOS_ROOT)) {
        await thread.send(
          box(
            "Repo not allowed",
            [{ key: "path", value: pickedPath }, { key: "ReposRoot", value: this.config.REPOS_ROOT }],
            { footer: "Pick a repo under ReposRoot.", icon: "shield" }
          )
        );
        return;
      }

      const updated = { ...record, repoPath: pickedPath, updatedUtc: new Date() };
      this.store.upsert(updated);
      this.runtimeManager.invalidateRuntime(picker.threadId);

      const deferredPrompt = picker.deferredPrompt;
      this.repoPickers.delete(messageId);

      await thread.send(
        box("Repo selected", [{ key: "repo", value: pickedPath }], {
          footer: deferredPrompt ? "Processing your message..." : "Send a message in this thread to chat.",
          icon: "pin",
        })
      );

      // If the user's original message was deferred until repo selection, send it now.
      if (deferredPrompt) {
        await this.runtimeManager.sendUserMessage(thread, updated, deferredPrompt);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async createThreadAndRespond(message: Message, userPrompt: string): Promise<void> {
    const parent = message.channel as TextChannel;
    const name = `copilot-${formatDateUtc(new Date())}`;

    const thread = await parent.threads.create({
      name,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      startMessage: message.id,
      type: ChannelType.PublicThread,
    });

    const session = await this.runtimeManager.ensureSessionRecord(thread);

    if (this.appConfig.requireRepoSelection) {
      await thread.send("**Session created** — pick a repo to begin.");
      await this.sendRepoPickerToThread(thread, userPrompt);
    } else {
      await this.runtimeManager.sendUserMessage(thread, session, userPrompt);
    }
  }

  private async sendRepoPickerToThread(thread: ThreadChannel, deferredPrompt?: string): Promise<void> {
    if (!existsSync(this.config.REPOS_ROOT)) {
      await thread.send(
        box("Repos root missing", [{ key: "ReposRoot", value: this.config.REPOS_ROOT }], {
          footer: "Set `REPOS_ROOT` then retry.",
          icon: "X",
        })
      );
      return;
    }

    const repoPaths = readdirSync(this.config.REPOS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(this.config.REPOS_ROOT, d.name))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .slice(0, REPO_PICK_EMOJIS.length);

    if (repoPaths.length === 0) {
      await thread.send(
        box("No repos found", [{ key: "ReposRoot", value: this.config.REPOS_ROOT }], {
          footer: "Tip: `cp repo <path>` (relative under ReposRoot)",
          icon: "warning",
        })
      );
      return;
    }

    const lines = repoPaths.map((p, i) => `${REPO_PICK_EMOJIS[i]} ${path.basename(p)}`);
    const pickerMessage = await thread.send(
      "**Select repo**\n" +
        "```text\n" +
        lines.join("\n") +
        "\n```\n" +
        "React 1️⃣..🔟 to choose\n" +
        `Tip: \`cp repo <path>\` (relative under \`${this.config.REPOS_ROOT}\`)`
    );

    this.repoPickers.set(pickerMessage.id, {
      threadId: BigInt(thread.id),
      repoFullPaths: repoPaths,
      createdAt: new Date(),
      deferredPrompt,
    });

    try {
      for (let i = 0; i < repoPaths.length; i++) {
        await pickerMessage.react(REPO_PICK_EMOJIS[i]);
      }
    } catch { /* Ignore if missing Add Reactions permission. */ }
  }

  private async handleCommand(message: Message, content: string): Promise<void> {
    const args = trimCommandPrefix(content);
    const [cmd, rest] = splitFirst(args);
    const cmdLower = cmd.toLowerCase();

    if (cmdLower === "" || cmdLower === "help") {
      await replyChunked(
        message.channel,
        box(
          "Copilot bot",
          [
            { key: "mention", value: "@bot <message>  -> create a session thread and chat" },
            { key: "repo", value: "react 1..10 or cp repo <path>" },
            { key: "approve", value: "react thumbsup / thumbsdown when prompted" },
            { key: "model", value: "cp model [id]" },
            { key: "config", value: "cp config show | cp config set {json}" },
            { key: "abort", value: "cp abort" },
            { key: "sessions", value: "cp sessions" },
            { key: "repos", value: "cp repos" },
          ],
          { footer: "Tip: cp commands work inside the session thread.", icon: "bulb" }
        )
      );
      return;
    }

    if (cmdLower === "new") {
      if (message.channel.type !== ChannelType.GuildText) {
        await replyChunked(message.channel, "`cp new` must be used in a normal text channel.");
        return;
      }

      const parent = message.channel as TextChannel;
      const name = rest.trim() || `copilot-${formatDateUtc(new Date())}`;

      const thread = await parent.threads.create({
        name,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        startMessage: message.id,
        type: ChannelType.PublicThread,
      });

      await this.runtimeManager.ensureSessionRecord(thread);

      if (this.appConfig.requireRepoSelection) {
        await thread.send("**Session created** — pick a repo to begin.");
        await this.sendRepoPickerToThread(thread);
      } else {
        await thread.send("**Session created** — mention me to start chatting.");
      }
      return;
    }

    if (cmdLower === "sessions") {
      const sessions = this.store.list();
      if (sessions.length === 0) {
        await replyChunked(message.channel, "No sessions yet. Mention me to start one.");
        return;
      }

      const lines = sessions
        .slice(0, 25)
        .map((s) => `<#${s.threadId}>  repo=${s.repoPath ?? "(unset)"}`);

      await replyChunked(message.channel, "**Sessions**\n```text\n" + lines.join("\n") + "\n```");
      return;
    }

    if (cmdLower === "repos") {
      if (!existsSync(this.config.REPOS_ROOT)) {
        await replyChunked(message.channel, `ReposRoot not found: \`${this.config.REPOS_ROOT}\``);
        return;
      }

      const dirs = readdirSync(this.config.REPOS_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        .slice(0, 50);

      await replyChunked(
        message.channel,
        "**Repos**\n```text\n" + dirs.map((d) => `- ${d}`).join("\n") + "\n```"
      );
      return;
    }

    if (cmdLower === "init") {
      if (!message.channel.isThread()) {
        await replyChunked(message.channel, "`cp init` must be used inside a session thread.");
        return;
      }
      const thread = message.channel as ThreadChannel;
      await this.runtimeManager.ensureSessionRecord(thread);

      if (this.appConfig.requireRepoSelection) {
        await thread.send("**Session ready** — pick a repo to begin.");
        await this.sendRepoPickerToThread(thread);
      } else {
        await thread.send("**Session ready** — mention me to start chatting.");
      }
      return;
    }

    if (cmdLower === "repo") {
      if (!message.channel.isThread()) {
        await replyChunked(message.channel, "`cp repo` must be used inside a session thread.");
        return;
      }
      const thread = message.channel as ThreadChannel;

      if (!rest.trim()) {
        await thread.send("Usage: `cp repo <path>` (relative under ReposRoot)");
        return;
      }

      let record = this.store.getByThreadId(BigInt(thread.id));
      record ??= await this.runtimeManager.ensureSessionRecord(thread);

      const full = resolveRepoPath(this.config.REPOS_ROOT, rest.trim());
      if (!existsSync(full)) {
        await thread.send(`Folder not found: \`${full}\``);
        return;
      }

      if (!isWithinRoot(full, this.config.REPOS_ROOT)) {
        await thread.send("That repo path is outside ReposRoot and is not allowed.");
        return;
      }

      this.store.upsert({ ...record, repoPath: full, updatedUtc: new Date() });
      this.runtimeManager.invalidateRuntime(BigInt(thread.id));

      await thread.send(
        box("Repo selected", [{ key: "repo", value: full }], {
          footer: "Mention me to start chatting.",
          icon: "pin",
        })
      );
      return;
    }

    if (cmdLower === "model") {
      if (!message.channel.isThread()) {
        await replyChunked(message.channel, "`cp model` must be used inside a session thread.");
        return;
      }
      const thread = message.channel as ThreadChannel;

      let record = this.store.getByThreadId(BigInt(thread.id));
      record ??= await this.runtimeManager.ensureSessionRecord(thread);
      const cfg = this.store.readConfig(record);

      if (!rest.trim()) {
        const current = cfg.model ?? this.config.DEFAULT_MODEL;
        await thread.send(
          box("Model", [{ key: "current", value: current }], {
            footer: "Set with: `cp model <modelId>`",
            icon: "brain",
          })
        );
        return;
      }

      cfg.model = rest.trim();
      this.store.upsert({ ...record, configJson: this.store.writeConfig(cfg), updatedUtc: new Date() });
      this.runtimeManager.invalidateRuntime(BigInt(thread.id));
      await thread.send(box("Model updated", [{ key: "model", value: cfg.model }], { icon: "check" }));
      return;
    }

    if (cmdLower === "tools") {
      if (!message.channel.isThread()) {
        await replyChunked(message.channel, "`cp tools` must be used inside a session thread.");
        return;
      }
      const thread = message.channel as ThreadChannel;
      const [sub, toolsArg] = splitFirst(rest);

      let record = this.store.getByThreadId(BigInt(thread.id));
      record ??= await this.runtimeManager.ensureSessionRecord(thread);
      const cfg = this.store.readConfig(record);

      if (sub.toLowerCase() === "allow") {
        cfg.availableTools = parseCsv(toolsArg);
      } else if (sub.toLowerCase() === "exclude") {
        cfg.excludedTools = parseCsv(toolsArg);
      } else {
        await thread.send(
          box(
            "Usage",
            [{ key: "allow", value: "cp tools allow view,edit" }, { key: "exclude", value: "cp tools exclude edit" }],
            { icon: "bulb" }
          )
        );
        return;
      }

      this.store.upsert({ ...record, configJson: this.store.writeConfig(cfg), updatedUtc: new Date() });
      this.runtimeManager.invalidateRuntime(BigInt(thread.id));
      await thread.send("Tool filters updated");
      return;
    }

    if (cmdLower === "config") {
      if (!message.channel.isThread()) {
        await replyChunked(message.channel, "`cp config` must be used inside a session thread.");
        return;
      }
      const thread = message.channel as ThreadChannel;
      const [sub, payload] = splitFirst(rest);

      let record = this.store.getByThreadId(BigInt(thread.id));
      record ??= await this.runtimeManager.ensureSessionRecord(thread);

      if (sub.toLowerCase() === "show") {
        await thread.send(`**Config**\n\`\`\`json\n${record.configJson}\n\`\`\``);
        return;
      }

      if (sub.toLowerCase() === "set") {
        try {
          const cfg = JSON.parse(payload) as Record<string, unknown>;
          if (!cfg || typeof cfg !== "object") throw new Error("Invalid JSON");
          if (!cfg["model"]) cfg["model"] = this.config.DEFAULT_MODEL;
          this.store.upsert({ ...record, configJson: JSON.stringify(cfg, null, 2), updatedUtc: new Date() });
          this.runtimeManager.invalidateRuntime(BigInt(thread.id));
          await thread.send("Config updated");
        } catch (err) {
          await thread.send(`Config JSON invalid: ${(err as Error).message}`);
        }
        return;
      }

      await thread.send("Usage: `cp config show` or `cp config set {json}`");
      return;
    }

    if (cmdLower === "abort") {
      if (!message.channel.isThread()) {
        await replyChunked(message.channel, "`cp abort` must be used inside a session thread.");
        return;
      }
      const thread = message.channel as ThreadChannel;
      await this.runtimeManager.abort(BigInt(thread.id));
      await thread.send("Abort requested");
      return;
    }

    if (cmdLower === "approve") {
      if (!message.channel.isThread()) {
        await replyChunked(message.channel, "`cp approve` must be used inside a session thread.");
        return;
      }
      const thread = message.channel as ThreadChannel;
      const mode = rest.trim().toLowerCase();

      if (mode !== "always" && mode !== "ask") {
        await thread.send(
          box(
            "Approval policy",
            [{ key: "ask", value: "cp approve ask" }, { key: "always", value: "cp approve always" }],
            { footer: "`always` is risky — use only if you trust the repo + tools.", icon: "shield" }
          )
        );
        return;
      }

      let record = this.store.getByThreadId(BigInt(thread.id));
      record ??= await this.runtimeManager.ensureSessionRecord(thread);
      const cfg = this.store.readConfig(record);
      cfg.autoApprovePermissions = mode === "always";
      this.store.upsert({ ...record, configJson: this.store.writeConfig(cfg), updatedUtc: new Date() });

      await thread.send(
        box("Approval policy", [{ key: "mode", value: cfg.autoApprovePermissions ? "always" : "ask" }], {
          icon: cfg.autoApprovePermissions ? "warning" : "check",
        })
      );
      return;
    }

    await replyChunked(message.channel, "Unknown command. Try `cp help`");
  }
}

// -----------------------------------------------------------------------------
// Pure helper functions
// -----------------------------------------------------------------------------

function stripMention(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .trim();
}

function isCommand(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    lower.startsWith("cp ") ||
    lower === "cp" ||
    lower.startsWith("!cp ") ||
    lower === "!cp"
  );
}

function trimCommandPrefix(content: string): string {
  if (content.toLowerCase().startsWith("!cp")) return content.slice(3).trim();
  if (content.toLowerCase().startsWith("cp")) return content.slice(2).trim();
  return content.trim();
}

function splitFirst(text: string): [string, string] {
  text = (text ?? "").trim();
  if (!text) return ["", ""];
  const idx = text.indexOf(" ");
  if (idx < 0) return [text, ""];
  return [text.slice(0, idx), text.slice(idx + 1).trim()];
}

function parseCsv(s: string): string[] {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function tryParseApproval(content: string): { approve: boolean; toolCallId?: string } | null {
  const lower = content.trim().toLowerCase();
  if (lower.startsWith("approve")) {
    const toolCallId = content.length > 7 ? content.slice(7).trim() : undefined;
    return { approve: true, toolCallId: toolCallId || undefined };
  }
  if (lower.startsWith("deny")) {
    const toolCallId = content.length > 4 ? content.slice(4).trim() : undefined;
    return { approve: false, toolCallId: toolCallId || undefined };
  }
  return null;
}

async function replyChunked(channel: Message["channel"], text: string): Promise<void> {
  if (!("send" in channel)) return;
  for (const chunk of chunkForDiscord(text)) {
    await (channel as { send: (text: string) => Promise<unknown> }).send(chunk);
  }
}

function formatDateUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/[T:]|(\..+Z)/g, (m) => (m === "T" ? "-" : m.startsWith(".") ? "" : ""))
    .slice(0, 15);
}
