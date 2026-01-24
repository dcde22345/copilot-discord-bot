using CopilotDiscordBot.Models;
using GitHub.Copilot.SDK;
using Microsoft.Extensions.Logging;
using System.Diagnostics;
using System.Text;
using CopilotDiscordBot.Utils;

namespace CopilotDiscordBot.Services;

public sealed record CopilotTurnOutcome(bool Success, bool TimedOut, string? ErrorMessage)
{
    public static CopilotTurnOutcome Ok() => new(true, false, null);
    public static CopilotTurnOutcome Timeout() => new(false, true, null);
    public static CopilotTurnOutcome Failed(string? error) => new(false, false, error);
}

public sealed class CopilotRuntime : IAsyncDisposable
{
    private readonly ILogger _logger;
    private readonly SessionRecord _record;
    private readonly SessionConfigState _cfg;
    private readonly string _cwd;
    private readonly string? _cliPath;
    private readonly TimeSpan _turnTimeout;
    private readonly Func<string, Task> _sendToDiscord;
    private readonly Func<string, Task> _sendProgress;
    private readonly PermissionHandler _permissionHandler;

    private readonly SemaphoreSlim _turnLock = new(1, 1);

    private CopilotClient? _client;
    private CopilotSession? _session;
    private IDisposable? _subscription;

    private string? _lastToolLabel;

    public CopilotRuntime(
        ILogger logger,
        SessionRecord record,
        SessionConfigState cfg,
        string cwd,
        string? cliPath,
        TimeSpan turnTimeout,
        Func<string, Task> sendToDiscord,
        Func<string, Task> sendProgress,
        PermissionHandler permissionHandler)
    {
        _logger = logger;
        _record = record;
        _cfg = cfg;
        _cwd = cwd;
        _cliPath = cliPath;
        _turnTimeout = turnTimeout;
        _sendToDiscord = sendToDiscord;
        _sendProgress = sendProgress;
        _permissionHandler = permissionHandler;
    }

    public async Task StartAsync()
    {
        var effectiveCli = string.IsNullOrWhiteSpace(_cliPath) ? "copilot" : _cliPath;

        var options = new CopilotClientOptions
        {
            LogLevel = "error",
            AutoStart = true,
            AutoRestart = true,
            Cwd = _cwd,
            CliPath = string.IsNullOrWhiteSpace(_cliPath) ? null : _cliPath,
            UseStdio = true
        };

        _client = new CopilotClient(options);

        try
        {
            await _client.StartAsync();

            // Helpful check; if unauthenticated, we'll still run but responses may fail.
            try
            {
                var auth = await _client.GetAuthStatusAsync();
                if (!auth.IsAuthenticated)
                {
                    await _sendToDiscord(DiscordUi.Box(
                        "Copilot auth required",
                        [("authType", auth.AuthType ?? "?")],
                        footer: "Run `copilot` once on the server to sign in (or set `GH_TOKEN`).",
                        icon: "🔐"));
                }
            }
            catch
            {
                // Ignore: older CLI/runtime might not support auth status.
            }

            await EnsureSessionAsync();
        }
        catch (Exception ex)
        {
            var probe = await ProbeCopilotCliAsync(effectiveCli);

            var msg = new StringBuilder();
            msg.AppendLine("❌ **Copilot runtime failed to start**");
            msg.AppendLine("```text");
            msg.AppendLine($"error   : {ex.GetType().Name}: {ex.Message}");
            msg.AppendLine($"cli     : {effectiveCli} --version");
            msg.AppendLine($"exit    : {probe.ExitCode?.ToString() ?? "(timeout)"}");
            msg.AppendLine("```");

            if (!string.IsNullOrWhiteSpace(probe.Output))
            {
                msg.AppendLine("```text");
                msg.AppendLine(TrimForDiscord(probe.Output));
                msg.AppendLine("```");
            }

            msg.AppendLine("Fixes:");
            msg.AppendLine("- Install: `winget install --id GitHub.Copilot.Prerelease -e`");
            msg.AppendLine("- Verify: `where copilot` + `copilot --version`");
            msg.AppendLine("- Auth: run `copilot` once (or set `GH_TOKEN`)" );
            msg.AppendLine("- If PATH hits a shim, set `Bot:CopilotCliPath` to the winget `copilot.exe`" );

            await _sendToDiscord(msg.ToString());
            throw;
        }
    }

    private static async Task<(int? ExitCode, string Output)> ProbeCopilotCliAsync(string cli)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = cli,
                Arguments = "--version",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using var proc = Process.Start(psi);
            if (proc is null) return (null, "Failed to start process");

            // Make it non-interactive: close stdin so prompts fail fast.
            try { proc.StandardInput.Close(); } catch { }

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var stdoutTask = proc.StandardOutput.ReadToEndAsync();
            var stderrTask = proc.StandardError.ReadToEndAsync();

