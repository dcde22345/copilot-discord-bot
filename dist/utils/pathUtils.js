import path from "path";
export function normalizeFullPath(p) {
    return path.resolve(p.trim().replace(/^"|"$/g, ""));
}
export function isWithinRoot(fullPath, rootFullPath) {
    const fp = normalizeFullPath(fullPath);
    let rp = normalizeFullPath(rootFullPath);
    if (!rp.endsWith(path.sep)) {
        rp += path.sep;
    }
    return fp.toLowerCase().startsWith(rp.toLowerCase());
}
export function resolveRepoPath(reposRoot, userInput) {
    const input = userInput.trim().replace(/^"|"$/g, "");
    if (!input)
        throw new Error("Repo path is required");
    const combined = path.isAbsolute(input)
        ? input
        : path.join(reposRoot, input);
    return normalizeFullPath(combined);
}
//# sourceMappingURL=pathUtils.js.map