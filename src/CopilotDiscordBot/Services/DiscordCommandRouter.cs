using CopilotDiscordBot.Data;
using CopilotDiscordBot.Models;
using CopilotDiscordBot.Utils;
using Discord;
using Discord.WebSocket;
using Microsoft.Extensions.Logging;
using System.Collections.Concurrent;
using System.Text.Json;

namespace CopilotDiscordBot.Services;

public sealed class DiscordCommandRouter
{
    private readonly ILogger _logger;
    private readonly BotOptions _options;
    private readonly SqliteSessionStore _store;
    private readonly SessionRuntimeManager _runtimeManager;
    private readonly DiscordSocketClient _client;

    private readonly ConcurrentDictionary<ulong, RepoPickerState> _repoPickers = new();

    private static readonly string[] RepoPickEmojis =
    [
        "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"
    ];

    public DiscordCommandRouter(
        ILogger logger,
        BotOptions options,
        SqliteSessionStore store,
        SessionRuntimeManager runtimeManager,
        DiscordSocketClient client)
    {
        _logger = logger;
        _options = options;
        _store = store;
        _runtimeManager = runtimeManager;
        _client = client;

        Directory.CreateDirectory(_options.DataDir);
    }

    private sealed record RepoPickerState(
        ulong ThreadId,
        IReadOnlyList<string> RepoFullPaths,
        DateTimeOffset CreatedUtc);

    private async Task SendRepoPickerAsync(SocketThreadChannel thread)
    {
        if (!Directory.Exists(_options.ReposRoot))
        {
            await thread.SendMessageAsync(DiscordUi.Box(
                "Repos root missing",
                [("ReposRoot", _options.ReposRoot)],
                footer: "Set `Bot:ReposRoot` then retry.",
                icon: "❌"));
            return;
        }

        var repoPaths = Directory.GetDirectories(_options.ReposRoot)
            .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
            .Take(RepoPickEmojis.Length)
            .ToList();

        if (repoPaths.Count == 0)
        {
            await thread.SendMessageAsync(DiscordUi.Box(
                "No repos found",
                [("ReposRoot", _options.ReposRoot)],
                footer: "Tip: `cp repo <path>` (relative under ReposRoot)",
                icon: "⚠️"));
            return;
        }

        var lines = repoPaths
            .Select((p, i) => $"{RepoPickEmojis[i]} {Path.GetFileName(p)}")
            .ToList();

        var pickerMessage = await thread.SendMessageAsync(
            "🗂️ **Select repo**\n" +
            "```text\n" +
            string.Join("\n", lines) +
            "\n```\n" +
            "React 1️⃣..🔟 to choose\n" +
            $"Tip: `cp repo <path>` (relative under `{_options.ReposRoot}`)");

        _repoPickers[pickerMessage.Id] = new RepoPickerState(thread.Id, repoPaths, DateTimeOffset.UtcNow);

        try
        {
            // Pre-add reactions for easy mobile selection.
            for (var i = 0; i < repoPaths.Count; i++)
            {
                await pickerMessage.AddReactionAsync(new Emoji(RepoPickEmojis[i]));
            }
        }
        catch
        {
            // Ignore if missing Add Reactions permission.
        }
    }

    public async Task HandleMessageAsync(SocketMessage raw)
    {
        if (raw is not SocketUserMessage message) return;
        if (message.Author.IsBot) return;

        if (_options.OwnerDiscordUserId != 0 && message.Author.Id != _options.OwnerDiscordUserId)
        {
            // Ignore non-owner.
            return;
        }

        var content = (message.Content ?? string.Empty).Trim();
        if (content.Length == 0) return;

        // First: resolve permission approvals in-thread.
        if (raw.Channel is SocketThreadChannel threadChannel)
        {
            if (TryParseApproval(content, out var approve, out var toolCallId))
            {
                if (_runtimeManager.TryResolvePermission(threadChannel.Id, approve, toolCallId))
                {
                    await threadChannel.SendMessageAsync(approve ? "✅ Approved" : "❌ Denied");
                }
                else
                {
                    await threadChannel.SendMessageAsync("⚠️ No pending approval found.");
                }
                return;
            }
        }

        if (IsCommand(content))
        {
            await HandleCommandAsync(message, content);
            return;
        }

        // Default: in a session thread, forward the message to Copilot.
        if (raw.Channel is SocketThreadChannel sessionThread)
        {
            var session = await _store.GetByThreadIdAsync(sessionThread.Id);
            if (session is null)
            {
                // Auto-bind: threads are sessions.
                session = await _runtimeManager.EnsureSessionRecordAsync(sessionThread, sessionThread.ParentChannel);
            }

            // If repo isn't set, prompt with emoji repo picker before running tools.
            if (string.IsNullOrWhiteSpace(session.RepoPath) || !Directory.Exists(session.RepoPath))
            {
                await SendRepoPickerAsync(sessionThread);
                await sessionThread.SendMessageAsync("⏸️ **Repo not set** — pick one above to continue.");
                return;
            }

            await _runtimeManager.SendUserMessageAsync(_client, sessionThread, session, content);
            return;
        }

        // Not a command and not a session thread: ignore.
    }

