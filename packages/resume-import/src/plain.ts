// Pasted or plain text → lines. The fallback when someone has no file at hand.
import type { ExtractedDoc, Line } from "./types.js";
import { cleanText, stripBullet } from "./text.js";

export function extractText(text: string): ExtractedDoc {
  const lines: Line[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) continue;
    const parts = raw.split(/\t+|\s{3,}/).map((p) => cleanText(p).trim()).filter(Boolean);
    if (!parts.length) continue;
    const sb = stripBullet(parts[0]!);
    if (sb.bullet && sb.text) parts[0] = sb.text;
    const indent = /^\s*/.exec(raw)![0].length;
    lines.push({ text: parts.join(" "), parts, size: 0, bold: false, italic: false, bullet: sb.bullet, heading: false, indent, gapBefore: 0 });
  }
  return { source: "text", lines, links: [], warnings: [] };
}
