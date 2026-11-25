"""Builds the resume fixtures used to measure extraction precision.

Two people, each written in two source formats and exported to PDF the way real people do it:
LaTeX compiled with pdflatex, Word exported with LibreOffice. The expected facts live in
expected/<person>.json and are the same for every format of that person.

Run: python3 packages/resume-import/scripts/make_fixtures.py   (needs pdflatex, soffice, python-docx)
"""
import pathlib
import shutil
import subprocess
import tempfile

from docx import Document
from docx.enum.text import WD_TAB_ALIGNMENT
from docx.shared import Pt, Inches

OUT = pathlib.Path(__file__).resolve().parent.parent / "test" / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)

JAKE = r"""
\documentclass[letterpaper,11pt]{article}
\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage[english]{babel}
\usepackage{tabularx}
\usepackage[T1]{fontenc}
\input{glyphtounicode}
\pdfgentounicode=1
\addtolength{\oddsidemargin}{-0.5in}
\addtolength{\evensidemargin}{-0.5in}
\addtolength{\textwidth}{1in}
\addtolength{\topmargin}{-.5in}
\addtolength{\textheight}{1.0in}
\urlstyle{same}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}
\titleformat{\section}{\vspace{-4pt}\scshape\raggedright\large}{}{0em}{}[\color{black}\titlerule \vspace{-5pt}]

\newcommand{\resumeItem}[1]{\item\small{{#1 \vspace{-2pt}}}}
\newcommand{\resumeSubheading}[4]{
  \vspace{-2pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{#1} & #2 \\
      \textit{\small#3} & \textit{\small #4} \\
    \end{tabular*}\vspace{-7pt}
}
\newcommand{\resumeProjectHeading}[2]{
    \item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
      \small#1 & #2 \\
    \end{tabular*}\vspace{-7pt}
}
\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0.15in, label={}]}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}
\newcommand{\resumeItemListStart}{\begin{itemize}}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-5pt}}

\begin{document}
\begin{center}
    \textbf{\Huge \scshape Dana Ivanovi\'{c}} \\ \vspace{1pt}
    \small San Francisco, CA $|$ +1 (415) 555-0134 $|$ \href{mailto:dana.ivanovic@example.com}{\underline{dana.ivanovic@example.com}} $|$
    \href{https://linkedin.com/in/dana-ivanovic}{\underline{linkedin.com/in/dana-ivanovic}} $|$
    \href{https://github.com/danai}{\underline{github.com/danai}}
\end{center}

\section{Experience}
  \resumeSubHeadingListStart
    \resumeSubheading
      {Hooli}{San Francisco, CA}
      {Senior Data Engineer}{Mar 2021 -- Present}
      \resumeItemListStart
        \resumeItem{Cut pipeline cost 40\% for 3M users by moving batch jobs to incremental loads in Python and SQL}
        \resumeItem{Built a Kafka and Spark streaming platform on AWS handling 2B events a day}
        \resumeItem{Led a team of 4 engineers migrating 120 Airflow DAGs to dbt}
      \resumeItemListEnd
    \resumeSubheading
      {Initech}{Austin, TX}
      {Data Engineer}{Jun 2018 -- Feb 2021}
      \resumeItemListStart
        \resumeItem{Designed a Snowflake warehouse serving 300 analysts with 99.9\% uptime}
        \resumeItem{Automated data quality checks in Go, catching 95\% of schema breaks before release}
      \resumeItemListEnd
  \resumeSubHeadingListEnd

\section{Education}
  \resumeSubHeadingListStart
    \resumeSubheading
      {University of Michigan}{Ann Arbor, MI}
      {B.S. in Computer Science}{Aug 2014 -- May 2018}
  \resumeSubHeadingListEnd

\section{Projects}
    \resumeSubHeadingListStart
      \resumeProjectHeading
          {\textbf{OpenLineage Dashboard} $|$ \emph{Python, React}}{2023}
          \resumeItemListStart
            \resumeItem{Open-source lineage viewer used by 40 teams to trace failed pipelines}
          \resumeItemListEnd
    \resumeSubHeadingListEnd

\section{Certifications}
 \begin{itemize}[leftmargin=0.15in, label={}]
    \small{\item{AWS Certified Solutions Architect -- Associate (2022)}}
 \end{itemize}

\section{Technical Skills}
 \begin{itemize}[leftmargin=0.15in, label={}]
    \small{\item{
     \textbf{Languages}{: Python, SQL, Go, Scala} \\
     \textbf{Tools}{: Airflow, dbt, Spark, Kafka, AWS, Snowflake}
    }}
 \end{itemize}

\section{Languages}
 \begin{itemize}[leftmargin=0.15in, label={}]
    \small{\item{English (native), Russian (C1), Spanish (B1)}}
 \end{itemize}
\end{document}
"""

