# Records of processing (GDPR Article 30), draft

Status: draft for legal review. Controller name, address and contact are not yet set.

| Processing | Personal data | Purpose and basis | Recipients (processors) | Retention |
| --- | --- | --- | --- | --- |
| Account | Email, password hash, sessions, access tokens (hashed) | Provide the service; contract | Cloudflare (hosting), Neon (database, EU region) | Until the user deletes the account |
| Profile and fact bank | Work history, skills, education, languages, work-authorization status, target roles, pay floor | Rank jobs and prepare applications; contract. Work-authorization status may reveal nationality: shown only to the user | Cloudflare, Neon | Until deleted by the user |
| Answer bank | Contact details, visa answers, salary expectation, voluntary EEO answers | Fill application forms exactly as the user wrote them; contract and explicit consent for EEO answers | Cloudflare, Neon | Until deleted by the user |
| Network | Names, profile URLs, employers, positions and message counts of the user's LinkedIn connections, from the user's own export | Suggest referrals; legitimate interest of the user, balanced by data minimisation (no message content is stored) | Cloudflare, Neon | Replaced on each import; deleted with the account |
| Applications and events | Jobs applied to, states, dates, notes, free-text answers | Track the search; contract | Cloudflare, Neon | Until deleted by the user |
| Inbound email | Sender, subject, classification (no body is stored) | Update application stages; contract | Cloudflare Email Routing, Neon | Until deleted by the user |
| AI drafting (optional) | Verified facts, job text, the question | Draft answers with the user's own provider key, at the user's request | The provider the user chose (Anthropic or OpenAI), under the user's own account | Not stored by My Career Agent beyond the saved answer |
| Billing (off during beta) | Stripe customer id, subscription status | Payment; contract | Stripe | As required by tax law |

Not processed: LinkedIn passwords, LinkedIn message content, application form submissions (the user submits), card numbers (Stripe holds them).
