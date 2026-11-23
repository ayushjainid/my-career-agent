"""Job-title families for pay comparison. Mirrors packages/core/src/titles.ts exactly;
both run packages/core/test/fixtures/title_cases.json."""

from __future__ import annotations

import re
import unicodedata

LEVEL_WORDS = {
    "senior", "sr", "junior", "jr", "lead", "principal", "staff", "distinguished", "associate", "entry", "level",
    "i", "ii", "iii", "iv", "v", "1", "2", "3", "4", "5", "intern", "head", "chief", "mid",
}
SYNONYMS = [
    (r"\bsoftware development engineer\b", "software engineer"),
    (r"\bsde\b", "software engineer"),
    (r"\bswe\b", "software engineer"),
    (r"\bsoftware developer\b", "software engineer"),
    (r"\bml\b", "machine learning"),
    (r"\bmle\b", "machine learning engineer"),
    (r"\bsre\b", "site reliability engineer"),
    (r"\bpm\b", "product manager"),
]


def title_family(title: str) -> str:
    t = unicodedata.normalize("NFKD", (title or "").lower())
    t = "".join(ch for ch in t if not ("̀" <= ch <= "ͯ"))
    t = re.sub(r"\(.*?\)|\[.*?\]", " ", t)
    t = re.sub(r"[,/|].*$", " ", t)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    for pattern, to in SYNONYMS:
        t = re.sub(pattern, to, t)
    return " ".join(w for w in t.split() if w and w not in LEVEL_WORDS).strip()
