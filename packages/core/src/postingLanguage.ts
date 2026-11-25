// Which language a posting (or any text) is written in, from how often each language's most common
// words appear. Enough to tell an Italian posting from an English one; returns "other" when unsure.

export type TextLanguage = "en" | "it" | "other";

const STOPWORDS: Record<Exclude<TextLanguage, "other">, Set<string>> = {
  en: new Set("the and of to in a is for with you we our will on are as be your this that or an at by from have who can team work about".split(" ")),
  it: new Set("il la di che e per con del della delle dei degli un una sono nel nella nostro nostra nostri siamo lavoro esperienza competenze sarai ti tuo tua anche come più gli le lo da al alla alle ai si cerchiamo requisiti".split(" ")),
};

export function detectLanguage(text: string): TextLanguage {
  const words = text.toLowerCase().normalize("NFC").match(/[\p{L}']+/gu) ?? [];
  if (words.length < 12) return "other";
  const share = (lang: keyof typeof STOPWORDS) => words.filter((w) => STOPWORDS[lang].has(w)).length / words.length;
  const en = share("en"), it = share("it");
  if (it > 0.08 && it > en * 1.2) return "it";
  if (en > 0.08 && en > it * 1.2) return "en";
  return "other";
}
