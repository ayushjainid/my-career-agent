"""US sponsor data from the Department of Labor (OFLC) public disclosure files.

Source: https://www.dol.gov/agencies/eta/foreign-labor/performance
  * LCA file (H-1B, H-1B1, E-3): one row per Labor Condition Application.
  * PERM file (Form ETA-9089): one row per permanent labor certification case.

Output: one summary row per employer x occupation (SOC) x source, matching the mca.sponsor_record table.
The OFLC record layouts change between fiscal years, so columns are resolved from alias lists and
the job fails loudly, listing the columns it saw, if a required field is missing.

Usage:
  python -m my_career_agent_jobs.us_dol --lca LCA.xlsx --perm PERM.xlsx --out out/ [--database-url URL]
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Iterable

import pandas as pd
from openpyxl import load_workbook

from .names import normalize_company_name

# --------------------------------------------------------------------------------------------
# Column resolution
# --------------------------------------------------------------------------------------------
LCA_COLUMNS: dict[str, list[str]] = {
    "case_status": ["CASE_STATUS"],
    "decision_date": ["DECISION_DATE"],
    "received_date": ["RECEIVED_DATE", "CASE_SUBMITTED"],
    "visa_class": ["VISA_CLASS"],
    "employer_name": ["EMPLOYER_NAME", "EMPLOYER_BUSINESS_NAME"],
    "employer_fein": ["EMPLOYER_FEIN"],
    "soc_code": ["SOC_CODE"],
    "wage_level": ["PW_WAGE_LEVEL", "PREVAILING_WAGE_LEVEL", "PW_WAGE_LEVEL_1"],
}
LCA_REQUIRED = {"case_status", "employer_name", "visa_class"}

PERM_COLUMNS: dict[str, list[str]] = {
    "case_status": ["CASE_STATUS"],
    "decision_date": ["DECISION_DATE"],
    "received_date": ["RECEIVED_DATE"],
    "employer_name": ["EMP_BUSINESS_NAME", "EMPLOYER_NAME", "EMPLOYER_BUSINESS_NAME"],
    "employer_fein": ["EMP_FEIN", "EMPLOYER_FEIN"],
    "soc_code": ["PWD_SOC_CODE", "PW_SOC_CODE", "SOC_CODE", "JOB_OPP_SOC_CODE"],
}
PERM_REQUIRED = {"case_status", "employer_name"}


class LayoutError(ValueError):
    pass


def read_header(path: Path) -> list[str]:
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as f:
            return [h.strip() for h in next(csv.reader(f))]
    wb = load_workbook(path, read_only=True)
    try:
        first = next(wb.worksheets[0].iter_rows(min_row=1, max_row=1, values_only=True))
    finally:
        wb.close()
    return [str(h).strip() if h is not None else "" for h in first]


def resolve_columns(header: list[str], spec: dict[str, list[str]], required: set[str], label: str) -> dict[str, str]:
    upper = {h.upper(): h for h in header}
    resolved: dict[str, str] = {}
    for key, aliases in spec.items():
        for a in aliases:
            if a in upper:
                resolved[key] = upper[a]
                break
    missing = required - resolved.keys()
    if missing:
        raise LayoutError(
            f"{label}: missing required columns {sorted(missing)}. "
            f"Saw: {', '.join(header[:60])}{' ...' if len(header) > 60 else ''}"
        )
    return resolved


def load_frame(path: Path, spec: dict[str, list[str]], required: set[str], label: str) -> pd.DataFrame:
    cols = resolve_columns(read_header(path), spec, required, label)
    usecols = list(cols.values())
    if path.suffix.lower() == ".csv":
        df = pd.read_csv(path, usecols=usecols, dtype=str, encoding="utf-8-sig")
    else:
        df = pd.read_excel(path, usecols=usecols, dtype=str, engine="openpyxl")
    df = df.rename(columns={v: k for k, v in cols.items()})
    for key in spec:
        if key not in df.columns:
            df[key] = None
    return df


# --------------------------------------------------------------------------------------------
# Summaries
# --------------------------------------------------------------------------------------------
@dataclass
class Summary:
    source: str
    employer_name: str
    employer_norm: str
    employer_fein: str | None
    occupation_code: str | None
    filings: int = 0
    certified: int = 0
    denied: int = 0
    withdrawn: int = 0
    period_start: str | None = None
    period_end: str | None = None
    wage_levels: dict[str, int] = field(default_factory=dict)


def _status(s: object) -> str:
    return str(s or "").strip().upper()


def _soc(s: object) -> str | None:
    v = str(s or "").strip()
    if not v or v.upper() == "NAN":
        return None
    return v[:7]  # "15-1252.00" -> "15-1252"


def _wage_level(s: object) -> str | None:
    v = str(s or "").strip().upper().replace("LEVEL", "").strip()
    return v if v in {"I", "II", "III", "IV"} else None


def _dates(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series, errors="coerce")


def summarise(df: pd.DataFrame, source: str) -> list[Summary]:
    """Groups filings by normalised employer and SOC. Expects canonical column names."""
    if df.empty:
        return []
    df = df.copy()
    df["employer_norm"] = df["employer_name"].fillna("").map(normalize_company_name)
    df = df[df["employer_norm"] != ""]
    df["status"] = df["case_status"].map(_status)
    df["soc"] = df["soc_code"].map(_soc)
    df["decided"] = _dates(df["decision_date"])

    out: list[Summary] = []
    for (norm, soc), g in df.groupby(["employer_norm", df["soc"].fillna("")], sort=True):
        names = g["employer_name"].dropna()
        feins = g["employer_fein"].dropna()
        statuses = g["status"]
        s = Summary(
            source=source,
            employer_name=str(names.mode().iat[0]) if not names.empty else str(norm),
            employer_norm=str(norm),
            employer_fein=str(feins.mode().iat[0]) if not feins.empty else None,
            occupation_code=soc or None,
            filings=int(len(g)),
            # LCA "CERTIFIED - WITHDRAWN" still shows intent to sponsor; PERM "CERTIFIED-EXPIRED" was certified.
            certified=int(statuses.str.startswith("CERTIFIED").sum()),
            denied=int((statuses == "DENIED").sum()),
            withdrawn=int((statuses == "WITHDRAWN").sum()),
        )
        dates = g["decided"].dropna()
        if not dates.empty:
            s.period_start = dates.min().date().isoformat()
            s.period_end = dates.max().date().isoformat()
        if "wage_level" in g:
            levels = Counter(l for l in g["wage_level"].map(_wage_level) if l)
            s.wage_levels = dict(sorted(levels.items()))
        out.append(s)
    return out


def summarise_lca(path: Path) -> list[Summary]:
    df = load_frame(path, LCA_COLUMNS, LCA_REQUIRED, "LCA file")
    df = df[df["visa_class"].fillna("").str.upper().str.strip() == "H-1B"]
    return summarise(df, "dol_lca")


def summarise_perm(path: Path) -> list[Summary]:
    df = load_frame(path, PERM_COLUMNS, PERM_REQUIRED, "PERM file")
    return summarise(df, "dol_perm")


# --------------------------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------------------------
FIELDS = [
    "country", "source", "employer_name", "employer_norm", "employer_fein", "occupation_code",
    "period_start", "period_end", "filings", "certified", "denied", "withdrawn", "wage_levels", "source_file",
]


def to_rows(summaries: Iterable[Summary], source_file: str) -> list[dict[str, object]]:
    return [
        {
            "country": "US",
            "source": s.source,
            "employer_name": s.employer_name,
            "employer_norm": s.employer_norm,
            "employer_fein": s.employer_fein,
            "occupation_code": s.occupation_code,
            "period_start": s.period_start,
            "period_end": s.period_end,
            "filings": s.filings,
            "certified": s.certified,
            "denied": s.denied,
            "withdrawn": s.withdrawn,
            "wage_levels": json.dumps(s.wage_levels) if s.wage_levels else None,
            "source_file": source_file,
        }
        for s in summaries
    ]


def write_csv(rows: list[dict[str, object]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)


def load_to_postgres(rows: list[dict[str, object]], database_url: str) -> None:
    """Replaces all rows from the same source file in one transaction (idempotent re-runs)."""
    import psycopg  # optional dependency: pip install .[db]

    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        for source, source_file in sorted({(r["source"], r["source_file"]) for r in rows}):
            cur.execute(
                "DELETE FROM mca.sponsor_record WHERE country = 'US' AND source = %s AND source_file = %s",
                (source, source_file),
            )
        cur.executemany(
            f"INSERT INTO mca.sponsor_record ({', '.join(FIELDS)}) "
            f"VALUES ({', '.join(['%s'] * len(FIELDS))})",
            [tuple(r[f] for f in FIELDS) for r in rows],
        )
        # Link to known companies by normalised name; unmatched rows wait for entity resolution.
        cur.execute(
            """UPDATE mca.sponsor_record s SET company_id = c.id
               FROM mca.company c
               WHERE s.company_id IS NULL AND s.country = 'US'
                 AND (c.name_norm = s.employer_norm OR s.employer_norm = ANY (c.aliases))"""
        )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lca", type=Path, help="OFLC LCA disclosure file (.xlsx or .csv)")
    p.add_argument("--perm", type=Path, help="OFLC PERM disclosure file (.xlsx or .csv)")
    p.add_argument("--out", type=Path, default=Path("out"))
    p.add_argument("--database-url", default=os.environ.get("INGEST_DATABASE_URL"))
    args = p.parse_args(argv)
    if not args.lca and not args.perm:
        p.error("give --lca and/or --perm")

    rows: list[dict[str, object]] = []
    for path, fn in ((args.lca, summarise_lca), (args.perm, summarise_perm)):
        if not path:
            continue
        summaries = fn(path)
        batch = to_rows(summaries, path.name)
        write_csv(batch, args.out / f"{path.stem}.summary.csv")
        print(f"{path.name}: {sum(s.filings for s in summaries)} filings -> {len(summaries)} employer/SOC rows")
        rows.extend(batch)

    pay_rows: list[dict[str, object]] = []
    if args.lca:
        from .pay_lca import summarise_pay
        try:
            pay_rows = summarise_pay(args.lca)
            print(f"{args.lca.name}: {len(pay_rows)} pay benchmark rows")
        except LayoutError as err:  # older layouts without wage columns: sponsors still load
            print(f"pay benchmarks skipped: {err}")

    if args.database_url:
        load_to_postgres(rows, args.database_url)
        print(f"loaded {len(rows)} rows into mca.sponsor_record")
        if pay_rows:
            from .pay_lca import load_pay_to_postgres
            load_pay_to_postgres(pay_rows, args.database_url)
            print(f"loaded {len(pay_rows)} rows into mca.pay_benchmark")
    return 0


if __name__ == "__main__":
    sys.exit(main())
