"""Company-name normalisation. Must match packages/core/src/names.ts (shared test cases)."""

from __future__ import annotations

import re
import unicodedata

SUFFIXES = {
    "INC", "INCORPORATED", "LLC", "L L C", "LTD", "LIMITED", "CORP", "CORPORATION", "CO", "COMPANY",
    "LP", "LLP", "PLC", "PC", "PLLC", "GMBH", "AG", "BV", "NV", "SA", "SAS", "SARL", "SRL", "PTY",
    "ULC", "THE",
}


def normalize_company_name(name: str) -> str:
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.upper().replace(".", "").replace("&", " AND ")
    s = re.sub(r"[^A-Z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    tokens = [t for t in s.split(" ") if t]
    while len(tokens) > 1 and tokens[-1] in SUFFIXES:
        tokens.pop()
    if len(tokens) > 1 and tokens[0] == "THE":
        tokens.pop(0)
    return " ".join(tokens)
