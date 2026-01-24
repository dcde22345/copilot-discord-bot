namespace CopilotDiscordBot.Utils;

public static class TextChunker
{
    public static IEnumerable<string> ChunkForDiscord(string text, int maxLen = 1900)
    {
        if (string.IsNullOrEmpty(text)) yield break;
        text = text.Replace("\r\n", "\n");

        var start = 0;
        while (start < text.Length)
        {
            var len = Math.Min(maxLen, text.Length - start);

            // Prefer splitting on newline near the end.
            var split = text.LastIndexOf('\n', start + len - 1, len);
            if (split <= start + 100) split = start + len; // avoid tiny chunks

            var part = text.Substring(start, split - start).TrimEnd();
            if (part.Length > 0) yield return part;

            start = split;
            while (start < text.Length && text[start] == '\n') start++;
        }
    }
}
