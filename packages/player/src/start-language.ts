// The language a package of several languages opens in (D59, D71), first found of:
// 1. the learner's own choice, kept with their progress (suspend data, or the browser on the web);
// 2. the language the page asks for (?lang=fr: a site that frames the module in its language);
// 3. the learner's preference the LMS gives (cmi.student_preference.language in SCORM 1.2; most
//    LMSs leave it empty, Moodle among them);
// 4. the author's default (course.json delivery.defaultLanguage);
// 5. the course's own.
// The browser's language is not read: in a company's LMS it says little about the learner (D59).

// A code matched to the package's languages loosely, since LMSs write it as they like: case and
// "_" aside (fr_CA, FR-ca), then the language without its region (fr-CA asks fr; fr asks fr-CA).
export function matchLanguage(asked: string | null | undefined, languages: readonly string[]): string | null {
  const tag = (asked ?? '').trim().replace(/_/g, '-').toLowerCase();
  if (!tag) return null;
  const exact = languages.find((language) => language.toLowerCase() === tag);
  if (exact) return exact;
  const primary = tag.split('-')[0];
  return languages.find((language) => language.toLowerCase() === primary) ?? languages.find((language) => language.toLowerCase().split('-')[0] === primary) ?? null;
}

export interface StartLanguageInput {
  languages: readonly string[]; // the package's, the course's own first
  chosen?: string | null; // the learner's choice, kept
  page?: string | null; // ?lang=
  lms?: readonly string[]; // the LMS's preferences, in order (a list in cmi5)
  fallback?: string | null; // the author's default
}

export function startLanguage({ languages, chosen, page, lms = [], fallback }: StartLanguageInput): string {
  const own = languages[0];
  const kept = chosen && languages.includes(chosen) ? chosen : null;
  return kept ?? matchLanguage(page, languages) ?? lms.map((language) => matchLanguage(language, languages)).find((found) => found !== null) ?? (fallback && languages.includes(fallback) ? fallback : null) ?? own;
}

// A preference the LMS wrote, as a list: cmi5 gives several, comma-separated; SCORM one.
export function preferenceList(value: string | null | undefined): string[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}
