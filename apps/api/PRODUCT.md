# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: people on work visas, or about to need one, looking for software, data and product roles in the US, with the UK, Canada and the EU next. Mostly international students finishing a degree and H-1B holders changing jobs. They run a search over weeks to months alongside a job or a degree, usually on a laptop in the evening or early morning, and check in on a phone during the day.

Their job: get several good offers at the same time, from employers who will sponsor them, without spraying applications. Each morning they want to know what to apply to today, who could refer them, and what to paste into each form.

The founder is the first user and runs the POC on his own search.

## Product Purpose

My Career Agent decides what to apply to and prepares everything for the application; the person submits. It finds live roles on company job boards, ranks them by real chance of success (fit, referral, freshness, the employer's visa history), holds dream companies back so their offers land in the same window, and turns each approved job into an apply packet.

Success: the person sends 10 well-chosen applications a day with no wrong answers, asks for a referral before applying wherever their network allows, and ends the search with offers that overlap so they can negotiate.

## Positioning

The only job tool that plans when to apply where: warm-up companies first, dream companies timed to an offer window, judged against public H-1B and PERM filings rather than a "sponsors visas" checkbox. It is referral-first from the person's own LinkedIn export, and tool-neutral: any autofill tool, the built-in copy panel, or any AI agent can fill the form, and nothing depends on one AI vendor.

## Operating Context

- Daily loop: the queue is built at 06:05 UTC. The person reviews it (about 5 minutes), asks for referrals, then applies in a session with the company's application form open in another tab.
- Weekly: re-upload the LinkedIn export; outcomes recalibrate ranking.
- Forms are filled by copy-paste from the packet, an autofill extension, or an AI agent through the connector. The person always submits.
- Applications move through states: queued, approved, ready for review, submitted, screen, interview, offer, rejected, withdrawn, failed, skipped.

## Capabilities and Constraints

- Live: daily queue with gates (language, citizenship and clearance), blacklist and tiers, referral matching, answer bank, free-text answer checks (measured lengths, figures traced to verified facts), apply packet, tracker, manual job scoring, posting integrity check.
- Beta in progress: accounts and onboarding, resume files (DOCX and PDF), email-driven status and follow-ups, MCP connector and bring-your-own AI key, timing and pay benchmarks, billing (built, switched off), UK and Canada packs.
- Never: scraping LinkedIn, storing a LinkedIn password, submitting an application, guessing a sensitive answer, inventing experience or numbers.
- Free during the beta. Billing code ships switched off; no prices exist yet.
- Hosted on Cloudflare Workers with Neon Postgres; the database is meant to sit in an EU region.

## Brand Commitments

- Name: My Career Agent.
- Voice: calm and direct. Plain facts and the next step; no hype, no cheerleading, no urgency tricks. A job search is stressful; the product lowers the temperature.

## Evidence on Hand

No users, testimonials, benchmarks or outcome data exist yet. Do not invent any. Demo data in `scripts/dev-local.mts` is synthetic and labelled as such.

## Product Principles

1. The person decides and submits; the product prepares. Every automated step stops before anything irreversible.
2. Every number traces to a source: a verified fact, a public filing, a posting. Unknown is shown as unknown.
3. Fewer, better applications beat volume; the daily target is a ceiling, not a quota.
4. No dark patterns: no streaks, no fake urgency, no guilt copy for a skipped day.
5. Works without AI and without any one tool.

## Accessibility & Inclusion

WCAG 2.2 AA. Many users read English as a second language: plain words, no idioms in instructions. Full keyboard operation; usable on a phone.
