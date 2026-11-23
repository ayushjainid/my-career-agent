// POC loop P5: the questions almost every application form asks. Answers live in the user's
// answer bank and are copied exactly; sensitive ones are never guessed or rewritten.

export interface StandardQuestion {
  key: string;
  label: string;
  sensitive: boolean;
  hint?: string;
}

export const STANDARD_QUESTIONS: StandardQuestion[] = [
  { key: "contact.full_name", label: "Full name", sensitive: false },
  { key: "contact.email", label: "Email", sensitive: false },
  { key: "contact.phone", label: "Phone", sensitive: false },
  { key: "contact.location", label: "Current location (city, country)", sensitive: false },
  { key: "contact.linkedin", label: "LinkedIn URL", sensitive: false },
  { key: "contact.website", label: "Website or GitHub", sensitive: false },
  { key: "us.work_authorized", label: "Are you legally authorized to work in the US?", sensitive: true, hint: "Yes / No" },
  { key: "us.needs_sponsorship_now", label: "Will you now require visa sponsorship?", sensitive: true, hint: "Yes / No" },
  { key: "us.needs_sponsorship_future", label: "Will you in the future require visa sponsorship?", sensitive: true, hint: "Yes / No" },
  { key: "pay.expectation", label: "Desired salary", sensitive: true, hint: "A range, with currency" },
  { key: "availability.notice", label: "Notice period or start date", sensitive: false },
  { key: "availability.relocate", label: "Willing to relocate?", sensitive: false },
  { key: "eeo.gender", label: "Gender (voluntary)", sensitive: true, hint: "\"Decline to self-identify\" is always an option" },
  { key: "eeo.ethnicity", label: "Race / ethnicity (voluntary)", sensitive: true },
  { key: "eeo.veteran", label: "Veteran status (voluntary)", sensitive: true },
  { key: "eeo.disability", label: "Disability status (voluntary)", sensitive: true },
];

const KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;
export const isAnswerKey = (k: string) => k.length <= 80 && KEY.test(k);

/** Standard keys are sensitive or not by definition; custom keys use what the user chose. */
export function isSensitiveKey(key: string, requested: boolean): boolean {
  const std = STANDARD_QUESTIONS.find((q) => q.key === key);
  return std ? std.sensitive : requested;
}
