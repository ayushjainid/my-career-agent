"""Pay benchmarks from the H-1B LCA disclosure file: what employers declared they would pay,
per employer and job-title family, as annual percentiles. Certified H-1B filings only.

These are offered wages on approved LCAs, not total compensation (no bonus or equity), and
the product labels them that way.
"""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

from .names import normalize_company_name
from .titles import title_family
from .us_dol import LayoutError, load_frame

PAY_COLUMNS: dict[str, list[str]] = {
    "case_status": ["CASE_STATUS"],
    "visa_class": ["VISA_CLASS"],
    "employer_name": ["EMPLOYER_NAME", "EMPLOYER_BUSINESS_NAME"],
    "job_title": ["JOB_TITLE"],
    "wage_from": ["WAGE_RATE_OF_PAY_FROM", "WAGE_RATE_OF_PAY", "WAGE_FROM"],
    "wage_unit": ["WAGE_UNIT_OF_PAY", "WAGE_UNIT"],
    "decision_date": ["DECISION_DATE"],
}
PAY_REQUIRED = {"case_status", "visa_class", "employer_name", "job_title", "wage_from", "wage_unit"}

PER_YEAR = {"year": 1, "month": 12, "bi-weekly": 26, "biweekly": 26, "week": 52, "hour": 2080}
MIN_EMPLOYER = 3   # fewer filings than this say little, and can point at one person's salary
MIN_MARKET = 10


def _money(v: object) -> float | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = re.sub(r"[^0-9.]", "", str(v))
    try:
        x = float(s)
    except ValueError:
        return None
    return x if x > 0 else None


def annualise(amount: object, unit: object) -> float | None:
    a = _money(amount)
    f = PER_YEAR.get(str(unit or "").strip().lower())
    if a is None or f is None:
        return None
    y = a * f
    return y if 15_000 <= y <= 2_000_000 else None   # drops obvious data-entry errors


def summarise_pay(path: Path, source_file: str | None = None) -> list[dict[str, object]]:
    try:
        df = load_frame(path, PAY_COLUMNS, PAY_REQUIRED, "LCA file (pay)")
    except LayoutError:
        raise
    df = df[(df["visa_class"].fillna("").str.upper().str.strip() == "H-1B")
            & (df["case_status"].fillna("").str.upper().str.startswith("CERTIFIED"))].copy()
    df["annual"] = [annualise(a, u) for a, u in zip(df["wage_from"], df["wage_unit"])]
    df["employer_norm"] = df["employer_name"].fillna("").map(normalize_company_name)
    df["family"] = df["job_title"].fillna("").map(title_family)
    df = df[(df["annual"].notna()) & (df["employer_norm"] != "") & (df["family"] != "")]
    period_end = None
    if "decision_date" in df and df["decision_date"].notna().any():
        period_end = pd.to_datetime(df["decision_date"], errors="coerce").max().date().isoformat()
    out: list[dict[str, object]] = []

    def row(employer: str, family: str, values: pd.Series) -> dict[str, object]:
        q = values.quantile([0.25, 0.5, 0.75])
        return {"country": "US", "employer_norm": employer, "title_family": family, "n": int(len(values)),
                "p25": round(float(q.loc[0.25])), "p50": round(float(q.loc[0.5])), "p75": round(float(q.loc[0.75])),
                "currency": "USD", "source_file": source_file or path.name, "period_end": period_end}

    for (emp, fam), g in df.groupby(["employer_norm", "family"], sort=True):
        if len(g) >= MIN_EMPLOYER:
            out.append(row(str(emp), str(fam), g["annual"]))
    for fam, g in df.groupby("family", sort=True):
        if len(g) >= MIN_MARKET:
            out.append(row("*", str(fam), g["annual"]))
    return out


PAY_FIELDS = ["country", "employer_norm", "title_family", "n", "p25", "p50", "p75", "currency", "source_file", "period_end"]


def load_pay_to_postgres(rows: list[dict[str, object]], database_url: str) -> None:
    import psycopg

    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        for source_file in sorted({str(r["source_file"]) for r in rows}):
            cur.execute("DELETE FROM mca.pay_benchmark WHERE country = 'US' AND source_file = %s", (source_file,))
        cur.executemany(
            f"INSERT INTO mca.pay_benchmark ({', '.join(PAY_FIELDS)}) VALUES ({', '.join(['%s'] * len(PAY_FIELDS))})",
            [tuple(r[f] for f in PAY_FIELDS) for r in rows],
        )
        cur.execute(
            """UPDATE mca.pay_benchmark p SET company_id = c.id FROM mca.company c
               WHERE p.company_id IS NULL AND p.employer_norm <> '*'
                 AND (c.name_norm = p.employer_norm OR p.employer_norm = ANY (c.aliases))"""
        )