    public async Task HandleReactionAsync(
        Cacheable<IUserMessage, ulong> cachedMessage,
        Cacheable<IMessageChannel, ulong> cachedChannel,
        SocketReaction reaction)
    {
        // Owner-only for safety.
        if (_options.OwnerDiscordUserId != 0 && reaction.UserId != _options.OwnerDiscordUserId)
        {
            return;
        }

        // Ignore bot's own pre-added reactions.
        if (reaction.UserId == _client.CurrentUser.Id) return;

        var emoji = reaction.Emote.Name;
        var messageId = cachedMessage.Id;

        if (emoji is "👍" or "👎")
        {
            var approve = emoji == "👍";
            if (_runtimeManager.TryResolvePermissionByPromptMessageId(messageId, approve, out var threadId))
            {
                try
                {
                    var msg = await cachedMessage.GetOrDownloadAsync();
                    if (msg != null)
                    {
                        var suffix = approve ? "\n✅ Approved" : "\n❌ Denied";
                        await msg.ModifyAsync(m => m.Content = msg.Content + suffix);
                        try { await msg.RemoveAllReactionsAsync(); } catch { }
                    }
                }
                catch
                {
                    // ignore
                }

                if (threadId != 0)
                {
                    await _runtimeManager.NotifyApprovalResolvedAsync(_client, threadId);
                }
            }
            return;
        }

        if (_repoPickers.TryGetValue(messageId, out var picker))
        {
            var idx = Array.IndexOf(RepoPickEmojis, emoji);
            if (idx < 0) return;
            if (idx >= picker.RepoFullPaths.Count) return;

            var pickedPath = picker.RepoFullPaths[idx];

            var thread = _client.GetChannel(picker.ThreadId) as SocketThreadChannel;
            if (thread is null) return;

            var record = await _store.GetByThreadIdAsync(picker.ThreadId);
            if (record is null)
            {
                // Auto-bind if missing.
                record = await _runtimeManager.EnsureSessionRecordAsync(thread, thread.ParentChannel);
            }

            if (!Directory.Exists(pickedPath))
            {
                await thread.SendMessageAsync(DiscordUi.Box(
                    "Repo not found",
                    [("path", pickedPath)],
                    icon: "❌"));
                return;
            }

            if (!PathUtils.IsWithinRoot(pickedPath, _options.ReposRoot))
            {
                await thread.SendMessageAsync(DiscordUi.Box(
                    "Repo not allowed",
                    [("path", pickedPath), ("ReposRoot", _options.ReposRoot)],
                    footer: "Pick a repo under ReposRoot.",
                    icon: "🛡️"));
                return;
            }

            var updated = record with { RepoPath = pickedPath, UpdatedUtc = DateTimeOffset.UtcNow };
            await _store.UpsertAsync(updated);
            _runtimeManager.InvalidateRuntime(thread.Id);

            _repoPickers.TryRemove(messageId, out _);

            await thread.SendMessageAsync(DiscordUi.Box(
                "Repo selected",
                [("repo", pickedPath)],
                footer: "Send a message in this thread to chat.",
                icon: "📌"));
            return;
        }
    }

