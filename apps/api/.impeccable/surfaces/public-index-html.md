---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: []
---

# Surface: My Career Agent web app (all screens)

Mode: Operate. Audience: visa holders in tech running a weeks-long search; evening laptop sessions, phone check-ins. Job: review today's queue, ask for referrals, apply from a packet, keep the pipeline moving toward overlapping offers. Constraints: WCAG 2.2 AA, keyboard operable, works at 360px, no framework, no dark patterns, calm and direct copy.

## Direction contract

THESIS: The search is a network of lines converging on one interchange: the offer window. Refuses the category default of a grey kanban of cards and a funnel chart.

OWN-WORLD: Transit-diagram world. Ink-dark top rail; clean off-white working ground; each company owns one saturated line colour, reused wherever that company appears (queue rows, packet header, tracker). Stations are open circles, filled when reached; interchanges are rounded capsules. Grotesk type with tabular numerals; dense, aligned tables; state colours (green, amber, red) only where they carry meaning, never on lines.

STORY: The visitor sees which processes are live and how close they are to the window, knows what to do today, acts (approve, ask, apply, follow up), and trusts that nothing was invented.

FIRST VIEWPORT: Applications: top rail navigation; a compact transit diagram (max six lines, late-stage first) with stages as station columns converging on the Offer window interchange at the right, its date shown; below, a filterable, sortable table of every application with notes. Today: queue list first, a one-line window strip above it; primary action "Approve" per row.

FORM: Transit map (Impeccable's pick, position 1 of 7), chosen by the user with the instruction "keep the transit diagram compact at the top for active late-stage loops, and include a clean filterable table below it for full application history and notes". seed:e892a552b16cb9df (printed by a degraded roll with no challengers; --check-seed reports it unknown on this machine because impeccable.style was unreachable, so it cannot be re-verified offline).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
