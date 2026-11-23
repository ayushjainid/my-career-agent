"""UK and Canada sponsor data (beta loop B7).

UK: Home Office "Register of licensed sponsors: workers", a CSV published daily at
    https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers
    Columns: Organisation Name, Town/City, County, Type & Rating, Route.
CA: ESDC "Positive Labour Market Impact Assessment (LMIA) employers list", quarterly CSV/XLSX at
    https://open.canada.ca (search "positive LMIA employers"). Bilingual headers; a title row or
    two may come first. Columns include Employer, Occupation and Approved Positions.

Both write mca.sponsor_record rows (country GB or CA), replacing earlier rows from the same file.

Usage:
  python -m my_career_agent_jobs.uk_ca_sponsors --uk register.csv [--ca lmia.csv] [--database-url URL]
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

from .names import normalize_company_name


class LayoutError(ValueError):
    pass


def _read_rows(path: Path) -> list[list[str]]:
    if path.suffix.lower() in {".xlsx", ".xlsm"}:
        from openpyxl import load_workbook
        wb = load_workbook(path, read_only=True, data_only=True)
        return [["" if c is None else str(c) for c in r] for r in wb.active.iter_rows(values_only=True)]
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    return list(csv.reader(io.StringIO(text)))


def _header(rows: list[list[str]], must: list[list[str]], label: str) -> tuple[int, dict[str, int]]:
    """Find the header row: the first row containing one alias of every required column."""
    for i, row in enumerate(rows[:20]):
        names = [re.sub(r"\s+", " ", c).strip().lower() for c in row]
        found: dict[str, int] = {}
        for aliases in must:
            for a in aliases:
                hit = next((j for j, n in enumerate(names) if n == a or n.startswith(a + " /") or n.startswith(a + "/")), None)
                if hit is not None:
                    found[aliases[0]] = hit
                    break
        if len(found) == len(must):
            return i, found
    raise LayoutError(f"{label}: header not found; expected columns like {[m[0] for m in must]}. First row seen: {rows[0] if rows else []}")


def summarise_uk(path: Path) -> list[dict[str, object]]:
    rows = _read_rows(path)
    h, col = _header(rows, [["organisation name"], ["type & rating", "type and rating"], ["route"]], "UK register")
    groups: dict[str, dict[str, object]] = {}
    for r in rows[h + 1:]:
        name = (r[col["organisation name"]] if len(r) > col["organisation name"] else "").strip()
        route = (r[col["route"]] if len(r) > col["route"] else "").strip()
        rating_text = r[col["type & rating"]] if len(r) > col["type & rating"] else ""
        norm = normalize_company_name(name)
        if not norm or not route:
            continue
        m = re.search(r"\(([AB])\b[^)]*\)", rating_text)
        rating = m.group(1) if m else None
        g = groups.setdefault(f"{norm}|{route}", {"name": name, "norm": norm, "route": route, "rating": rating, "n": 0})
        g["n"] = int(g["n"]) + 1
        if rating and (g["rating"] is None or rating < str(g["rating"])):
            g["rating"] = rating  # "A" sorts before "B": keep the best
    return [
        {"country": "GB", "source": "ukvi_register", "employer_name": g["name"], "employer_norm": g["norm"], "employer_fein": None,
         "occupation_code": None, "period_start": None, "period_end": None, "filings": 1, "certified": 1, "denied": 0, "withdrawn": 0,
         "wage_levels": None, "extra": json.dumps({"route": g["route"], "rating": g["rating"], "sites": g["n"]})}
        for g in groups.values()
    ]


def summarise_ca(path: Path) -> list[dict[str, object]]:
    rows = _read_rows(path)
    h, col = _header(rows, [["employer"], ["approved positions", "approved positions/postes approuvés", "postes approuvés"]], "CA LMIA list")
    occ = None
    names = [c.strip().lower() for c in rows[h]]
    for j, n in enumerate(names):
        if n.startswith("occupation"):
            occ = j
    totals: dict[str, dict[str, object]] = defaultdict(lambda: {"positions": 0, "name": "", "occupations": set()})
    for r in rows[h + 1:]:
        name = (r[col["employer"]] if len(r) > col["employer"] else "").strip()
        norm = normalize_company_name(name)
        if not norm:
            continue
        try:
            positions = int(float(re.sub(r"[^0-9.]", "", r[col["approved positions"]]) or 0))
        except (ValueError, IndexError):
            positions = 0
        t = totals[norm]
        t["name"] = t["name"] or name
        t["positions"] = int(t["positions"]) + positions
        if occ is not None and len(r) > occ and r[occ].strip():
            t["occupations"].add(r[occ].strip()[:80])
    return [
        {"country": "CA", "source": "esdc_lmia", "employer_name": t["name"], "employer_norm": norm, "employer_fein": None,
         "occupation_code": None, "period_start": None, "period_end": None, "filings": t["positions"], "certified": t["positions"],
         "denied": 0, "withdrawn": 0, "wage_levels": None, "extra": json.dumps({"occupations": sorted(t["occupations"])[:10]})}
        for norm, t in totals.items() if int(t["positions"]) > 0
    ]


FIELDS = ["country", "source", "employer_name", "employer_norm", "employer_fein", "occupation_code", "period_start", "period_end",
          "filings", "certified", "denied", "withdrawn", "wage_levels", "extra", "source_file"]


def load(rows: list[dict[str, object]], source_file: str, database_url: str) -> None:
    import psycopg

    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        for country, source in sorted({(r["country"], r["source"]) for r in rows}):
            cur.execute("DELETE FROM mca.sponsor_record WHERE country = %s AND source = %s AND source_file = %s", (country, source, source_file))
        cur.executemany(
            f"INSERT INTO mca.sponsor_record ({', '.join(FIELDS)}) VALUES ({', '.join(['%s'] * len(FIELDS))})",
            [tuple({**r, "source_file": source_file}[f] for f in FIELDS) for r in rows],
        )
        cur.execute(
            """UPDATE mca.sponsor_record s SET company_id = c.id FROM mca.company c
               WHERE s.company_id IS NULL AND s.country IN ('GB', 'CA')
                 AND (c.name_norm = s.employer_norm OR s.employer_norm = ANY (c.aliases))"""
        )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--uk", type=Path)
    p.add_argument("--ca", type=Path)
    p.add_argument("--database-url", default=os.environ.get("INGEST_DATABASE_URL"))
    args = p.parse_args(argv)
    if not args.uk and not args.ca:
        p.error("give --uk and/or --ca")
    for path, fn in ((args.uk, summarise_uk), (args.ca, summarise_ca)):
        if not path:
            continue
        rows = fn(path)
        print(f"{path.name}: {len(rows)} employers")
        if args.database_url:
            load(rows, path.name, args.database_url)
            print(f"loaded {len(rows)} rows into mca.sponsor_record")
    return 0


if __name__ == "__main__":
    sys.exit(main())
