using System.ComponentModel.DataAnnotations;

namespace CopilotDiscordBot;

public class BotOptions
{
    public string DiscordBotToken { get; set; } = string.Empty;

    /// <summary>Only this Discord user can control the bot (recommended).</summary>
    public ulong OwnerDiscordUserId { get; set; }

    /// <summary>Root folder that contains repos the agent is allowed to work in.</summary>
    public string ReposRoot { get; set; } = string.Empty;

    /// <summary>Where to store sqlite + Copilot session state.</summary>
    public string DataDir { get; set; } = "data";

    public string DefaultModel { get; set; } = "gpt-5";

    /// <summary>Optional explicit path to the Copilot CLI (defaults to 'copilot' on PATH).</summary>
    public string? CopilotCliPath { get; set; }

    /// <summary>If true, auto-approves Copilot permission requests (NOT recommended).</summary>
    public bool DefaultAutoApprovePermissions { get; set; } = false;

    /// <summary>
    /// If true, auto-approves read-only permission requests (reduces UX spam).
    /// This is still subject to ReposRoot path restrictions.
    /// </summary>
    public bool AutoApproveReadPermissions { get; set; } = true;

    /// <summary>How long to wait for a single Copilot turn to finish.</summary>
    [Range(10, 3600)]
    public int TurnTimeoutSeconds { get; set; } = 900;

    /// <summary>
    /// When true, include a small redacted debug dump in permission prompts to help
    /// identify what fields the Copilot SDK is providing (preview SDK varies by version).
    /// </summary>
    public bool DebugPermissionPayload { get; set; } = false;
}
