"""Held-out fixtures: written after the extractor was tuned on make_fixtures.py, in layouts it has not seen.

c: Word file with the name and contact in the page header, "Title at Company" and "Company — Title"
   lines, a summary, awards, "Summer 2020" dates; exported to PDF with LibreOffice.
d: a European CV: awesome-cv LaTeX source (not compiled: the class isn't installed here) and a
   reportlab-drawn PDF with dates in a left column, German section names and "heute".
"""
import pathlib
import shutil
import subprocess
import tempfile

from docx import Document
from docx.shared import Pt, Inches
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

OUT = pathlib.Path(__file__).resolve().parent.parent / "test" / "fixtures"


def c_docx():
    d = Document()
    s = d.sections[0]
    s.left_margin = s.right_margin = Inches(0.8)
    hp = s.header.paragraphs[0]
    r = hp.add_run("Maria Okonkwo-Silva")
    r.bold = True
    r.font.size = Pt(18)
    s.header.add_paragraph("Toronto, ON, Canada | maria.os@example.org | 416-555-0199 | mariaos.dev")
    d.add_heading("Summary", level=2)
    d.add_paragraph("Product designer with 6 years of experience shipping consumer fintech and health apps.")
    d.add_heading("Work Experience", level=2)
    p = d.add_paragraph()
    p.add_run("Lead Product Designer at Fabrikam Health").bold = True
    d.add_paragraph("Toronto, ON · January 2022 – Present")
    d.add_paragraph("Redesigned onboarding for 1.2M patients, lifting completion from 54% to 81%", style="List Bullet")
    d.add_paragraph("Built the design system used by 9 product teams", style="List Bullet")
    p = d.add_paragraph()
    p.add_run("Tailspin Bank — Product Designer").bold = True
    d.add_paragraph("Vancouver, BC · Sep 2019 – Dec 2021")
    d.add_paragraph("Shipped a budgeting feature used by 300k customers in its first quarter", style="List Bullet")
    p = d.add_paragraph()
    p.add_run("Design Intern, Contoso Studio").bold = True
    d.add_paragraph("Summer 2018")
    d.add_paragraph("Prototyped 12 concepts for a museum wayfinding app", style="List Bullet")
    d.add_heading("Education", level=2)
    p = d.add_paragraph()
    p.add_run("OCAD University").bold = True
    d.add_paragraph("Bachelor of Design, Interaction Design, 2015 – 2019")
    d.add_heading("Skills", level=2)
    d.add_paragraph("Figma • Prototyping • User Research • Design Systems • Accessibility (WCAG) • HTML/CSS")
    d.add_heading("Awards", level=2)
    d.add_paragraph("Fintech Design Award, 2021")
    d.add_heading("Languages", level=2)
    d.add_paragraph("English – Fluent; Portuguese – Native; French – Conversational")
    d.save(OUT / "c-header.docx")
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", tmp, str(OUT / "c-header.docx")], check=True, capture_output=True)
        shutil.copy(pathlib.Path(tmp) / "c-header.pdf", OUT / "c-header.pdf")


AWESOME = r"""
\documentclass[11pt, a4paper]{awesome-cv}
\name{Jonas}{Becker}
\position{Machine Learning Engineer}
\address{Berlin, Germany}
\mobile{(+49) 151 2345 6789}
\email{jonas.becker@example.de}
\github{jbecker}
\linkedin{jonas-becker-ml}
\begin{document}
\makecvheader
\cvsection{Berufserfahrung}
\begin{cventries}
  \cventry
    {Machine Learning Engineer}
    {Northwind Mobility GmbH}
    {Berlin, Germany}
    {04/2021 - heute}
    {
      \begin{cvitems}
        \item {Trained demand forecasting models in PyTorch that cut idle fleet time by 18\%}
        \item {Deployed models on Kubernetes serving 40 cities}
      \end{cvitems}
    }
  \cventry
    {Data Scientist}
    {Contoso Analytics AG}
    {Zürich, Switzerland}
    {10/2018 - 03/2021}
    {
      \begin{cvitems}
        \item {Built churn models in scikit-learn for 5 retail clients}
      \end{cvitems}
    }
\end{cventries}
\cvsection{Ausbildung}
\begin{cventries}
  \cventry
    {M.Sc. Informatik}
    {Technische Universität München}
    {München, Germany}
    {2016 - 2018}
    {}
\end{cventries}
\cvsection{Kenntnisse}
\begin{cvskills}
  \cvskill{Programmierung}{Python, PyTorch, scikit-learn, SQL}
  \cvskill{Infrastruktur}{Kubernetes, Docker, GCP}
\end{cvskills}
\cvsection{Sprachen}
\begin{cvskills}
  \cvskill{Deutsch}{Muttersprache}
  \cvskill{Englisch}{C1}
\end{cvskills}
\end{document}
"""


def d_pdf():
    (OUT / "d-awesome.tex").write_text(AWESOME.strip() + "\n")
    c = canvas.Canvas(str(OUT / "d-left-dates.pdf"), pagesize=A4)
    w, h = A4
    y = h - 60
    def text(x, y, s, font="Helvetica", size=10):
        c.setFont(font, size)
        c.drawString(x, y, s)
    text(50, y, "JONAS BECKER", "Helvetica-Bold", 20); y -= 20
    text(50, y, "Machine Learning Engineer"); y -= 14
    text(50, y, "Berlin, Germany  ·  (+49) 151 2345 6789  ·  jonas.becker@example.de  ·  github.com/jbecker"); y -= 30
    def section(name):
        nonlocal_y[0] -= 6
        text(50, nonlocal_y[0], name, "Helvetica-Bold", 12)
        c.line(50, nonlocal_y[0] - 3, w - 50, nonlocal_y[0] - 3)
        nonlocal_y[0] -= 20
    nonlocal_y = [y]
    def row(left, right, font="Helvetica"):
        text(50, nonlocal_y[0], left, "Helvetica", 9)
        text(150, nonlocal_y[0], right, font, 10)
        nonlocal_y[0] -= 14
    def bullet(s):
        text(160, nonlocal_y[0], "•")
        text(170, nonlocal_y[0], s)
        nonlocal_y[0] -= 14
    section("BERUFSERFAHRUNG")
    row("04/2021 – heute", "Machine Learning Engineer, Northwind Mobility GmbH, Berlin, Germany", "Helvetica-Bold")
    bullet("Trained demand forecasting models in PyTorch that cut idle fleet time by 18%")
    bullet("Deployed models on Kubernetes serving 40 cities")
    nonlocal_y[0] -= 6
    row("10/2018 – 03/2021", "Data Scientist, Contoso Analytics AG, Zürich, Switzerland", "Helvetica-Bold")
    bullet("Built churn models in scikit-learn for 5 retail clients")
    section("AUSBILDUNG")
    row("2016 – 2018", "M.Sc. Informatik, Technische Universität München, München, Germany", "Helvetica-Bold")
    section("KENNTNISSE")
    row("Programmierung", "Python, PyTorch, scikit-learn, SQL")
    row("Infrastruktur", "Kubernetes, Docker, GCP")
    section("SPRACHEN")
    row("Deutsch", "Muttersprache")
    row("Englisch", "C1")
    c.save()


if __name__ == "__main__":
    c_docx()
    d_pdf()
    print("held-out fixtures written")
