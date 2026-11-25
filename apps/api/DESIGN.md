---
name: My Career Agent
description: A job search for visa holders in tech, drawn as a transit map converging on the offer window.
colors:
  rail: "#15181d"
  rail-2: "#232831"
  rail-ink: "#ecebe6"
  rail-quiet: "#a9aeb7"
  ground: "#f2f3f5"
  sheet: "#ffffff"
  ink: "#17191d"
  quiet: "#565a62"
  rule: "#dcdfe4"
  rule-strong: "#c3c7ce"
  focus: "#0a63c9"
  go: "#17703f"
  go-tint: "#e3f1e8"
  hold: "#8a5a00"
  hold-tint: "#fbf0d9"
  stop: "#b0261d"
  stop-tint: "#f9e6e3"
  line-blue: "#0b5cad"
  line-violet: "#7c3aad"
  line-magenta: "#b3186d"
  line-teal: "#00796b"
  line-brown: "#7a5230"
  line-slate: "#3f4a5a"
  line-cyan: "#0e7490"
  fill: "#e8eaee"
  fill-2: "#eaecf0"
  hover: "#f8f9fb"
  row-hover: "#f9fafb"
  th: "#f7f8fa"
  edge-hover: "#8c929b"
  placeholder: "#6b6f77"
  primary-hover: "#2a3039"
  selection: "#cfe0f6"
  go-ink: "#0f5530"
  go-edge: "#c6e3d1"
  hold-ink: "#6b4500"
  hold-edge: "#efdcae"
  stop-ink: "#8c1d16"
  stop-edge: "#f0c9c4"
  dark-rail: "#0b0d10"
  dark-rail-2: "#1d2128"
  dark-rail-quiet: "#9ba1ab"
  dark-ground: "#111317"
  dark-sheet: "#181b20"
  dark-ink: "#e8e7e2"
  dark-quiet: "#a3a8b1"
  dark-rule: "#2a2f37"
  dark-rule-strong: "#3b414b"
  dark-focus: "#6aa8ff"
  dark-go: "#5cc98a"
  dark-go-tint: "#12291c"
  dark-go-ink: "#8fdcae"
  dark-go-edge: "#1f4a31"
  dark-hold: "#e0a93a"
  dark-hold-tint: "#2b2210"
  dark-hold-ink: "#f0c770"
  dark-hold-edge: "#4d3b14"
  dark-stop: "#f0776c"
  dark-stop-tint: "#2f1614"
  dark-stop-ink: "#f6a39b"
  dark-stop-edge: "#5a2420"
  dark-fill: "#22262d"
  dark-fill-2: "#252a32"
  dark-hover: "#1e2228"
  dark-row-hover: "#1c1f25"
  dark-th: "#1b1e24"
  dark-edge-hover: "#5b626d"
  dark-placeholder: "#8a909a"
  dark-selection: "#2b4a78"
  dark-line-blue: "#6bb4ff"
  dark-line-violet: "#d08fff"
  dark-line-magenta: "#ff73b9"
  dark-line-teal: "#67c5b4"
  dark-line-brown: "#d4a783"
  dark-line-slate: "#a5b2c5"
  dark-line-cyan: "#68bedd"
typography:
  display:
    fontFamily: "Overpass, Public Sans, ui-sans-serif, sans-serif"
    fontSize: "32px"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  date:
    fontFamily: "Overpass, Public Sans, ui-sans-serif, sans-serif"
    fontSize: "40px"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  count:
    fontFamily: "Overpass, Public Sans, ui-sans-serif, sans-serif"
    fontSize: "22px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  subhead:
    fontFamily: "Overpass, Public Sans, ui-sans-serif, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.2
  micro:
    fontFamily: "Overpass, ui-sans-serif, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.06em"
  heading:
    fontFamily: "Overpass, Public Sans, ui-sans-serif, sans-serif"
    fontSize: "19px"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  label:
    fontFamily: "Overpass, ui-sans-serif, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.03em"
  body:
    fontFamily: "Public Sans, ui-sans-serif, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  note:
    fontFamily: "Public Sans, ui-sans-serif, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  sm: "6px"
  md: "10px"
  pill: "999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
  s7: "48px"
