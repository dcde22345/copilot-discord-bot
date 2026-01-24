using CopilotDiscordBot.Data;
using CopilotDiscordBot.Models;
using CopilotDiscordBot.Utils;
using Discord;
using Discord.WebSocket;
using GitHub.Copilot.SDK;
using Microsoft.Extensions.Options;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace CopilotDiscordBot.Services;

public sealed class SessionRuntimeManager
{
    private readonly ILogger<SessionRuntimeManager> _logger;
    private readonly BotOptions _options;
    private readonly SqliteSessionStore _store;

    private readonly ConcurrentDictionary<ulong, CopilotRuntime> _runtimes = new();
    private readonly ConcurrentDictionary<ulong, SemaphoreSlim> _runtimeLocks = new();
    private readonly ConcurrentDictionary<ulong, ConcurrentDictionary<string, TaskCompletionSource<PermissionRequestResult>>> _pendingPermissions = new();
    private readonly ConcurrentDictionary<ulong, (ulong threadId, string toolCallId)> _permissionPromptByMessageId = new();

    private readonly ConcurrentDictionary<ulong, ActiveTurnStatus> _activeTurnStatusByThreadId = new();

    private readonly ConcurrentDictionary<ulong, DateTimeOffset> _lastRuntimeStartFailureUtc = new();
    private readonly TimeSpan _runtimeStartFailureCooldown = TimeSpan.FromSeconds(30);

    private sealed record ActiveTurnStatus(
        ulong MessageId,
        DateTimeOffset StartedUtc,
        DateTimeOffset LastUpdateUtc,
        string State,
        string RepoDisplay,
        string Model,
        string Action);

    public SessionRuntimeManager(
        ILogger<SessionRuntimeManager> logger,
        IOptions<BotOptions> options,
        SqliteSessionStore store)
    {
        _logger = logger;
        _options = options.Value;
        _store = store;

        Directory.CreateDirectory(_options.DataDir);
        Directory.CreateDirectory(Path.Combine(_options.DataDir, "copilot"));
    }

    public void InvalidateRuntime(ulong threadId)
    {
        if (_runtimes.TryRemove(threadId, out var runtime))
        {
            _ = runtime.DisposeAsync();
        }
    }

    public async Task DisposeAllAsync()
    {
        foreach (var kvp in _runtimes)
        {
            try { await kvp.Value.DisposeAsync(); } catch { }
        }
        _runtimes.Clear();
    }

    public async Task<SessionRecord> EnsureSessionRecordAsync(SocketThreadChannel thread, SocketGuildChannel parentChannel)
    {
        var existing = await _store.GetByThreadIdAsync(thread.Id);
        if (existing is not null) return existing;

        var guildId = (thread.Guild?.Id) ?? 0;
        var parentId = parentChannel.Id;

        // Stable per-thread Copilot session ID.
        var copilotSessionId = $"discord-{guildId}-{thread.Id}";

        var cfg = SessionConfigState.Default(_options.DefaultModel);
        cfg.AutoApprovePermissions = _options.DefaultAutoApprovePermissions;

        var now = DateTimeOffset.UtcNow;
        var record = new SessionRecord(
            ThreadId: thread.Id,
            GuildId: guildId,
            ParentChannelId: parentId,
            CopilotSessionId: copilotSessionId,
            RepoPath: null,
            ConfigJson: JsonSerializer.Serialize(cfg, new JsonSerializerOptions { WriteIndented = true }),
            CreatedUtc: now,
            UpdatedUtc: now);

        await _store.UpsertAsync(record);
        return record;
    }

