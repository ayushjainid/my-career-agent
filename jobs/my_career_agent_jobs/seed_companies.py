"""Seed or update tracked companies from a CSV.

CSV columns: name, ats_vendor, ats_board, domain, ats_region (optional), aliases (optional, ';'-separated)
Find the board token from a company's careers page:
  greenhouse       boards.greenhouse.io/<token>
  lever            jobs.lever.co/<token>
  ashby            jobs.ashbyhq.com/<token>
  workday          <tenant>.wd<N>.myworkdayjobs.com/<Site>   (the whole host/site, e.g. nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite)
  smartrecruiters  jobs.smartrecruiters.com/<CompanyId>
  workable         apply.workable.com/<account>
  recruitee        <company>.recruitee.com

Usage:
  python -m my_career_agent_jobs.seed_companies companies.csv --database-url "$INGEST_DATABASE_URL"
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

from .names import normalize_company_name

VENDORS = {"greenhouse", "lever", "ashby", "smartrecruiters", "workable", "workday", "recruitee", "other"}


def read_companies(path: Path) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    with path.open(newline="", encoding="utf-8-sig") as f:
        for i, row in enumerate(csv.DictReader(f), start=2):
            name = (row.get("name") or "").strip()
            vendor = (row.get("ats_vendor") or "").strip().lower()
            if not name:
                raise ValueError(f"line {i}: name is required")
            if vendor and vendor not in VENDORS:
                raise ValueError(f"line {i}: unknown ats_vendor {vendor!r}")
            aliases = [normalize_company_name(a) for a in (row.get("aliases") or "").split(";") if a.strip()]
            out.append({
                "name": name,
                "name_norm": normalize_company_name(name),
                "aliases": aliases,
                "domain": (row.get("domain") or "").strip().lower() or None,
                "ats_vendor": vendor or None,
                "ats_board": (row.get("ats_board") or "").strip() or None,
                "ats_region": (row.get("ats_region") or "").strip().lower() or None,
            })
    return out


def upsert(companies: list[dict[str, object]], database_url: str) -> None:
    import psycopg

    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        for c in companies:
            cur.execute(
                """INSERT INTO mca.company (name, name_norm, aliases, domain, ats_vendor, ats_board, ats_region)
                   VALUES (%(name)s, %(name_norm)s, %(aliases)s, %(domain)s, %(ats_vendor)s, %(ats_board)s, %(ats_region)s)
                   ON CONFLICT (ats_vendor, ats_board) DO UPDATE SET
                     name = EXCLUDED.name, name_norm = EXCLUDED.name_norm, aliases = EXCLUDED.aliases,
                     domain = EXCLUDED.domain, ats_region = EXCLUDED.ats_region""",
                c,
            )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("csv", type=Path)
    p.add_argument("--database-url", default=os.environ.get("INGEST_DATABASE_URL"))
    args = p.parse_args(argv)
    companies = read_companies(args.csv)
    if not args.database_url:
        for c in companies:
            print(c)
        print(f"{len(companies)} companies parsed (dry run: no --database-url)")
        return 0
    upsert(companies, args.database_url)
    print(f"upserted {len(companies)} companies")
    return 0


if __name__ == "__main__":
    sys.exit(main())
