namespace CopilotDiscordBot.Utils;

public static class PathUtils
{
    public static string NormalizeFullPath(string path)
        => Path.GetFullPath(path.Trim().Trim('"'));

    public static bool IsWithinRoot(string fullPath, string rootFullPath)
    {
        var fp = NormalizeFullPath(fullPath);
        var rp = NormalizeFullPath(rootFullPath);

        if (!rp.EndsWith(Path.DirectorySeparatorChar))
        {
            rp += Path.DirectorySeparatorChar;
        }

        return fp.StartsWith(rp, StringComparison.OrdinalIgnoreCase);
    }

    public static string ResolveRepoPath(string reposRoot, string userInput)
    {
        var input = userInput.Trim().Trim('"');
        if (string.IsNullOrWhiteSpace(input)) throw new ArgumentException("Repo path is required");

        // If user passes a drive-qualified path, accept it (but still enforce root).
        var combined = Path.IsPathRooted(input)
            ? input
            : Path.Combine(reposRoot, input);

        return NormalizeFullPath(combined);
    }
}