MODERNCV = r"""
\documentclass[11pt,a4paper,sans]{moderncv}
\moderncvstyle{classic}
\moderncvcolor{blue}
\usepackage[utf8]{inputenc}
\usepackage[scale=0.8]{geometry}
\name{Arjun}{Mehta}
\title{Backend Engineer}
\address{London}{United Kingdom}
\phone[mobile]{+44 7700 900123}
\email{arjun.mehta@example.com}
\social[linkedin]{arjun-mehta}
\social[github]{arjunm}
\begin{document}
\makecvtitle
\section{Experience}
\cventry{01/2022 -- present}{Backend Engineer}{Northwind Bank}{London, UK}{}{
\begin{itemize}
\item Rebuilt the payments ledger in Kotlin and PostgreSQL, cutting settlement time from 4 hours to 20 minutes
\item Moved 30 services to Kubernetes with gRPC, reducing p99 latency by 35\%
\end{itemize}}
\cventry{2019 -- 2021}{Software Engineer}{Contoso}{Bengaluru, India}{}{
\begin{itemize}
\item Built Java microservices handling 5,000 requests per second for 2M customers
\end{itemize}}
\section{Education}
\cventry{2015 -- 2019}{B.Tech in Electrical Engineering}{Indian Institute of Technology Delhi}{New Delhi}{}{}
\section{Skills}
\cvitem{Programming}{Java, Kotlin, PostgreSQL, Kubernetes, gRPC}
\section{Languages}
\cvitemwithcomment{English}{C2}{}
\cvitemwithcomment{Hindi}{Native}{}
\end{document}
"""


# This TeX Live has no FontAwesome; icons carry no text, so a stub that draws nothing is enough.
FA_STUB = "\\ProvidesPackage{fontawesome5}\n" + "".join(
    f"\\newcommand{{\\fa{n}}}[1][]{{}}\n" for n in """Asterisk BabyCarriage Bitbucket Circle Envelope Fax Github GithubSquare Gitlab Globe GlobeAfrica
    GlobeAmericas GlobeAsia GlobeEurope Home Inbox Linkedin LinkedinIn Mobile Orcid Phone Print Researchgate Skype
    StackOverflow Telegram Twitter TwitterSquare Whatsapp Xing XingSquare""".split())


def compile_tex(name, src):
    (OUT / f"{name}.tex").write_text(src.strip() + "\n")
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copy(OUT / f"{name}.tex", tmp)
        (pathlib.Path(tmp) / "fontawesome5.sty").write_text(FA_STUB)
        for _ in range(2):
            subprocess.run(["pdflatex", "-interaction=nonstopmode", f"{name}.tex"], cwd=tmp, check=True, capture_output=True)
        shutil.copy(pathlib.Path(tmp) / f"{name}.pdf", OUT / f"{name}.pdf")


def right_tab(p, width=Inches(7)):
    p.paragraph_format.tab_stops.add_tab_stop(width, WD_TAB_ALIGNMENT.RIGHT)


