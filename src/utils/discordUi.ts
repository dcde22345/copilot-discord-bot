export interface BoxRow {
  key: string;
  value: string;
}

export function box(
  title: string,
  rows: BoxRow[],
  options: { footer?: string; icon?: string } = {}
): string {
  const { footer, icon = "i" } = options;

  const maxKey = rows.reduce((max, r) => Math.max(max, r.key.length), 0);

  const lines: string[] = [];
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

export function trimShort(s: string, max: number): string {
  s = (s ?? "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + "\u2026";
}
