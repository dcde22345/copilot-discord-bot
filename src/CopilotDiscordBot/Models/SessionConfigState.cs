using System.Text.Json;

namespace CopilotDiscordBot.Models;

public sealed class SessionConfigState
{
    public string? Model { get; set; }
    public bool Streaming { get; set; } = false;

    public List<string>? AvailableTools { get; set; }
    public List<string>? ExcludedTools { get; set; }

    // Copilot SDK supports MCP servers, custom agents, skill dirs, disabled skills.
    public JsonElement? McpServers { get; set; }
    public JsonElement? CustomAgents { get; set; }

    public List<string>? SkillDirectories { get; set; }
    public List<string>? DisabledSkills { get; set; }

    public bool? AutoApprovePermissions { get; set; }

    public static SessionConfigState Default(string defaultModel) => new() { Model = defaultModel };
}