components:
  button-primary:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.sm}"
    padding: "11px 14px 9px"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "11px 14px 9px"
    height: "40px"
  sheet:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.md}"
    padding: "16px 24px"
  window-strip:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  tag-go:
    backgroundColor: "{colors.go-tint}"
    textColor: "{colors.go}"
    rounded: "{rounded.sm}"
  tag-hold:
    backgroundColor: "{colors.hold-tint}"
    textColor: "{colors.hold}"
    rounded: "{rounded.sm}"
  tag-stop:
    backgroundColor: "{colors.stop-tint}"
    textColor: "{colors.stop}"
    rounded: "{rounded.sm}"
  route-badge:
    backgroundColor: "{colors.line-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "6px 10px 5px 7px"
  chip-selected:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.pill}"
---

# My Career Agent: the transit world

Source: `public/app.css` (tokens in `:root`), `public/app.js` (line colours, transit diagram), `public/index.html` (icon sprite). Written from the built app, November 2026.

## Overview

The search is a set of lines converging on one interchange: the offer window. Each company is a line, each stage a station, and the window is a dark capsule every line wants to reach together. The world is an ink rail over a cool off-white working ground, with dense aligned tables beneath the diagram. It's an operating tool for people checking it daily, so it's calm, direct and quiet. Colour is spent on company identity and on state, and nowhere else.

Refused: grey kanban boards, funnels, hero metrics, cards of icon + heading + text, eyebrow labels above headings, modals for ordinary tasks.

## Colors

- **Rail (`rail`)**: the top bar, the offer-window strip on Today, primary buttons, selected chips, the interchange capsule and secret/code panels. Text on it is `rail-ink`, or `rail-quiet` for secondary text.
- **Ground and sheets**: the page is `ground`. Working content sits on white `sheet` panels with a 1px `rule` border, one level deep only.
- **Text**: `ink`, with `quiet` for secondary text (about 6:1 on the ground). Never use grey on a coloured surface.
- **Line colours**: one per company. `LINE_COLOURS` in app.js holds `var(--l0)`…`var(--l6)`, and app.css defines each per theme (same hue; lightened in oklab to L≈0.76 for dark). Companies with live processes claim distinct colours first, assigned by a stable hash with probing, so a company keeps its colour on Today, the map, the table, the packet and Network. Every line colour holds 3:1 or better against the ground as a graphic. The only text on a line colour is the route badge's company name, in `--line-ink` (white on light, near-black on dark), 5.3:1 or better in both themes.
- **State (`go`, `hold`, `stop`)**: only where they carry meaning (stage tags, messages, check results, the amber "early/late" estimate on the map). Red, green and amber never appear as line colours.
- **Neutral steps** (`fill`, `fill-2`, `hover`, `row-hover`, `th`, `edge-hover`, `placeholder`) are steps of the ground and rule tones; `go-ink`/`go-edge` and their hold and stop pairs are message text and borders, darker steps of the three state colours. All are CSS custom properties, never literals. Add no other hues.
- **Dark theme** (`[data-theme="dark"]` on `<html>`, every `dark-*` colour above): for the evening laptop session. The rail drops below the ground (`#0b0d10` under `#111317`) so it still reads as the frame; sheets lift one step; text is warm paper (`#e8e7e2`). The solid button and selected chip turn to paper with ink text (`--primary`), and the interchange capsule turns paper too. State colours lighten and their tints darken. `theme.js` (loaded in `<head>`, before paint) applies the saved choice (`localStorage.mca_theme`: `light`, `dark`, or absent for the system) and follows system changes; the rail's sun/moon button pins the opposite theme, and Settings › Appearance offers Match my device / Light / Dark.
- **Focus** is `focus` blue: a 2px outline with 2px offset, or a 3px soft ring on inputs. Text selection is a pale blue.

## Typography

- **Overpass** (self-hosted, OFL; highway-signage lineage) carries display text, headings, buttons, navigation, column labels and station labels.
- **Public Sans** (self-hosted, OFL) carries body text, tables and notes. Tabular numerals are on globally (`tnum`).
- The scale has clear steps: 40px for Today's date (800, -0.035em) with the weekday above it in 17px quiet, 32px page titles (800), 19px section headings (750), 15–16px row titles (700), 15px body, 13.5px notes, and 12px uppercase column labels with +0.03em tracking.
- Prose measure is at most 70ch (`.measure`, `.lede`).

## Layout

