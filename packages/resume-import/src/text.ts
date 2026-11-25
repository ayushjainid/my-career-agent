// Text clean-up shared by every extractor.

/** Ligatures and presentation forms folded to plain letters; odd spaces and dashes normalised. */
export function cleanText(s: string): string {
  return s
    .replace(/[ﬀ-ﬆ]/g, (c) => c.normalize("NFKC"))
    .replace(/[  -   　]/g, " ")
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/[‐‑]/g, "-")
    .replace(/\s+/g, " ")
    .normalize("NFC");
}

/** Leading bullet glyphs and list markers that start a resume bullet. */
export const BULLET_RE = /^\s*(?:[•●○◦▪▫■□◆◇►▸▹‣⁃∙·⦁⦾⦿✓✔➢➤→\-–—*]||||||o(?=\s))\s*/u;

export function stripBullet(s: string): { text: string; bullet: boolean } {
  const m = BULLET_RE.exec(s);
  if (!m) return { text: s, bullet: false };
  // A dash followed by a digit is a negative number or a date range, not a bullet.
  if (/^[-–—]\s*\d/.test(s.trim())) return { text: s, bullet: false };
  return { text: s.slice(m[0].length), bullet: true };
}

/**
 * pdfTeX writes T1 (Cork) encoded bitmap fonts as Type3, and many PDF readers then show the raw
 * codes: "Air\u001dow" for "Airflow", "¢" for "ć", "\u0015" for an en dash. This maps them back.
 */
const CORK_LOW = ["`", "´", "ˆ", "˜", "¨", "˝", "˚", "ˇ", "˘", "¯", "˙", "¸", "˛", "‚", "‹", "›", "“", "”", "„", "«", "»", "–", "—", "", "0", "ı", "ȷ", "ff", "fi", "fl", "ffi", "ffl"];
const CORK_HIGH = "ĂĄĆČĎĚĘĞĹĽŁŃŇŊŐŔŘŚŠŞŤŢŰŮŸŹŽŻĲİđ§ăąćčďěęğĺľłńňŋőŕřśšşťţűůÿźžżĳ¡¿£";
export function decodeCork(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20) out += CORK_LOW[c];
    else if (c === 0x7f) out += "-";
    else if (c >= 0x80 && c <= 0xbf) out += [...CORK_HIGH][c - 0x80];
    else if (c === 0xd7) out += "Œ";
    else if (c === 0xdf) out += "SS";
    else if (c === 0xf7) out += "œ";
    else if (c === 0xff) out += "ß";
    else out += ch;
  }
  return out;
}

/** True when a font name says bold (PostScript names, TeX font names such as CMBX or SFBX). */
export function isBoldFont(name: string): boolean {
  return /bold|black|heavy|semibold|demi|[-,]B$|\b(?:cmbx|sfbx|ecbx|lmroman\d+-bold)|BX\d/i.test(name);
}
export function isItalicFont(name: string): boolean {
  return /italic|oblique|[-,]I$|\b(?:cmti|sfti|ecti|cmsl|sfsl)|TI\d/i.test(name);
}