def classic_docx():
    d = Document()
    for s in d.sections:
        s.left_margin = s.right_margin = Inches(0.75)
        s.top_margin = s.bottom_margin = Inches(0.6)
    d.styles["Normal"].font.name = "Calibri"
    d.styles["Normal"].font.size = Pt(10.5)
    t = d.add_paragraph()
    r = t.add_run("Dana Ivanović")
    r.bold = True
    r.font.size = Pt(22)
    d.add_paragraph("San Francisco, CA • +1 (415) 555-0134 • dana.ivanovic@example.com • linkedin.com/in/dana-ivanovic • github.com/danai")

    def head(text):
        d.add_heading(text, level=1)

    def role(org, place, title, dates, bullets):
        p = d.add_paragraph()
        right_tab(p)
        p.add_run(org).bold = True
        p.add_run(f"\t{place}")
        p = d.add_paragraph()
        right_tab(p)
        p.add_run(title).italic = True
        p.add_run(f"\t{dates}")
        for b in bullets:
            d.add_paragraph(b, style="List Bullet")

    head("Experience")
    role("Hooli", "San Francisco, CA", "Senior Data Engineer", "Mar 2021 – Present", [
        "Cut pipeline cost 40% for 3M users by moving batch jobs to incremental loads in Python and SQL",
        "Built a Kafka and Spark streaming platform on AWS handling 2B events a day",
        "Led a team of 4 engineers migrating 120 Airflow DAGs to dbt",
    ])
    role("Initech", "Austin, TX", "Data Engineer", "Jun 2018 – Feb 2021", [
        "Designed a Snowflake warehouse serving 300 analysts with 99.9% uptime",
        "Automated data quality checks in Go, catching 95% of schema breaks before release",
    ])
    head("Education")
    role("University of Michigan", "Ann Arbor, MI", "B.S. in Computer Science", "Aug 2014 – May 2018", [])
    head("Projects")
    p = d.add_paragraph()
    right_tab(p)
    p.add_run("OpenLineage Dashboard").bold = True
    p.add_run(" | Python, React\t2023")
    d.add_paragraph("Open-source lineage viewer used by 40 teams to trace failed pipelines", style="List Bullet")
    head("Certifications")
    d.add_paragraph("AWS Certified Solutions Architect – Associate (2022)")
    head("Technical Skills")
    p = d.add_paragraph()
    p.add_run("Languages: ").bold = True
    p.add_run("Python, SQL, Go, Scala")
    p = d.add_paragraph()
    p.add_run("Tools: ").bold = True
    p.add_run("Airflow, dbt, Spark, Kafka, AWS, Snowflake")
    head("Languages")
    d.add_paragraph("English (native), Russian (C1), Spanish (B1)")
    d.save(OUT / "a-classic.docx")


def twocol_docx():
    d = Document()
    for s in d.sections:
        s.left_margin = s.right_margin = Inches(0.6)
    d.styles["Normal"].font.name = "Arial"
    d.styles["Normal"].font.size = Pt(10)
    t = d.add_paragraph()
    r = t.add_run("ARJUN MEHTA")
    r.bold = True
    r.font.size = Pt(24)
    d.add_paragraph("Backend Engineer")
    table = d.add_table(rows=1, cols=2)
    table.autofit = False
    left, right = table.rows[0].cells
    left.width, right.width = Inches(2.3), Inches(4.9)

    def lp(text, bold=False, size=None):
        p = left.add_paragraph()
        r = p.add_run(text)
        r.bold = bold
        if size:
            r.font.size = Pt(size)
        return p

    left.paragraphs[0].add_run("CONTACT").bold = True
    lp("London, United Kingdom")
    lp("+44 7700 900123")
    lp("arjun.mehta@example.com")
    lp("linkedin.com/in/arjun-mehta")
    lp("github.com/arjunm")
    lp("SKILLS", bold=True)
    for s in ["Java", "Kotlin", "PostgreSQL", "Kubernetes", "gRPC"]:
        lp(s)
    lp("LANGUAGES", bold=True)
    lp("English — C2")
    lp("Hindi — Native")

    right.paragraphs[0].add_run("EXPERIENCE").bold = True

    def rp(text, bold=False, italic=False, style=None):
        p = right.add_paragraph(style=style)
        r = p.add_run(text)
        r.bold, r.italic = bold, italic

    rp("Backend Engineer, Northwind Bank", bold=True)
    rp("London, UK | 01/2022 – present", italic=True)
    rp("Rebuilt the payments ledger in Kotlin and PostgreSQL, cutting settlement time from 4 hours to 20 minutes", style="List Bullet")
    rp("Moved 30 services to Kubernetes with gRPC, reducing p99 latency by 35%", style="List Bullet")
    rp("Software Engineer, Contoso", bold=True)
    rp("Bengaluru, India | 2019 – 2021", italic=True)
    rp("Built Java microservices handling 5,000 requests per second for 2M customers", style="List Bullet")
    rp("EDUCATION", bold=True)
    rp("B.Tech in Electrical Engineering, Indian Institute of Technology Delhi", bold=True)
    rp("New Delhi | 2015 – 2019", italic=True)
    d.save(OUT / "b-twocol.docx")


def docx_to_pdf(name):
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", tmp, str(OUT / f"{name}.docx")], check=True, capture_output=True)
        shutil.copy(pathlib.Path(tmp) / f"{name}.pdf", OUT / f"{name}.pdf")


if __name__ == "__main__":
    compile_tex("a-jake", JAKE)
    compile_tex("b-moderncv", MODERNCV)
    classic_docx()
    twocol_docx()
    docx_to_pdf("a-classic")
    docx_to_pdf("b-twocol")
    print("fixtures written to", OUT)
