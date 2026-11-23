# Data protection impact assessment, outline draft

Status: draft for legal review before EU launch.

## Why a DPIA is needed
The product handles employment-related data at scale and records work-authorization status, which can reveal nationality or immigration status. Voluntary EEO answers can include special-category data (ethnicity, disability).

## Risks and the measures already built
| Risk | Measure in the product |
| --- | --- |
| One user reads another's data | Row-level security on every tenant table, forced; account tables reachable only through definer functions; tested in CI |
| Credential theft | PBKDF2 password hashes, hashed session and access tokens, HttpOnly SameSite cookies, Origin checks on writes, lockout after 10 failed sign-ins |
| Excess collection from LinkedIn | Only the user's own export; no message bodies; no scraping; no LinkedIn login |
| Wrong answers sent to employers | Sensitive answers copied exactly from the answer bank; agents cannot mark applications submitted |
| Manipulated job postings steering AI tools | Posting integrity check strips hidden text and flags instructions before any reader |
| AI provider sees personal data | Optional, user's own key and account, facts sent only at the user's request |
| Retention beyond need | Full export and one-step deletion in Settings |

## Open items
- Name the controller and a contact address; publish the privacy notice.
- Confirm the Neon project region is in the EU and record it.
- Decide the legal basis wording for voluntary EEO answers (explicit consent) with counsel.
- Sign data processing agreements with Cloudflare, Neon and (when billing starts) Stripe.
