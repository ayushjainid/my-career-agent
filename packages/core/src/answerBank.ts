// POC loop P5: the questions almost every application form asks. Answers live in the user's
// answer bank and are copied exactly; sensitive ones are never guessed or rewritten.

export interface StandardQuestion {
  key: string;
  label: string;
  sensitive: boolean;
  hint?: string;
  /** What an Italian application form calls this field. */
  labelIt?: string;
}

export const STANDARD_QUESTIONS: StandardQuestion[] = [
  { key: "contact.full_name", label: "Full name", sensitive: false, labelIt: "Nome e cognome" },
  { key: "contact.email", label: "Email", sensitive: false, labelIt: "Email" },
  { key: "contact.phone", label: "Phone", sensitive: false, labelIt: "Telefono / cellulare" },
  { key: "contact.location", label: "Current location (city, country)", sensitive: false, labelIt: "Città di residenza" },
  { key: "contact.linkedin", label: "LinkedIn URL", sensitive: false, labelIt: "Profilo LinkedIn" },
  { key: "contact.website", label: "Website or GitHub", sensitive: false, labelIt: "Sito web / portfolio" },
  { key: "us.work_authorized", label: "Are you legally authorized to work in the US?", sensitive: true, hint: "Yes / No" },
  { key: "us.needs_sponsorship_now", label: "Will you now require visa sponsorship?", sensitive: true, hint: "Yes / No" },
  { key: "us.needs_sponsorship_future", label: "Will you in the future require visa sponsorship?", sensitive: true, hint: "Yes / No" },
  { key: "ie.right_to_work", label: "Do you have the right to work in Ireland (for example Stamp 4, or EU/EEA citizenship)?", sensitive: true, hint: "Yes / No" },
  { key: "ie.needs_permit", label: "Will you require an employment permit to work in Ireland?", sensitive: true, hint: "Yes / No" },
  { key: "it.right_to_work", label: "Are you authorised to work in Italy (EU citizen or valid permesso di soggiorno)?", sensitive: true, hint: "Yes / No", labelIt: "Sei autorizzato/a a lavorare in Italia?" },
  { key: "it.needs_permit", label: "Will you require a work permit or EU Blue Card for Italy?", sensitive: true, hint: "Yes / No", labelIt: "Hai bisogno di un permesso di lavoro o della Carta Blu UE?" },
  { key: "it.current_ral", label: "Current gross annual salary (RAL attuale)", sensitive: true, hint: "e.g. 52.000 €", labelIt: "RAL attuale" },
  { key: "it.desired_ral", label: "Desired gross annual salary (RAL desiderata)", sensitive: true, hint: "e.g. 60.000 - 65.000 €", labelIt: "RAL desiderata" },
  { key: "it.notice", label: "Notice period, in Italian (preavviso)", sensitive: false, hint: "e.g. 2 mesi", labelIt: "Preavviso" },
  { key: "it.protected_category", label: "Registered under Law 68/1999 (categorie protette)?", sensitive: true, hint: "Yes / No", labelIt: "Appartenenza alle categorie protette (L. 68/99)" },
  { key: "pay.expectation", label: "Desired salary", sensitive: true, hint: "A range, with currency", labelIt: "Retribuzione desiderata" },
  { key: "availability.notice", label: "Notice period or start date", sensitive: false, labelIt: "Disponibilità" },
  { key: "availability.relocate", label: "Willing to relocate?", sensitive: false, labelIt: "Disponibilità al trasferimento" },
  { key: "eeo.gender", label: "Gender (voluntary)", sensitive: true, hint: "\"Decline to self-identify\" is always an option" },
  { key: "eeo.ethnicity", label: "Race / ethnicity (voluntary)", sensitive: true },
  { key: "eeo.veteran", label: "Veteran status (voluntary)", sensitive: true },
  { key: "eeo.disability", label: "Disability status (voluntary)", sensitive: true },
];

/** Work-authorization answers each country's forms ask, required once you apply there. */
export const REQUIRED_BY_COUNTRY: Record<string, string[]> = {
  US: ["us.work_authorized", "us.needs_sponsorship_now", "us.needs_sponsorship_future"],
  IE: ["ie.right_to_work", "ie.needs_permit"],
  IT: ["it.right_to_work", "it.needs_permit"],
};

/** Whether a standard question belongs to a country (us.*, ie.*, it.*), and which. */
export function questionCountry(key: string): string | null {
  const m = /^(us|ie|it|gb|ca)\./.exec(key);
  return m ? m[1]!.toUpperCase() : null;
}

const KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;
export const isAnswerKey = (k: string) => k.length <= 80 && KEY.test(k);

/** Standard keys are sensitive or not by definition; custom keys use what the user chose. */
export function isSensitiveKey(key: string, requested: boolean): boolean {
  const std = STANDARD_QUESTIONS.find((q) => q.key === key);
  return std ? std.sensitive : requested;
}
