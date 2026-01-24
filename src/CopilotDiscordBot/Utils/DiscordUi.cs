using System.Text;

namespace CopilotDiscordBot.Utils;

public static class DiscordUi
{
    public static string Box(string title, IReadOnlyList<(string Key, string Value)> rows, string? footer = null, string icon = "ℹ️")
    {
        var maxKey = 0;
        foreach (var (key, _) in rows)
        {
            if (key.Length > maxKey) maxKey = key.Length;
        }

        var sb = new StringBuilder();
        sb.AppendLine($"{icon} **{title}**");
        sb.AppendLine("```text");
        foreach (var (key, value) in rows)
        {
            sb.Append(key.PadRight(maxKey));
            sb.Append(" : ");
            sb.AppendLine(value);
        }
        sb.AppendLine("```");

        if (!string.IsNullOrWhiteSpace(footer))
        {
            sb.AppendLine(footer);
        }

        return sb.ToString().TrimEnd();
    }

    public static string Quote(string s) => $"`{s}`";

    public static string TrimShort(string s, int max)
    {
        s = (s ?? string.Empty).Trim();
        if (s.Length <= max) return s;
        return s[..max] + "…";
    }
}