    public async Task SendUserMessageAsync(DiscordSocketClient client, SocketThreadChannel thread, SessionRecord record, string userText)
    {
        // UX: a single status message that gets edited (no spam).
        IUserMessage? statusMessage = null;
        var statusCreated = false;
        try { await thread.TriggerTypingAsync(); } catch { }

        var cfg = _store.ReadConfig(record);
        var repoDisplay = BuildRepoDisplay(record.RepoPath);
        var model = string.IsNullOrWhiteSpace(cfg.Model) ? _options.DefaultModel : cfg.Model;

        try
        {
            var started = DateTimeOffset.UtcNow;
            statusMessage = await thread.SendMessageAsync(BuildStatusMessage(
                state: "Working",
                repoDisplay: repoDisplay,
                model: model,
                action: "Starting…",
                elapsedSeconds: 0));

            if (statusMessage != null)
            {
                statusCreated = true;
                _activeTurnStatusByThreadId[thread.Id] = new ActiveTurnStatus(
                    statusMessage.Id,
                    StartedUtc: started,
                    LastUpdateUtc: started,
                    State: "Working",
                    RepoDisplay: repoDisplay,
                    Model: model,
                    Action: "Starting…");
            }
        }
        catch { }

        CopilotTurnOutcome outcome = CopilotTurnOutcome.Failed("unknown");
        try
        {
            var runtime = await GetOrCreateRuntimeAsync(client, thread, record);
            outcome = await runtime.SendUserMessageAsync(userText);
        }
        catch (Exception ex)
        {
            // Avoid bubbling to the Discord gateway handler; report and return.
            await TryUpdateTurnStatusAsync(client, thread.Id, state: "Failed", action: ex.Message, force: true);
            outcome = CopilotTurnOutcome.Failed(ex.Message);
        }

        var finalState = outcome.Success
            ? "Done"
            : outcome.TimedOut
                ? "Timed out"
                : "Failed";

        var finalAction = outcome.Success
            ? "Completed"
            : outcome.TimedOut
                ? "Timed out (try `cp abort`)"
                : !string.IsNullOrWhiteSpace(outcome.ErrorMessage)
                    ? TrimShort(outcome.ErrorMessage!, 120)
                    : "Error";

        await TryUpdateTurnStatusAsync(
            client,
            thread.Id,
            state: finalState,
            action: finalAction,
            force: true);
        _activeTurnStatusByThreadId.TryRemove(thread.Id, out _);

        // Fallback: if we couldn't create/edit the status message (missing permissions), post a single clean result.
        if (!statusCreated && !outcome.Success)
        {
            var icon = outcome.TimedOut ? "⏱️" : "❌";
            var title = outcome.TimedOut ? "Timed out" : "Failed";
            await thread.SendMessageAsync(DiscordUi.Box(
                title,
                [
                    ("repo", DiscordUi.TrimShort(repoDisplay, 80)),
                    ("model", DiscordUi.TrimShort(model, 40)),
                    ("detail", DiscordUi.TrimShort(finalAction, 180))
                ],
                icon: icon));
        }
    }

    public async Task UpdateTurnProgressAsync(DiscordSocketClient client, ulong threadId, string progressText)
    {
        await TryUpdateTurnStatusAsync(client, threadId, state: "Working", action: progressText);
    }

    public async Task NotifyWaitingForApprovalAsync(DiscordSocketClient client, ulong threadId, string permissionKind)
    {
        await TryUpdateTurnStatusAsync(client, threadId, state: "Waiting", action: permissionKind, force: true);
    }

    public async Task NotifyApprovalResolvedAsync(DiscordSocketClient client, ulong threadId)
    {
        await TryUpdateTurnStatusAsync(client, threadId, state: "Working", action: "Resuming…", force: true);
    }

