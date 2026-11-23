from pathlib import Path

import pytest

from my_career_agent_jobs.ats_text import extract_text_layer

reportlab = pytest.importorskip("reportlab")


def _pdf(tmp_path: Path, lines: list[str]) -> Path:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas

    path = tmp_path / "cv.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = 720
    for line in lines:
        c.drawString(72, y, line)
        y -= 18
    c.save()
    return path


def test_extracts_text_and_pages(tmp_path):
    out = extract_text_layer(_pdf(tmp_path, ["Jane Doe", "jane@example.com", "Acme 2018 - 2024"]))
    assert out["extractor"] == "pypdf"
    assert out["pages"] == 1
    assert "jane@example.com" in out["text"]


def test_image_only_pdf_has_no_text(tmp_path):
    out = extract_text_layer(_pdf(tmp_path, []))
    assert out["text"].strip() == ""
