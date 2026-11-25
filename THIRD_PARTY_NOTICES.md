# Third-party notices

## ai-job-search

Source: https://github.com/ai-job-search-dev/ai-job-search

My Career Agent adapts the following from ai-job-search. The originals are Claude Code prompts and
Python tools; My Career Agent re-implements them as deterministic code with no AI or vendor dependency.

| My Career Agent file | Adapted from | What was taken |
|---|---|---|
| `packages/core/src/postingGuard.ts` | `tools/posting_guard.py` | Hidden-content removal, invisible-character and tag-payload decoding, instruction-pattern list, mixed-script detection, verdict levels (ported closely) |
| `packages/core/src/atsText.ts` | `tools/verify_pdf.py` | `normalizeText` folds and the non-ASCII date-range rule with its quantity and currency exclusions (ported closely) |
| `jobs/my_career_agent_jobs/ats_text.py` | `tools/verify_pdf.py` | Extraction order: pypdf, then pdftotext; empty output treated as failure |
| `packages/core/src/formFields.ts` | `.claude/skills/job-application-assistant/08-application-forms.md` | Length guidance, measured (not estimated) counts, short variants, every claim grounded in the profile |
| `packages/core/src/gates.ts` | `.claude/skills/job-application-assistant/04-job-evaluation.md` | Language gate (FAIL / FLAG / PASS) and eligibility gate design |
| `packages/core/src/followups.ts` | `.claude/commands/outcome.md` | 10-day quiet threshold, at most two follow-ups, no new claims, drafts only |

```
MIT License

Copyright (c) 2026 Mads Lorentzen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Resume reading (packages/resume-import, shipped to the browser)

- pdf.js (Mozilla), Apache License 2.0: https://github.com/mozilla/pdf.js
- mammoth.js (Michael Williamson), BSD 2-Clause License: https://github.com/mwilliamson/mammoth.js
- unified-latex (Jason Siefken), MIT License: https://github.com/siefkenj/unified-latex
- fflate (Arjun Barrett), MIT License: https://github.com/101arrowz/fflate
