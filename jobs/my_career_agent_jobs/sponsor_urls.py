"""Finds the current download links for the UK and Canada sponsor lists, so the weekly load needs
no hand-copied URLs.

UK: the GOV.UK Content API entry for "Register of licensed sponsors: workers" lists its CSV.
CA: the open.canada.ca catalogue (CKAN) lists the quarterly "Positive LMIA employers" files; the
    newest four English CSV/XLSX files are taken.

Prints shell assignments: UK_URL=... and CA_URLS="a b c d".
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request

UA = {"User-Agent": "MyCareerAgentBot/0.1 (+https://github.com/ayushjainid/my-career-agent)"}


def _get(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def uk_url() -> str | None:
    d = _get("https://www.gov.uk/api/content/government/publications/register-of-licensed-sponsors-workers")
    det = d.get("details", {})
    for a in det.get("attachments", []) or []:
        u = a.get("url") or ""
        if u.lower().endswith(".csv"):
            return u
    for doc in det.get("documents", []) or []:
        m = re.search(r'href="(https://assets\.publishing\.service\.gov\.uk/[^"]+\.csv)"', doc)
        if m:
            return m.group(1)
    return None


def ca_urls(n: int = 4) -> list[str]:
    q = urllib.request.quote("positive labour market impact assessment employers")
    d = _get(f"https://open.canada.ca/data/api/action/package_search?q={q}&rows=5")
    res = []
    for pkg in d.get("result", {}).get("results", []):
        for r in pkg.get("resources", []):
            fmt = (r.get("format") or "").upper()
            langs = r.get("language") or []
            name = json.dumps(r.get("name_translated") or r.get("name") or "")
            if fmt in ("CSV", "XLSX") and ("en" in langs or not langs) and re.search(r"positive|lmia|employ", name, re.I):
                res.append((r.get("created") or r.get("last_modified") or "", fmt, r.get("url")))
        if res:
            break
    res.sort(reverse=True)
    # Prefer CSV for each quarter; the newest n files.
    out: list[str] = []
    for _, fmt, url in res:
        if url and url not in out:
            out.append(url)
        if len(out) >= n:
            break
    return out


def main() -> int:
    try:
        u = uk_url()
    except Exception as e:  # noqa: BLE001
        print(f"echo '::warning::UK register link not found: {e}'")
        u = None
    try:
        c = ca_urls()
    except Exception as e:  # noqa: BLE001
        print(f"echo '::warning::Canada LMIA links not found: {e}'")
        c = []
    print(f"UK_FOUND='{u or ''}'")
    print(f"CA_FOUND='{' '.join(c)}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