- Content is at most 1120px wide, with a 16px gutter.
- The order on each page is a page heading row (title plus lede, actions to the right), then content.
- **Today**: the date heading (weekday over day and month) with actions to the right, the window strip, today's line, then the queue as one sheet of divided rows (fit score | route badge and title, meta, tags | actions). Rows are 76px for a single-line meta; Packet and Skip are quiet buttons, so Approve is the one solid control per row.
- **Applications**: the compact transit diagram (at most six lines, latest stage first, with up to two slots kept for held-back dream roles), then filter chips plus search, then a sortable table with inline notes and an expandable history row.
- **Settings**: a sticky section list beside the stacked sheets.
- **Under 640px**: the rail wraps the navigation onto its own row. The transit diagram switches to a compact layout with names above lines. Tables become two-column cards that hide empty and secondary cells.
- **Spacing**: tight inside groups, generous between them, and more space above a heading than below it (h2 has 48px above and 12px below).

## Elevation & Depth

The app is flat. Depth comes from the rail's darkness and the sheets' borders, not from shadows. The only shadow is the toast's (0 8px 24px, rail at 22%). Never use zero-offset glows or hard offset shadows.

## Shapes

- Rounded corners are 6px on controls and tags, 10px on sheets and the strip, and pill-shaped on chips.
- **Stations** are circles: open (sheet fill with a 4px line-colour stroke) until reached, then filled. The current station is drawn larger.
- **Lines**: reached segments are 6px solid with round caps. Segments still ahead are 3px dotted. Held-back lines are 3px dashed. A line whose estimate falls outside the window stops short of the capsule with a perpendicular terminus bar.
- **The interchange** is a vertical capsule in rail ink spanning every row, with the window dates set under it.
- **Icons** are hand-authored 24px SVG symbols with a 2px stroke and round joins, kept in one sprite in index.html. Never use emoji or Unicode glyphs as icons.

## Components

- **Resume drop target**: a dashed-rule panel on the ground with an ink-ringed document icon (a station), the instruction, and a primary "Choose a file". The review after it is one sheet per section (About you, Experience, Education, Projects, Skills, Certifications, Languages), every field editable in place, with a sticky footer holding Save.

- **Buttons**: primary (rail fill), secondary (sheet with a strong rule border), quiet (transparent), and danger (red text). A danger button arms on the first press and does the action on the second, within 5 seconds. Use this instead of confirm dialogs. Arrow and external-link icons go after the label; other icons go before it.
- **Tags**: small 6px-rounded labels, neutral or tinted by state.
- **Route badge**: the company's name in a pill of its line colour with a small open station ring before it, as on a transit sign. It introduces a company where the company is the subject: Today's queue rows, the packet header (above the job title H1) and follow-up cards.
- **Bullet**: a 12px line-colour ring, filled when the company has a live process. It's the company's mark in lists and tables, where the open/filled state carries meaning (Applications table, Network, Companies).
- **Today's line**: one station per role in today's queue on a 5px line; stations fill in ink, and the line with them, as you approve or apply. Skipped roles get a dashed ring. The count ("3 of 8 approved") sits to its left. It updates live without reloading.
- **Window strip**: a rail-coloured bar holding the outlined "Offer window" capsule, the facts (live processes, expected inside, held back) and a "See the map" link.
- **Stepper (setup)**: the transit line again, with stations for setup steps. Optional steps get a dashed ring.
- **Messages**: tinted panels with a leading icon for go, hold, stop and info. Each error names the problem and the recovery.
- **Loading**: three shimmering bars, static under reduced motion.

Motion: the one authored moment is the transit lines drawing in, once per session, over 900ms with an exponential ease-out and a 70ms stagger, and off under `prefers-reduced-motion`. Everything else is a 150ms colour or border transition.

## Do's and Don'ts

- Do reuse a company's line colour wherever that company appears. Don't introduce a second identity colour for it.
- Do keep state colours for meaning. Don't draw a line in red, green or amber.
- Do let only in-window offers reach the interchange. Don't make early or late offers look on time.
- Do put the company in the heading or meta line. Don't put an eyebrow or kicker above a heading.
- Do mark what the resume reader guessed (amber `Check` tag and a hold-tinted field) and let typing clear it. Don't hide a guess as if it were read.
- Do confirm consequential actions with the two-step button. Don't add modals for ordinary tasks.
- Do write every server value with `textContent`. Don't use `innerHTML`.
- Don't add a second display face, glass effects, gradients, or decorative shadows.
