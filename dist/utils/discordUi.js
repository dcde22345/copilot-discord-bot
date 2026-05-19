export function box(title, rows, options = {}) {
    const { footer, icon = "i" } = options;
    const maxKey = rows.reduce((max, r) => Math.max(max, r.key.length), 0);
    const lines = [];
    lines.push(`${icon} **${title}**`);
    lines.push("```text");
    for (const { key, value } of rows) {
        lines.push(`${key.padEnd(maxKey)} : ${value}`);
    }
    lines.push("```");
    if (footer) {
        lines.push(footer);
    }
    return lines.join("\n").trimEnd();
}
export function trimShort(s, max) {
    s = (s ?? "").trim();
    if (s.length <= max)
        return s;
    return s.slice(0, max) + "\u2026";
}
//# sourceMappingURL=discordUi.js.map