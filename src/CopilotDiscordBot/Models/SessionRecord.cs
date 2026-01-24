namespace CopilotDiscordBot.Models;

public sealed record SessionRecord(
    ulong ThreadId,
    ulong GuildId,
    ulong ParentChannelId,
    string CopilotSessionId,
    string? RepoPath,
    string ConfigJson,
    DateTimeOffset CreatedUtc,
    DateTimeOffset UpdatedUtc
);
