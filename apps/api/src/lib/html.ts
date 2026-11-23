// HTML-to-text for job descriptions now goes through the posting integrity check in core, so
// hidden text never reaches the scorer. These wrappers keep the old call sites working.

import { decodeEntities, guardPosting, type IntegrityReport } from "@my-career-agent/core";

export { decodeEntities };

export function htmlToText(html: string): string {
  return guardPosting(html, "html").text;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Join plain-text and HTML parts of one posting and run the integrity check once over all of it.
 * Plain parts are escaped so their characters are read as text, not markup.
 */
export function guardedDescription(parts: Array<{ html?: string | null; plain?: string | null }>): {
  text: string;
  integrity: IntegrityReport;
} {
  const markup = parts
    .map((p) => (p.html ? `<div>${p.html}</div>` : p.plain ? `<div>${escapeHtml(p.plain).replace(/\n/g, "<br>")}</div>` : ""))
    .filter(Boolean)
    .join("\n");
  const { text, report } = guardPosting(markup, "html");
  return { text, integrity: report };
}
