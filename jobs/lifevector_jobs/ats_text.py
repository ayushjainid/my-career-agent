"""Extract the text layer of a resume PDF the way an applicant-tracking system reads it.

Output is JSON ({"text", "pages", "extractor"}) for checkTextLayer() in @life-vector/core,
which judges it. Extraction order (pypdf first, pdftotext as fallback, empty output treated as
failure) follows tools/verify_pdf.py in ai-job-search (MIT, Copyright (c) 2026 Mads Lorentzen).
See THIRD_PARTY_NOTICES.md.

Usage: python -m lifevector_jobs.ats_text resume.pdf > layer.json
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


def _extract_pypdf(path: Path):
    try:
        from pypdf import PdfReader
    except ImportError:
        return None
    try:
        reader = PdfReader(str(path))
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
        pages = len(reader.pages)
    except Exception:
        return None
    if not text.split():  # empty or whitespace-only: fall back
        return None
    return text, pages


def _extract_pdftotext(path: Path):
    if not shutil.which("pdftotext"):
        return None
    try:
        text = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"],
            check=True, capture_output=True, timeout=60,
        ).stdout.decode("utf-8", errors="replace")
    except (subprocess.SubprocessError, OSError):
        return None
    pages = None
    if shutil.which("pdfinfo"):
        info = subprocess.run(["pdfinfo", str(path)], capture_output=True, timeout=30).stdout.decode(errors="replace")
        m = re.search(r"^Pages:\s+(\d+)", info, re.M)
        pages = int(m.group(1)) if m else None
    return text, pages


def extract_text_layer(path: Path) -> dict:
    for name, fn in (("pypdf", _extract_pypdf), ("pdftotext", _extract_pdftotext)):
        got = fn(path)
        if got is not None:
            text, pages = got
            return {"text": text, "pages": pages, "extractor": name}
    return {"text": "", "pages": None, "extractor": "none"}


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 1:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    json.dump(extract_text_layer(Path(args[0])), sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