            await proc.WaitForExitAsync(cts.Token);
            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            var output = (stdout + "\n" + stderr).Trim();
            return (proc.ExitCode, output);
        }
        catch (OperationCanceledException)
        {
            return (null, "Timed out running copilot --version");
        }
        catch (Exception ex)
        {
            return (null, $"Failed to run copilot --version: {ex.Message}");
        }
    }

    private static string TrimForDiscord(string s, int max = 1500)
    {
        s = (s ?? string.Empty).Trim();
        if (s.Length <= max) return s;
        return s[..max] + "\n...(truncated)";
    }

    private async Task EnsureSessionAsync()
    {
        if (_client is null) throw new InvalidOperationException("Client not started");

        var model = string.IsNullOrWhiteSpace(_cfg.Model) ? "gpt-5" : _cfg.Model;

        try
        {
            _session = await _client.ResumeSessionAsync(_record.CopilotSessionId, new ResumeSessionConfig
            {
                Streaming = _cfg.Streaming,
                OnPermissionRequest = _permissionHandler,
                McpServers = BuildMcpServers(_cfg.McpServers),
                CustomAgents = BuildCustomAgents(_cfg.CustomAgents),
                SkillDirectories = _cfg.SkillDirectories,
                DisabledSkills = _cfg.DisabledSkills,
                Provider = null,
                Tools = null
            });
        }
        catch (Exception ex) when (LooksLikeSessionNotFound(ex))
        {
            _session = await _client.CreateSessionAsync(new SessionConfig
            {
                SessionId = _record.CopilotSessionId,
                Model = model,
                Streaming = _cfg.Streaming,
                AvailableTools = _cfg.AvailableTools,
                ExcludedTools = _cfg.ExcludedTools,
                OnPermissionRequest = _permissionHandler,
                McpServers = BuildMcpServers(_cfg.McpServers),
                CustomAgents = BuildCustomAgents(_cfg.CustomAgents),
                SkillDirectories = _cfg.SkillDirectories,
                DisabledSkills = _cfg.DisabledSkills,
                SystemMessage = new SystemMessageConfig
                {
                    Mode = SystemMessageMode.Append,
                    Content = $"""
<context>
The current working directory is: {_cwd}
</context>

<instructions>
- You are running inside a Discord-controlled agent session.
- Prefer small, safe changes; ask for clarification if needed.
- If you need to edit files or run commands, do so within the current repo.
- Do not narrate your plan (avoid messages like "I'll do X next").
- Use tools silently; let the bot's status message reflect progress.
- When you respond, provide the useful result directly.
</instructions>
"""
                }
            });
        }
        catch (Exception ex)
        {
            await _sendToDiscord(DiscordUi.Box(
                "Session resume failed",
                [("session", _record.CopilotSessionId), ("error", $"{ex.GetType().Name}: {ex.Message}")],
                footer: "The bot did not create a new session automatically (to avoid losing context).",
                icon: "❌"));
            throw;
        }

        _subscription?.Dispose();
        _subscription = _session.On(async evt =>
        {
            try
            {
                if (evt is AssistantMessageEvent msg && !string.IsNullOrWhiteSpace(msg.Data.Content))
                {
                    await _sendToDiscord(msg.Data.Content);
                }
                else if (evt is ToolExecutionStartEvent toolStart)
                {
                    var label = ExtractToolLabel(toolStart.Data);
                    if (label is null)
                    {
                        await _sendProgress("Running tool");
                    }
                    else if (!IsNoisyTool(label))
                    {
                        await _sendProgress($"Running {FormatToolLabel(label)}");
                    }
                }
                else if (evt is ToolExecutionCompleteEvent toolDone)
                {
                    // Deliberately ignore tool completion to avoid chat spam.
                }
                else if (evt is SessionErrorEvent err)
                {
                    await _sendToDiscord(DiscordUi.Box(
                        "Copilot session error",
                        [("message", err.Data?.Message ?? "unknown")],
                        icon: "❌"));
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to forward Copilot event to Discord");
            }
        });
    }

    private static bool IsNoisyTool(string label)
    {
        var lower = label.Trim().ToLowerInvariant();
        return lower is "report_intent" or "report-intent";
    }

    private static string FormatToolLabel(string label)
    {
        label = label.Trim();

        // Common pattern: shell(git status)
        if (label.StartsWith("shell(", StringComparison.OrdinalIgnoreCase) && label.EndsWith(')'))
        {
            return label[6..^1];
        }

        // Make snake_case more readable.
        if (label.Contains('_'))
        {
            return label.Replace('_', ' ');
        }

        return label;
    }

    private string? ExtractToolLabel(object? data)
    {
        if (data is null) return null;

        // SDK preview: property names may change across versions. Use reflection defensively.
        var label =
            TryGetStringProperty(data, "ToolName", "Tool", "Name", "Command")
            ?? TryGetStringProperty(data, "Id", "ToolCallId");

        if (string.IsNullOrWhiteSpace(label)) return null;
        if (label == _lastToolLabel) return label;
        _lastToolLabel = label;
        return label;
    }

    private static string? TryGetStringProperty(object obj, params string[] names)
    {
        var t = obj.GetType();
        foreach (var name in names)
        {
            var prop = t.GetProperty(name);
            if (prop is null) continue;
            if (prop.PropertyType != typeof(string)) continue;
            var val = prop.GetValue(obj) as string;
            if (!string.IsNullOrWhiteSpace(val)) return val;
        }
        return null;
    }

    private static bool LooksLikeSessionNotFound(Exception ex)
    {
        var msg = ex.Message?.ToLowerInvariant() ?? string.Empty;
        return msg.Contains("not found")
            || msg.Contains("unknown session")
            || msg.Contains("session not found")
            || msg.Contains("404");
    }

    public async Task<CopilotTurnOutcome> SendUserMessageAsync(string userText)
    {
        if (_session is null) throw new InvalidOperationException("Session not started");

        await _turnLock.WaitAsync();
        try
        {
            // SendAndWait blocks until session.idle.
            var final = await _session.SendAndWaitAsync(
                new MessageOptions { Prompt = userText, Mode = "enqueue" },
                timeout: _turnTimeout);

            if (final?.Data?.Content is { Length: > 0 } content)
            {
                // Often the event handler already sent this, but duplicating is noisy.
                // We'll only send if it wasn't emitted as an event (best-effort).
                // (No reliable correlation here in SDK v0.1.x.)
            }

            return CopilotTurnOutcome.Ok();
        }
        catch (TimeoutException)
        {
            return CopilotTurnOutcome.Timeout();
        }
        catch (Exception ex)
        {
            return CopilotTurnOutcome.Failed(ex.Message);
        }
        finally
        {
            _turnLock.Release();
        }
    }

    public async Task AbortAsync()
    {
        if (_session is null) return;
        try
        {
            await _session.AbortAsync();
        }
        catch
        {
            // ignore
        }
    }

    private static Dictionary<string, object>? BuildMcpServers(System.Text.Json.JsonElement? mcpServers)
    {
        if (mcpServers is null || mcpServers.Value.ValueKind is System.Text.Json.JsonValueKind.Null or System.Text.Json.JsonValueKind.Undefined)
            return null;

        if (mcpServers.Value.ValueKind != System.Text.Json.JsonValueKind.Object)
            return null;

        var dict = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        foreach (var prop in mcpServers.Value.EnumerateObject())
        {
            if (prop.Value.ValueKind != System.Text.Json.JsonValueKind.Object) continue;

            var type = prop.Value.TryGetProperty("type", out var typeEl) ? typeEl.GetString() : null;
            type = type?.ToLowerInvariant();

            if (type is "http" or "sse")
            {
                var url = prop.Value.TryGetProperty("url", out var urlEl) ? urlEl.GetString() : null;
                if (string.IsNullOrWhiteSpace(url)) continue;

                var tools = prop.Value.TryGetProperty("tools", out var toolsEl) && toolsEl.ValueKind == System.Text.Json.JsonValueKind.Array
                    ? toolsEl.EnumerateArray().Select(x => x.GetString()).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToList()
                    : new List<string>();

                dict[prop.Name] = new McpRemoteServerConfig
                {
                    Type = type,
                    Url = url!,
                    Tools = tools
                };
            }
            else if (type is "local" or "stdio" or null)
            {
                // For local server config, expect command/args.
                var command = prop.Value.TryGetProperty("command", out var cmdEl) ? cmdEl.GetString() : null;
                if (string.IsNullOrWhiteSpace(command)) continue;

                var args = prop.Value.TryGetProperty("args", out var argsEl) && argsEl.ValueKind == System.Text.Json.JsonValueKind.Array
                    ? argsEl.EnumerateArray().Select(x => x.GetString()).Where(x => x != null).Select(x => x!).ToList()
                    : new List<string>();

                var tools = prop.Value.TryGetProperty("tools", out var toolsEl) && toolsEl.ValueKind == System.Text.Json.JsonValueKind.Array
                    ? toolsEl.EnumerateArray().Select(x => x.GetString()).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToList()
                    : new List<string>();

                dict[prop.Name] = new McpLocalServerConfig
                {
                    Type = type ?? "local",
                    Command = command!,
                    Args = args,
                    Tools = tools
                };
            }
        }

        return dict.Count == 0 ? null : dict;
    }

    private static List<CustomAgentConfig>? BuildCustomAgents(System.Text.Json.JsonElement? customAgents)
    {
        if (customAgents is null || customAgents.Value.ValueKind is System.Text.Json.JsonValueKind.Null or System.Text.Json.JsonValueKind.Undefined)
            return null;

        if (customAgents.Value.ValueKind != System.Text.Json.JsonValueKind.Array)
            return null;

        try
        {
            var json = customAgents.Value.GetRawText();
            var list = System.Text.Json.JsonSerializer.Deserialize<List<CustomAgentConfig>>(json, new System.Text.Json.JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });
            return list is { Count: > 0 } ? list : null;
        }
        catch
        {
            return null;
        }
    }

    public async ValueTask DisposeAsync()
    {
        try { _subscription?.Dispose(); } catch { }

        if (_session != null)
        {
            try { await _session.DisposeAsync(); } catch { }
        }

        if (_client != null)
        {
            try { await _client.StopAsync(); } catch { }
            try { await _client.DisposeAsync(); } catch { }
        }

        _turnLock.Dispose();
    }
}
