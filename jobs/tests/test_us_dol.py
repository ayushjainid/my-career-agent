import json
from pathlib import Path

import pytest
from openpyxl import Workbook

from lifevector_jobs.names import normalize_company_name
from lifevector_jobs.us_dol import LayoutError, main, summarise_lca, summarise_perm

ROOT = Path(__file__).resolve().parents[2]


def write_xlsx(path: Path, header: list[str], rows: list[list[object]]) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.append(header)
    for r in rows:
        ws.append(r)
    wb.save(path)
    return path


LCA_HEADER = ["CASE_NUMBER", "CASE_STATUS", "RECEIVED_DATE", "DECISION_DATE", "VISA_CLASS", "JOB_TITLE",
              "SOC_CODE", "EMPLOYER_NAME", "EMPLOYER_FEIN", "PW_WAGE_LEVEL"]


def test_name_normalisation_matches_typescript_cases():
    cases = json.loads((ROOT / "packages/core/test/fixtures/name_cases.json").read_text())
    for raw, expected in cases:
        assert normalize_company_name(raw) == expected, raw


def test_lca_summary_groups_by_employer_and_soc(tmp_path):
    f = write_xlsx(tmp_path / "lca.xlsx", LCA_HEADER, [
        ["I-1", "Certified", "2026-01-02", "2026-01-09", "H-1B", "SWE", "15-1252.00", "Example Co, Inc.", "12-3456789", "II"],
        ["I-2", "Certified - Withdrawn", "2026-02-02", "2026-02-09", "H-1B", "SWE", "15-1252.00", "EXAMPLE CO INC", "12-3456789", "III"],
        ["I-3", "Denied", "2026-03-02", "2026-03-09", "H-1B", "SWE", "15-1252.00", "Example Co", "12-3456789", "Level I"],
        ["I-4", "Certified", "2026-03-02", "2026-03-10", "E-3 Australian", "SWE", "15-1252.00", "Example Co", "12-3456789", "II"],
        ["I-5", "Certified", "2026-04-02", "2026-04-09", "H-1B", "Analyst", "15-2051.01", "Example Co", "12-3456789", "IV"],
        ["I-6", "Withdrawn", "2026-04-02", "2026-04-09", "H-1B", "Nurse", "29-1141.00", "Other Hospital LLC", None, None],
    ])
    rows = {(s.employer_norm, s.occupation_code): s for s in summarise_lca(f)}
    swe = rows[("EXAMPLE", "15-1252")]
    assert (swe.filings, swe.certified, swe.denied) == (3, 2, 1)  # E-3 row excluded
    assert swe.wage_levels == {"I": 1, "II": 1, "III": 1}
    assert (swe.period_start, swe.period_end) == ("2026-01-09", "2026-03-09")
    assert rows[("EXAMPLE", "15-2051")].filings == 1
    assert rows[("OTHER HOSPITAL", "29-1141")].withdrawn == 1


def test_perm_summary_counts_certified_expired_as_certified(tmp_path):
    f = write_xlsx(tmp_path / "perm.xlsx",
                   ["CASE_NUMBER", "CASE_STATUS", "RECEIVED_DATE", "DECISION_DATE", "EMP_BUSINESS_NAME", "EMP_FEIN", "PWD_SOC_CODE"], [
        ["G-1", "Certified", "2025-01-01", "2025-09-01", "Example Co", "12-3456789", "15-1252"],
        ["G-2", "Certified-Expired", "2025-01-01", "2025-09-02", "Example Co", "12-3456789", "15-1252"],
        ["G-3", "Denied", "2025-01-01", "2025-09-03", "Example Co", "12-3456789", "15-1252"],
    ])
    [s] = summarise_perm(f)
    assert (s.source, s.certified, s.denied, s.filings) == ("dol_perm", 2, 1, 3)


def test_layout_change_fails_loudly(tmp_path):
    f = write_xlsx(tmp_path / "bad.xlsx", ["CASE_NUMBER", "STATUS"], [["X", "Certified"]])
    with pytest.raises(LayoutError, match="missing required columns"):
        summarise_lca(f)


def test_cli_writes_csv(tmp_path):
    f = write_xlsx(tmp_path / "lca.xlsx", LCA_HEADER, [
        ["I-1", "Certified", "2026-01-02", "2026-01-09", "H-1B", "SWE", "15-1252.00", "Example Co", "12-3456789", "II"],
    ])
    assert main(["--lca", str(f), "--out", str(tmp_path / "out")]) == 0
    text = (tmp_path / "out" / "lca.summary.csv").read_text()
    assert ",EXAMPLE," in text and '"{""II"": 1}"' in text
