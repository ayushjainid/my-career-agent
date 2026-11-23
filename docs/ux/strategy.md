# My Career Agent: UX strategy

## Problem

Visa holders in tech need overlapping offers from employers who will sponsor them, inside a fixed window (graduation, the H-1B cap season, a notice period). Applying broadly wastes the few good referral paths they have and spreads offers over months, so they negotiate from one offer at a time.

The product succeeds when a person sends about 10 well-chosen applications a day with no wrong answers, asks for a referral first wherever one exists, and receives offers that overlap.

## Jobs, in order of frequency

| When | Job | Where it lives |
| --- | --- | --- |
| Every morning, 5 minutes | Decide what to apply to today | Today |
| Before applying | Ask the strongest contact for a referral | Today, Network |
| Apply session, 30 to 60 minutes | Fill each form correctly, fast | Packet |
| After a reply or interview | Record the stage, send a thank-you | Applications, Follow-ups |
| 10 quiet days after applying | Send one short follow-up | Follow-ups |
| Weekly | Re-import LinkedIn, adjust targets and tiers | Network, Profile |
| Once | Set up: work authorization, targets, facts, answers | Onboarding |

## Navigation

Top level, in the order of the daily loop: **Today**, **Applications**, **Follow-ups**, **Network**, **Profile**, **Settings**.

- Today: the queue, the offer-window strip, excluded jobs with reasons, Score a job.
- Applications: transit diagram of live processes (screen and later), then the full table with filters, sort and notes. Each row opens the packet.
- Follow-ups: drafts that are due, each with copy and "mark sent".
- Network: LinkedIn import and people at tracked companies.
- Profile: facts, target roles, resume files.
- Settings: answer bank, work authorization, languages, companies (tiers and blacklist), forwarding address, connector tokens, AI key, data export and account deletion, billing when switched on.

A person can always see where they are (active tab), and every screen has one primary action.

## Journeys

**First run.** Invite code, email and password, then a six-step setup that can be left and resumed: work authorization, target roles, facts (paste resume text and confirm each fact), languages, essential answers (name, email, visa questions), LinkedIn import (optional). Ends by building the first queue. Each step says why it is needed in one line.

**Daily review.** Today lists queued jobs, best first. Each row: company line colour, title, fit, pay, flags, contacts. Approve, skip, or open referrals. Excluded jobs sit under the list, each with its reason.

**Referral ask.** From a queued job, Referrals lists contacts by strength with a drafted message. Copy, open LinkedIn, mark "I asked". The job stays in the queue.

**Apply.** The packet shows blockers first, then fields to copy, free-text answers with live checks, the tailored resume to download, and the status buttons. "I submitted it" freezes the answers.

**Follow-up.** On day 10 of silence a draft appears; at most two per application; after an interview a thank-you appears within two days.

## States every screen handles

Empty (no catalog, no facts, no queue), loading, offline or server error (message plus retry), signed out (session expired), blocked packet (reasons listed), frozen answers (after submission), long content (company names, notes), and narrow screens (360px).

## Measures

| Measure | Target | Counter-measure |
| --- | --- | --- |
| Applications submitted per active day | about 10 | Wrong answers reported per 100 applications stays at 0 |
| Share of applications with a referral asked first | rising week on week | Asks per contact per quarter stays at 1 or less |
| Offers inside the window | 2 or more | Applications to blocked or excluded jobs stays at 0 |

## Refused patterns

No streaks, badges or "you missed a day" copy. No countdowns or urgency colour on jobs. No prechecked consent. No auto-submit. No upsell interrupting the daily loop.