    private async Task TryUpdateTurnStatusAsync(
        DiscordSocketClient client,
        ulong threadId,
        string? state = null,
        string? action = null,
        bool force = false)
    {
        if (!_activeTurnStatusByThreadId.TryGetValue(threadId, out var st)) return;

        // Avoid edit spam.
        var now = DateTimeOffset.UtcNow;
        if (!force && (now - st.LastUpdateUtc) < TimeSpan.FromSeconds(1)) return;

        var nextState = string.IsNullOrWhiteSpace(state) ? st.State : state;
        var nextAction = string.IsNullOrWhiteSpace(action) ? st.Action : action;

        var elapsedSeconds = Math.Max(0, (int)Math.Round((now - st.StartedUtc).TotalSeconds));
        var content = BuildStatusMessage(
            state: nextState,
            repoDisplay: st.RepoDisplay,
            model: st.Model,
            action: nextAction,
            elapsedSeconds: elapsedSeconds);

        if (!force && string.Equals(BuildStatusMessage(st.State, st.RepoDisplay, st.Model, st.Action, elapsedSeconds), content, StringComparison.Ordinal))
        {
            return;
        }

        try
        {
            var channel = client.GetChannel(threadId) as IMessageChannel;
            if (channel is null) return;
            var msg = await channel.GetMessageAsync(st.MessageId) as IUserMessage;
            if (msg is null) return;
            await msg.ModifyAsync(m => m.Content = content);
            _activeTurnStatusByThreadId[threadId] = st with { LastUpdateUtc = now, State = nextState, Action = nextAction };
        }
        catch
        {
            // ignore
        }
    }

    public async Task AbortAsync(ulong threadId)
    {
        if (_runtimes.TryGetValue(threadId, out var runtime))
        {
            await runtime.AbortAsync();
        }
    }

    public bool TryResolvePermission(ulong threadId, bool approve, string? toolCallId)
    {
        if (!_pendingPermissions.TryGetValue(threadId, out var dict)) return false;

        if (!string.IsNullOrWhiteSpace(toolCallId))
        {
            if (dict.TryRemove(toolCallId, out var tcs))
            {
                tcs.TrySetResult(new PermissionRequestResult { Kind = approve ? "approved" : "denied-interactively-by-user" });
                return true;
            }
            return false;
        }

        // No id provided: resolve the oldest pending (first key).
        var first = dict.Keys.FirstOrDefault();
        if (first is null) return false;
        if (dict.TryRemove(first, out var firstTcs))
        {
            firstTcs.TrySetResult(new PermissionRequestResult { Kind = approve ? "approved" : "denied-interactively-by-user" });
            return true;
        }

        return false;
    }

    public bool TryResolvePermissionByPromptMessageId(ulong promptMessageId, bool approve, out ulong threadId)
    {
        threadId = 0;
        if (!_permissionPromptByMessageId.TryRemove(promptMessageId, out var entry)) return false;
        threadId = entry.threadId;
        return TryResolvePermission(entry.threadId, approve, entry.toolCallId);
    }