    private static bool IsCommand(string content)
    {
        return content.StartsWith("cp ", StringComparison.OrdinalIgnoreCase)
            || content.Equals("cp", StringComparison.OrdinalIgnoreCase)
            || content.StartsWith("!cp ", StringComparison.OrdinalIgnoreCase)
            || content.Equals("!cp", StringComparison.OrdinalIgnoreCase);
    }

    private static string TrimCommandPrefix(string content)
    {
        if (content.StartsWith("!cp", StringComparison.OrdinalIgnoreCase))
            return content[3..].Trim();
        if (content.StartsWith("cp", StringComparison.OrdinalIgnoreCase))
            return content[2..].Trim();
        return content.Trim();
    }

    private async Task HandleCommandAsync(SocketUserMessage message, string content)
    {
        var args = TrimCommandPrefix(content);
        var (cmd, rest) = SplitFirst(args);
        cmd = cmd.ToLowerInvariant();

        if (cmd is "" or "help")
        {
            await ReplyAsync(message.Channel, DiscordUi.Box(
                "Copilot bot",
                [
                    ("new", "cp new [name]  → create a session thread"),
                    ("repo", "react 1️⃣..🔟 or cp repo <path>"),
                    ("chat", "send messages in the thread"),
                    ("approve", "react 👍 / 👎 when prompted"),
                    ("model", "cp model [id]"),
                    ("config", "cp config show | cp config set {json}"),
                    ("abort", "cp abort"),
                    ("sessions", "cp sessions"),
                    ("repos", "cp repos")
                ],
                footer: "Tip: most commands must be run inside the session thread.",
                icon: "💡"));
            return;
        }

        if (cmd == "new")
        {
            if (message.Channel is not SocketTextChannel parent)
            {
                await ReplyAsync(message.Channel, "⚠️ `cp new` must be used in a normal text channel.");
                return;
            }

            var name = string.IsNullOrWhiteSpace(rest)
                ? $"copilot-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}"
                : rest;

            // Create a public thread from this message.
            // Signature: CreateThreadAsync(name, type, autoArchiveDuration, message, ...)
            var thread = await parent.CreateThreadAsync(name, ThreadType.PublicThread, ThreadArchiveDuration.OneDay, message);

            var record = await _runtimeManager.EnsureSessionRecordAsync(thread, parent);

            await thread.SendMessageAsync("✅ **Session created**\nPick a repo to begin.");
            await SendRepoPickerAsync(thread);
            return;
        }

        if (cmd == "sessions")
        {
            var sessions = await _store.ListAsync();
            if (sessions.Count == 0)
            {
                await ReplyAsync(message.Channel, "No sessions yet. Use `cp new`." );
                return;
            }

            var lines = sessions.Take(25)
                .Select(s => $"<#{s.ThreadId}>  repo={(s.RepoPath ?? "(unset)")}")
                .ToList();

            await ReplyAsync(message.Channel,
                "🧵 **Sessions**\n```text\n" + string.Join("\n", lines) + "\n```");
            return;
        }

        if (cmd == "repos")
        {
            if (!Directory.Exists(_options.ReposRoot))
            {
                await ReplyAsync(message.Channel, $"❌ ReposRoot not found: `{_options.ReposRoot}`");
                return;
            }

            var dirs = Directory.GetDirectories(_options.ReposRoot)
                .Select(Path.GetFileName)
                .Where(n => !string.IsNullOrWhiteSpace(n))
                .OrderBy(n => n)
                .Take(50);

            await ReplyAsync(message.Channel,
                "🗂️ **Repos**\n```text\n" + string.Join("\n", dirs.Select(d => $"- {d}")) + "\n```");
            return;
        }

        if (cmd == "init")
        {
            if (message.Channel is not SocketThreadChannel thread)
            {
                await ReplyAsync(message.Channel, "⚠️ `cp init` must be used inside a session thread." );
                return;
            }

            _ = await _runtimeManager.EnsureSessionRecordAsync(thread, thread.ParentChannel);
            await thread.SendMessageAsync("✅ **Session ready**\nPick a repo to begin.");
            await SendRepoPickerAsync(thread);
            return;
        }

        if (cmd == "repo")
        {
            if (message.Channel is not SocketThreadChannel thread)
            {
                await ReplyAsync(message.Channel, "⚠️ `cp repo` must be used inside a session thread." );
                return;
            }

            if (string.IsNullOrWhiteSpace(rest))
            {
                await thread.SendMessageAsync("Usage: `cp repo <path>` (relative under ReposRoot)" );
                return;
            }

            var record = await _store.GetByThreadIdAsync(thread.Id);
            record ??= await _runtimeManager.EnsureSessionRecordAsync(thread, thread.ParentChannel);

            var full = PathUtils.ResolveRepoPath(_options.ReposRoot, rest);
            if (!Directory.Exists(full))
            {
                await thread.SendMessageAsync($"❌ Folder not found: `{full}`" );
                return;
            }

            if (!PathUtils.IsWithinRoot(full, _options.ReposRoot))
            {
                await thread.SendMessageAsync("That repo path is outside ReposRoot and is not allowed.");
                return;
            }

            var updated = record with { RepoPath = full, UpdatedUtc = DateTimeOffset.UtcNow };
            await _store.UpsertAsync(updated);
            _runtimeManager.InvalidateRuntime(thread.Id);

            await thread.SendMessageAsync(DiscordUi.Box(
                "Repo selected",
                [("repo", full)],
                footer: "Send a message in this thread to chat.",
                icon: "📌"));
            return;
        }

        if (cmd == "model")
        {
            if (message.Channel is not SocketThreadChannel thread)
            {
                await ReplyAsync(message.Channel, "⚠️ `cp model` must be used inside a session thread." );
                return;
            }

            var record = await _store.GetByThreadIdAsync(thread.Id);
            record ??= await _runtimeManager.EnsureSessionRecordAsync(thread, thread.ParentChannel);

            var cfg = _store.ReadConfig(record);

            if (string.IsNullOrWhiteSpace(rest))
            {
                var current = cfg.Model ?? _options.DefaultModel;
                await thread.SendMessageAsync(DiscordUi.Box(
                    "Model",
                    [("current", current)],
                    footer: "Set with: `cp model <modelId>`",
                    icon: "🧠"));
                return;
            }

            cfg.Model = rest.Trim();
            var updated = record with { ConfigJson = _store.WriteConfig(cfg), UpdatedUtc = DateTimeOffset.UtcNow };
            await _store.UpsertAsync(updated);
            _runtimeManager.InvalidateRuntime(thread.Id);
            await thread.SendMessageAsync(DiscordUi.Box(
                "Model updated",
                [("model", cfg.Model ?? _options.DefaultModel)],
                icon: "✅"));
            return;
        }

        if (cmd == "tools")
        {
            if (message.Channel is not SocketThreadChannel thread)
            {
                await ReplyAsync(message.Channel, "⚠️ `cp tools` must be used inside a session thread.");
                return;
            }

            var (sub, toolsArg) = SplitFirst(rest);
            sub = sub.ToLowerInvariant();

            var record = await _store.GetByThreadIdAsync(thread.Id);
            record ??= await _runtimeManager.EnsureSessionRecordAsync(thread, thread.ParentChannel);

            var cfg = _store.ReadConfig(record);
            var list = ParseCsv(toolsArg);

            if (sub == "allow") cfg.AvailableTools = list;
            else if (sub == "exclude") cfg.ExcludedTools = list;
            else
            {
                await thread.SendMessageAsync(DiscordUi.Box(
                    "Usage",
                    [("allow", "cp tools allow view,edit"), ("exclude", "cp tools exclude edit")],
                    icon: "💡"));
                return;
            }

            var updated = record with { ConfigJson = _store.WriteConfig(cfg), UpdatedUtc = DateTimeOffset.UtcNow };
            await _store.UpsertAsync(updated);
            _runtimeManager.InvalidateRuntime(thread.Id);

            await thread.SendMessageAsync("✅ Tool filters updated" );
            return;
        }

        if (cmd == "config")
        {
            var (sub, payload) = SplitFirst(rest);
            sub = sub.ToLowerInvariant();

            if (message.Channel is not SocketThreadChannel thread)
            {
                await ReplyAsync(message.Channel, "⚠️ `cp config` must be used inside a session thread.");
                return;
            }

            var record = await _store.GetByThreadIdAsync(thread.Id);
            record ??= await _runtimeManager.EnsureSessionRecordAsync(thread, thread.ParentChannel);

            if (sub == "show")
            {
                await thread.SendMessageAsync($"⚙️ **Config**\n```json\n{record.ConfigJson}\n```" );
                return;
            }

            if (sub == "set")
            {
                try
                {
                    var cfg = JsonSerializer.Deserialize<SessionConfigState>(payload, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                    if (cfg is null) throw new Exception("Invalid JSON");

                    // Preserve default model if omitted.
                    if (string.IsNullOrWhiteSpace(cfg.Model)) cfg.Model = _options.DefaultModel;

                    var updated = record with { ConfigJson = JsonSerializer.Serialize(cfg, new JsonSerializerOptions { WriteIndented = true }), UpdatedUtc = DateTimeOffset.UtcNow };
                    await _store.UpsertAsync(updated);
                    _runtimeManager.InvalidateRuntime(thread.Id);
                    await thread.SendMessageAsync("✅ Config updated" );
                }
                catch (Exception ex)
                {
                    await thread.SendMessageAsync($"❌ Config JSON invalid: {ex.Message}" );
                }
                return;
            }

            await thread.SendMessageAsync("Usage: `cp config show` or `cp config set {json}`" );
            return;
        }

        if (cmd == "abort")
        {
            if (message.Channel is not SocketThreadChannel thread)
            {
                await ReplyAsync(message.Channel, "⚠️ `cp abort` must be used inside a session thread." );
                return;
            }

            await _runtimeManager.AbortAsync(thread.Id);
            await thread.SendMessageAsync("🛑 Abort requested" );
            return;
        }

        if (cmd == "approve")
        {
            if (message.Channel is not SocketThreadChannel thread)
            {
                await ReplyAsync(message.Channel, "⚠️ `cp approve` must be used inside a session thread." );
                return;
            }

            var mode = (rest ?? string.Empty).Trim().ToLowerInvariant();
            if (mode is not ("always" or "ask"))
            {
                await thread.SendMessageAsync(DiscordUi.Box(
                    "Approval policy",
                    [("ask", "cp approve ask"), ("always", "cp approve always")],
                    footer: "`always` is risky — use only if you trust the repo + tools.",
                    icon: "🛡️"));
                return;
            }

            var record = await _store.GetByThreadIdAsync(thread.Id);
            record ??= await _runtimeManager.EnsureSessionRecordAsync(thread, thread.ParentChannel);

            var cfg = _store.ReadConfig(record);
            cfg.AutoApprovePermissions = mode == "always";
            var updated = record with { ConfigJson = _store.WriteConfig(cfg), UpdatedUtc = DateTimeOffset.UtcNow };
            await _store.UpsertAsync(updated);
            await thread.SendMessageAsync(DiscordUi.Box(
                "Approval policy",
                [("mode", cfg.AutoApprovePermissions == true ? "always" : "ask")],
                icon: cfg.AutoApprovePermissions == true ? "⚠️" : "✅"));
            return;
        }

        await ReplyAsync(message.Channel, "❓ Unknown command. Try `cp help`" );
    }

    private static (string first, string rest) SplitFirst(string text)
    {
        text = (text ?? string.Empty).Trim();
        if (text.Length == 0) return ("", "");
        var idx = text.IndexOf(' ');
        if (idx < 0) return (text, "");
        return (text[..idx], text[(idx + 1)..].Trim());
    }

    private static List<string> ParseCsv(string s)
        => (s ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .ToList();

    private static async Task ReplyAsync(ISocketMessageChannel channel, string text)
    {
        foreach (var chunk in TextChunker.ChunkForDiscord(text))
        {
            await channel.SendMessageAsync(chunk);
        }
    }

    private static bool TryParseApproval(string content, out bool approve, out string? toolCallId)
    {
        approve = false;
        toolCallId = null;

        var lower = content.Trim().ToLowerInvariant();
        if (lower.StartsWith("approve"))
        {
            approve = true;
            toolCallId = content.Length > 7 ? content[7..].Trim() : null;
            return true;
        }
        if (lower.StartsWith("deny"))
        {
            approve = false;
            toolCallId = content.Length > 4 ? content[4..].Trim() : null;
            return true;
        }
        return false;
    }
}
