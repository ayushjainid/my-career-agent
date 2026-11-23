from pathlib import Path

import pytest

from my_career_agent_jobs.uk_ca_sponsors import LayoutError, summarise_ca, summarise_uk


def test_uk_register_groups_sites_and_keeps_best_rating(tmp_path: Path):
    f = tmp_path / "register.csv"
    f.write_text(
        "Organisation Name,Town/City,County,Type & Rating,Route\n"
        "Acme Ltd,London,,Worker (A rating),Skilled Worker\n"
        "ACME LIMITED,Leeds,,Worker (B rating),Skilled Worker\n"
        "Acme Ltd,London,,Worker (A rating),Global Business Mobility: Senior or Specialist Worker\n"
        ",,,,\n",
        encoding="utf-8-sig",
    )
    rows = summarise_uk(f)
    skilled = [r for r in rows if '"Skilled Worker"' in str(r["extra"])]
    assert len(skilled) == 1
    assert skilled[0]["employer_norm"] == "ACME"
    assert '"rating": "A"' in str(skilled[0]["extra"]) and '"sites": 2' in str(skilled[0]["extra"])
    assert len(rows) == 2


def test_ca_lmia_sums_positions_under_a_title_row_and_bilingual_header(tmp_path: Path):
    f = tmp_path / "lmia.csv"
    f.write_text(
        "Positive Labour Market Impact Assessment (LMIA) Employers List,,,,\n"
        "Province/Territory,Program Stream,Employer,Occupation,Approved Positions\n"
        "Ontario,High-wage,Globex Inc.,21231-Software engineers,3\n"
        "Ontario,High-wage,GLOBEX INCORPORATED,21211-Data scientists,2\n"
        "Quebec,Low-wage,Initech,65201-Food counter attendants,0\n",
        encoding="utf-8",
    )
    rows = summarise_ca(f)
    assert [(r["employer_norm"], r["filings"]) for r in rows] == [("GLOBEX", 5)]


def test_wrong_file_fails_loudly(tmp_path: Path):
    f = tmp_path / "x.csv"
    f.write_text("a,b\n1,2\n")
    with pytest.raises(LayoutError):
        summarise_uk(f)