    private async Task<CopilotRuntime> GetOrCreateRuntimeAsync(DiscordSocketClient client, SocketThreadChannel thread, SessionRecord record)
    {
        if (_runtimes.TryGetValue(thread.Id, out var cached)) return cached;

        var gate = _runtimeLocks.GetOrAdd(thread.Id, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync();
        try
        {
            if (_runtimes.TryGetValue(thread.Id, out cached)) return cached;

            var created = await CreateRuntimeAsync(client, thread, record);
            _runtimes[thread.Id] = created;
            return created;
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<CopilotRuntime> CreateRuntimeAsync(DiscordSocketClient client, SocketThreadChannel thread, SessionRecord record)
    {
        if (_lastRuntimeStartFailureUtc.TryGetValue(thread.Id, out var lastFail)
            && (DateTimeOffset.UtcNow - lastFail) < _runtimeStartFailureCooldown)
        {
            throw new InvalidOperationException("Copilot runtime previously failed to start; retrying shortly.");
        }

        var cfg = _store.ReadConfig(record);

        var repoPath = record.RepoPath;
        var cwd = !string.IsNullOrWhiteSpace(repoPath) ? repoPath : _options.ReposRoot;
        cwd = PathUtils.NormalizeFullPath(cwd);

        if (!PathUtils.IsWithinRoot(cwd, _options.ReposRoot))
        {
            cwd = PathUtils.NormalizeFullPath(_options.ReposRoot);
        }

        Task SendToDiscordAsync(string text)
        {
            // Fetch channel by id each time to survive cache evictions.
            var ch = client.GetChannel(thread.Id) as ISocketMessageChannel;
            return ch != null ? SendChunkedAsync(ch, text) : Task.CompletedTask;
        }

        Task SendProgressAsync(string progressText)
            => UpdateTurnProgressAsync(client, thread.Id, progressText);

        async Task<PermissionRequestResult> OnPermissionAsync(PermissionRequest request, PermissionInvocation invocation)
        {        
            var autoApprove = cfg.AutoApprovePermissions ?? _options.DefaultAutoApprovePermissions;
            if (autoApprove)
            {
                return new PermissionRequestResult { Kind = "approved" };
            }

            var kindLower = (request.Kind ?? string.Empty).Trim().ToLowerInvariant();
            if (_options.AutoApproveReadPermissions && LooksLikeReadOnly(kindLower))
            {
                return new PermissionRequestResult { Kind = "approved" };
            }

            var toolCallId = request.ToolCallId ?? Guid.NewGuid().ToString("n");
            var perThread = _pendingPermissions.GetOrAdd(thread.Id, _ => new ConcurrentDictionary<string, TaskCompletionSource<PermissionRequestResult>>());

            var tcs = new TaskCompletionSource<PermissionRequestResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            perThread[toolCallId] = tcs;

            var details = BuildPermissionSummary(request, invocation);
            await NotifyWaitingForApprovalAsync(client, thread.Id, details.OneLine);

            var debug = BuildPermissionDebugDump(_options.DebugPermissionPayload, details, request, invocation);
            var promptMessage = await thread.SendMessageAsync(
                DiscordUi.Box(
                    "Permission required",
                    [("kind", details.Kind), ("detail", details.Detail)],
                    footer: "React 👍 / 👎",
                    icon: "⏸️") +
                debug);

            _permissionPromptByMessageId[promptMessage.Id] = (thread.Id, toolCallId);
            try
            {
                // Pre-add reactions to make mobile UX one-tap.
                await promptMessage.AddReactionAsync(new Emoji("👍"));
                await promptMessage.AddReactionAsync(new Emoji("👎"));
            }
            catch
            {
                // Ignore if we can't add reactions due to permissions.
            }

            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(10));
            using var registration = cts.Token.Register(() => tcs.TrySetResult(new PermissionRequestResult { Kind = "denied-interactively-by-user" }));

            return await tcs.Task;
        }

        static bool LooksLikeReadOnly(string kindLower)
        {
            if (string.IsNullOrWhiteSpace(kindLower)) return false;
            // Keep this conservative: treat only explicit read-type permissions as safe.
            // (Write/exec/delete/etc should still require approval.)
            if (kindLower.Contains("write") || kindLower.Contains("delete") || kindLower.Contains("exec") || kindLower.Contains("run"))
                return false;
            return kindLower == "read" || kindLower.StartsWith("read", StringComparison.Ordinal);
        }

        var runtime = new CopilotRuntime(
            _logger,
            record,
            cfg,
            cwd,
            _options.CopilotCliPath,
            TimeSpan.FromSeconds(_options.TurnTimeoutSeconds),
            SendToDiscordAsync,
            SendProgressAsync,
            OnPermissionAsync);

        try
        {
            await runtime.StartAsync();
            _lastRuntimeStartFailureUtc.TryRemove(thread.Id, out _);
        }
        catch
        {
            _lastRuntimeStartFailureUtc[thread.Id] = DateTimeOffset.UtcNow;
            throw;
        }
        return runtime;
    }

    private static async Task SendChunkedAsync(ISocketMessageChannel channel, string text)
    {
        foreach (var chunk in TextChunker.ChunkForDiscord(text))
        {
            await channel.SendMessageAsync(chunk);
        }
    }

    private sealed record PermissionSummary(string Kind, string Detail, string OneLine);

    private static PermissionSummary BuildPermissionSummary(PermissionRequest request, PermissionInvocation invocation)
    {
        var kind = string.IsNullOrWhiteSpace(request.Kind) ? "permission" : request.Kind.Trim();

        // Best-effort extraction (SDK preview: shapes vary across versions).
        // Prefer explicit, named fields, then fall back to a deep string search.
        var tool =
            TryGetValueDeep(invocation, 2, "ToolName", "Tool", "Name", "ToolId")
            ?? TryGetValueDeep(request, 2, "ToolName", "Tool", "Name", "ToolId")
            ?? kind;

        var path =
            TryGetValueDeep(invocation, 3, "Path", "FilePath", "TargetPath", "FullPath", "RelativePath")
            ?? TryFindLikelyPath(invocation)
            ?? TryFindLikelyPath(request);

        var url =
            TryGetValueDeep(invocation, 3, "Url", "URL", "URI", "Uri")
            ?? TryFindLikelyUrl(invocation)
            ?? TryFindLikelyUrl(request);

        // For shell-like permissions, try to find a real command line.
        var shellCommand = LooksLikeShellPermission(kind)
            ? FindBestShellCommand(invocation, request)
            : null;

        var command = shellCommand
            ?? TryGetValueDeep(invocation, 3, "CommandLine", "Command", "Cmd", "ShellCommand")
            ?? TryGetValueDeep(request, 3, "CommandLine", "Command", "Cmd", "ShellCommand");

        var args =
            TryGetValueDeep(invocation, 2, "Args", "Arguments")
            ?? TryGetValueDeep(request, 2, "Args", "Arguments");

        string detail;
        string oneLine;

        if (!string.IsNullOrWhiteSpace(command))
        {
            var cmd = command;
            if (!string.IsNullOrWhiteSpace(args) && !cmd.Contains(args, StringComparison.OrdinalIgnoreCase))
            {
                cmd = cmd + " " + args;
            }
            cmd = NormalizeShellLabel(cmd);
            if (LooksLikeShellPermission(kind) && !IsPlausibleShellCommand(cmd))
            {
                // Avoid misleading output (e.g. session id "discord-<guild>-<thread>").
                cmd = "(unknown command)";
            }
            detail = $"command: {TrimShort(cmd, 160)}";
            oneLine = $"{kind}: {TrimShort(cmd, 80)}";
        }
        else if (!string.IsNullOrWhiteSpace(path))
        {
            detail = $"path: {TrimShort(path, 180)}";
            oneLine = $"{kind}: {TrimShort(path, 80)}";
        }
        else if (!string.IsNullOrWhiteSpace(url))
        {
            detail = $"url: {TrimShort(url, 180)}";
            oneLine = $"{kind}: {TrimShort(url, 80)}";
        }
        else
        {
            // Last resort: show tool + what fields exist so the user understands why it's vague.
            var fields = string.Join(", ", GetPublicPropertyNames(invocation).Take(10));
            detail = $"tool: {TrimShort(tool, 60)}" + (fields.Length > 0 ? $" (fields: {fields})" : string.Empty);
            oneLine = kind;
        }

        return new PermissionSummary(kind, detail, oneLine);
    }

    private static string BuildPermissionDebugDump(bool enabled, PermissionSummary details, PermissionRequest request, PermissionInvocation invocation)
    {
        if (!enabled) return string.Empty;

        // Only show when it's not useful (to reduce noise).
        var isUnclear = details.Detail.Contains("unknown", StringComparison.OrdinalIgnoreCase)
            || details.Detail.Contains("details unavailable", StringComparison.OrdinalIgnoreCase)
            || details.Detail.Contains("fields:", StringComparison.OrdinalIgnoreCase);
        if (!isUnclear) return string.Empty;

        var fields = string.Join(", ", GetPublicPropertyNames(invocation).Take(25));
        var candidates = EnumerateStringsShallow(invocation, maxDepth: 4)
            .Concat(EnumerateStringsShallow(request, maxDepth: 4))
            .Select(RedactSecrets)
            .Select(s => s.Trim())
            .Where(s => s.Length is >= 6 and <= 120)
            .Where(s => !System.Text.RegularExpressions.Regex.IsMatch(s, "^discord-\\d+-\\d+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            .Distinct(StringComparer.Ordinal)
            .Take(6)
            .ToList();

        var candLine = candidates.Count == 0 ? "(none)" : string.Join(" | ", candidates.Select(c => TrimShort(c, 40)));

        return "\n" + DiscordUi.Box(
            "Debug (permission payload)",
            [
                ("fields", TrimShort(fields, 240)),
                ("strings", TrimShort(candLine, 240))
            ],
            icon: "🧪") + "\n";
    }

    private static bool LooksLikeShellPermission(string kind)
    {
        var k = kind.Trim().ToLowerInvariant();
        return k == "shell" || k.Contains("shell") || k.Contains("exec") || k.Contains("run");
    }

    private static string? FindBestShellCommand(PermissionInvocation invocation, PermissionRequest request)
    {
        // Collect candidate strings from both objects.
        var candidates = EnumerateStringsShallow(invocation, maxDepth: 4)
            .Concat(EnumerateStringsShallow(request, maxDepth: 4))
            .Select(NormalizeShellLabel)
            .Select(RedactSecrets)
            .Select(s => s.Trim())
            .Where(s => s.Length is > 2 and < 400)
            .Where(IsPlausibleShellCommand)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        return candidates
            .OrderByDescending(s => s.Length)
            .FirstOrDefault();
    }

    private static bool IsPlausibleShellCommand(string s)
    {
        s = (s ?? string.Empty).Trim();
        if (s.Length < 3) return false;

        // Exclude IDs/session identifiers.
        if (System.Text.RegularExpressions.Regex.IsMatch(s, "^discord-\\d+-\\d+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            return false;
        if (System.Text.RegularExpressions.Regex.IsMatch(s, "^call_[A-Za-z0-9]+$"))
            return false;
        if (System.Text.RegularExpressions.Regex.IsMatch(s, "^[0-9a-f]{24,64}$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            return false;

        // Typical commands have spaces, slashes, or common prefixes.
        if (s.Contains(' ')) return true;
        if (s.Contains("\\") || s.Contains('/')) return true;
        if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return true;
        if (s.StartsWith("git", StringComparison.OrdinalIgnoreCase)) return true;
        if (s.StartsWith("dotnet", StringComparison.OrdinalIgnoreCase)) return true;
        if (s.StartsWith("npm", StringComparison.OrdinalIgnoreCase)) return true;
        if (s.StartsWith("node", StringComparison.OrdinalIgnoreCase)) return true;
        if (s.StartsWith("pwsh", StringComparison.OrdinalIgnoreCase)) return true;
        if (s.StartsWith("powershell", StringComparison.OrdinalIgnoreCase)) return true;
        if (s.StartsWith("cmd", StringComparison.OrdinalIgnoreCase)) return true;

        // shell(git status)
        if (s.Contains("shell(", StringComparison.OrdinalIgnoreCase)) return true;

        return false;
    }

    private static IEnumerable<string> GetPublicPropertyNames(object obj)
    {
        try
        {
            return obj.GetType()
                .GetProperties()
                .Where(p => p.GetIndexParameters().Length == 0)
                .Select(p => p.Name);
        }
        catch
        {
            return Array.Empty<string>();
        }
    }

    private static string? TryGetValueDeep(object obj, int maxDepth, params string[] names)
    {
        foreach (var name in names)
        {
            var val = TryGetByNameDeep(obj, name, maxDepth);
            if (!string.IsNullOrWhiteSpace(val)) return RedactSecrets(val);
        }
        return null;
    }

    private static string? TryGetByNameDeep(object obj, string propertyName, int maxDepth)
    {
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        return TryGetByNameDeepCore(obj, propertyName, maxDepth, seen);
    }

    private static string? TryGetByNameDeepCore(object obj, string propertyName, int depth, HashSet<object> seen)
    {
        if (obj is null) return null;
        if (depth < 0) return null;

        if (obj is string s) return s;
        if (obj is JsonElement je) return je.ToString();

        // Avoid cycles.
        if (obj.GetType().IsClass)
        {
            if (!seen.Add(obj)) return null;
        }

        var t = obj.GetType();
        var prop = t.GetProperty(propertyName);
        if (prop != null && prop.GetIndexParameters().Length == 0)
        {
            var v = SafeGetValue(prop, obj);
            var str = ToUsefulString(v);
            if (!string.IsNullOrWhiteSpace(str)) return str;
        }

        foreach (var p in t.GetProperties())
        {
            if (p.GetIndexParameters().Length != 0) continue;
            var v = SafeGetValue(p, obj);
            if (v is null) continue;

            // Don't recurse into huge collections.
            if (v is System.Collections.IEnumerable en && v is not string)
            {
                var i = 0;
                foreach (var item in en)
                {
                    if (item is null) continue;
                    var found = TryGetByNameDeepCore(item, propertyName, depth - 1, seen);
                    if (!string.IsNullOrWhiteSpace(found)) return found;
                    if (++i >= 3) break;
                }
                continue;
            }

            var found2 = TryGetByNameDeepCore(v, propertyName, depth - 1, seen);
            if (!string.IsNullOrWhiteSpace(found2)) return found2;
        }

        return null;
    }

    private static object? SafeGetValue(System.Reflection.PropertyInfo prop, object obj)
    {
        try { return prop.GetValue(obj); } catch { return null; }
    }

    private static string? ToUsefulString(object? val)
    {
        if (val is null) return null;
        if (val is string s) return s;
        if (val is JsonElement je) return je.ToString();

        if (val is IEnumerable<string> ss)
        {
            var joined = string.Join(' ', ss.Where(x => !string.IsNullOrWhiteSpace(x)));
            return string.IsNullOrWhiteSpace(joined) ? null : joined;
        }

        return val.ToString();
    }

    private static string? TryFindLikelyCommand(object obj)
        => TryFindLikelyString(obj, s =>
            s.Contains("shell(", StringComparison.OrdinalIgnoreCase)
            || s.Contains("git ", StringComparison.OrdinalIgnoreCase)
            || s.Contains("dotnet ", StringComparison.OrdinalIgnoreCase)
            || s.Contains("cmd.exe", StringComparison.OrdinalIgnoreCase)
            || s.Contains("powershell", StringComparison.OrdinalIgnoreCase));

    private static string? TryFindLikelyPath(object obj)
        => TryFindLikelyString(obj, s =>
            s.Contains("\\") || s.Contains("/") || s.Contains(":\\"));

    private static string? TryFindLikelyUrl(object obj)
        => TryFindLikelyString(obj, s =>
            s.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || s.StartsWith("https://", StringComparison.OrdinalIgnoreCase));

    private static string? TryFindLikelyString(object obj, Func<string, bool> predicate)
    {
        var candidates = EnumerateStringsShallow(obj, maxDepth: 3)
            .Select(RedactSecrets)
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim())
            .Where(s => s.Length is > 2 and < 400)
            .Where(predicate)
            .Distinct(StringComparer.Ordinal)
            .Take(5)
            .ToList();

        // Pick the longest plausible candidate.
        return candidates.OrderByDescending(s => s.Length).FirstOrDefault();
    }

    private static IEnumerable<string> EnumerateStringsShallow(object obj, int maxDepth)
    {
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        return EnumerateStringsShallowCore(obj, maxDepth, seen);
    }

    private static IEnumerable<string> EnumerateStringsShallowCore(object? obj, int depth, HashSet<object> seen)
    {
        if (obj is null) yield break;
        if (depth < 0) yield break;

        if (obj is string s)
        {
            yield return s;
            yield break;
        }

        if (obj is JsonElement je)
        {
            yield return je.ToString();
            yield break;
        }

        if (obj.GetType().IsClass)
        {
            if (!seen.Add(obj)) yield break;
        }

        if (obj is System.Collections.IEnumerable en)
        {
            var i = 0;
            foreach (var item in en)
            {
                foreach (var s2 in EnumerateStringsShallowCore(item, depth - 1, seen))
                    yield return s2;
                if (++i >= 5) break;
            }
            yield break;
        }

        var t = obj.GetType();
        foreach (var p in t.GetProperties())
        {
            if (p.GetIndexParameters().Length != 0) continue;
            var v = SafeGetValue(p, obj);
            foreach (var s2 in EnumerateStringsShallowCore(v, depth - 1, seen))
                yield return s2;
        }
    }

    private static string NormalizeShellLabel(string s)
    {
        s = s.Trim();
        // shell(git status) -> git status
        if (s.StartsWith("shell(", StringComparison.OrdinalIgnoreCase) && s.EndsWith(')'))
        {
            return s[6..^1];
        }
        return s;
    }

    private static string RedactSecrets(string s)
    {
        if (string.IsNullOrWhiteSpace(s)) return s;

        // Common GitHub token prefixes.
        var prefixes = new[] { "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_" };
        foreach (var p in prefixes)
        {
            var idx = s.IndexOf(p, StringComparison.OrdinalIgnoreCase);
            if (idx >= 0)
            {
                // Replace token-like run following prefix.
                var end = idx + p.Length;
                while (end < s.Length && (char.IsLetterOrDigit(s[end]) || s[end] is '_' or '-')) end++;
                s = s[..idx] + p + "***" + s[end..];
            }
        }

        // Bearer tokens.
        var bearerIdx = s.IndexOf("bearer ", StringComparison.OrdinalIgnoreCase);
        if (bearerIdx >= 0)
        {
            var start = bearerIdx + "bearer ".Length;
            var end = start;
            while (end < s.Length && !char.IsWhiteSpace(s[end])) end++;
            s = s[..start] + "***" + s[end..];
        }

        return s;
    }

    private sealed class ReferenceEqualityComparer : IEqualityComparer<object>
    {
        public static readonly ReferenceEqualityComparer Instance = new();
        public new bool Equals(object? x, object? y) => ReferenceEquals(x, y);
        public int GetHashCode(object obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
    }

    private static string TrimShort(string s, int max = 140)
    {
        s = (s ?? string.Empty).Trim();
        if (s.Length <= max) return s;
        return s[..max] + "…";
    }

    private string BuildRepoDisplay(string? repoPath)
    {
        if (string.IsNullOrWhiteSpace(repoPath)) return "(unset)";
        try
        {
            var full = PathUtils.NormalizeFullPath(repoPath);
            if (PathUtils.IsWithinRoot(full, _options.ReposRoot))
            {
                var rel = Path.GetRelativePath(_options.ReposRoot, full);
                return rel.Replace('\\', '/');
            }
            return Path.GetFileName(full);
        }
        catch
        {
            return repoPath;
        }
    }

    private static string BuildStatusMessage(string state, string repoDisplay, string model, string action, int elapsedSeconds)
    {
        var icon = state switch
        {
            "Done" => "✅",
            "Failed" => "❌",
            "Timed out" => "⏱️",
            "Waiting" => "⏸️",
            _ => "⏳"
        };

        return DiscordUi.Box(
            state,
            [
                ("elapsed", $"{elapsedSeconds}s"),
                ("repo", DiscordUi.TrimShort(repoDisplay, 80)),
                ("model", DiscordUi.TrimShort(model, 40)),
                ("doing", DiscordUi.TrimShort(action, 220))
            ],
            icon: icon);
    }
}
