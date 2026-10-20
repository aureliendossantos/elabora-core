// The words of the plan's document, in the module's language (docs/decisions.md D48). French and
// English are written; a module in another language gets the English words until its own are.
// Never a word about who or what wrote the plan: a reviewer validates its substance.

export type DocumentLanguage = 'fr' | 'en';

export interface DocumentWords {
  kicker: { approved: string; draft: string };
  // modified: « Modifié depuis la V2 validée »; toApprove: a version not validated, none before it.
  status: { approved: string; modified: (version: string) => string; toApprove: string; draft: string };
  property: { status: string; version: string; approvedBy: string; module: string; versions: string };
  notApproved: string;
  approvedOn: (by: string, date: string) => string;
  // The working copy shown: « V2, et 4 modifications depuis »; « Pas encore de version ».
  workingCopy: (latest: string, changes: number) => string;
  noVersion: string;
  // The version log at the head: each version's last step.
  logCreated: (version: string, date: string) => string;
  logSent: (version: string, date: string) => string;
  logValidated: (version: string, by: string, date: string, reference: string | null) => string;
  minutes: (minutes: number) => string;
  section: { framing: string; objectives: string; sequence: string; texts: string; assessments: string; sources: string };
  empty: { framing: string; objectives: string; sequence: string; texts: string; assessments: string; sources: string };
  framing: { businessGoal: string; audience: string; priorKnowledge: string; notes: string; spacing: string; waivers: string };
  priorKnowledge: Record<'low' | 'medium' | 'high', string>;
  waiver: (code: string, target: string | null, by: string) => string;
  objective: (number: string) => string;
  bloom: Record<'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create', string>;
  criterion: string;
  sources: string;
  item: (number: string) => string;
  kind: Record<'intro' | 'exposition' | 'demonstration' | 'practice' | 'scenario' | 'assessment' | 'summary', string>;
  objectives: string;
  noObjective: string;
  voiceover: string;
  verbatim: string;
  // The marks of what changed since the validated version (D52).
  mark: { added: string; removed: string; changed: string; moved: (was: string) => string; part: (from: string | null, to: string | null) => string; fields: (fields: string[]) => string };
  was: Record<'objective' | 'item' | 'text' | 'question' | 'source', (number: string) => string>;
  field: Record<string, string>;
  question: (number: string) => string;
  mode: Record<'single' | 'multiple' | 'numeric', string>;
  correct: string;
  answer: string;
  tolerance: (value: string) => string;
  feedbackCorrect: string;
  feedbackIncorrect: string;
  misconceptions: string;
  misconception: (value: string) => string;
  sourceType: string;
  sourceVersion: string;
  colophon: (plan: string, version: string | null, hash: string, date: string) => string;
  footerPage: string;
  colon: string;
  // The author of Word's tracked changes (never a person nor an AI), and of its comments.
  changeAuthor: (version: string) => string;
  noteAuthor: string;
  notesHeading: string;
}

const FR: DocumentWords = {
  kicker: { approved: 'Plan validé', draft: 'Plan du module' },
  status: { approved: 'Bon pour production', modified: (version) => `Modifié depuis la ${version} validée`, toApprove: 'À valider', draft: 'Brouillon' },
  property: { status: 'Statut', version: 'Version', approvedBy: 'Validé par', module: 'Module', versions: 'Historique' },
  notApproved: 'Pas encore validé',
  approvedOn: (by, date) => `${by}, le ${date}`,
  workingCopy: (latest, changes) => `${latest}, et ${changes === 1 ? 'une modification' : `${changes} modifications`} depuis`,
  noVersion: 'Pas encore de version',
  logCreated: (version, date) => `${version} créée le ${date}`,
  logSent: (version, date) => `${version} envoyée le ${date}`,
  logValidated: (version, by, date, reference) => `${version} validée par ${by} le ${date}${reference ? ` (${reference})` : ''}`,
  minutes: (minutes) => `${minutes} min`,
  section: { framing: 'Cadrage', objectives: 'Objectifs', sequence: 'Séquence', texts: 'Textes validés', assessments: 'Évaluations', sources: 'Sources' },
  empty: { framing: 'Pas de cadrage écrit.', objectives: 'Pas d’objectif.', sequence: 'Pas de point.', texts: 'Pas de texte validé mot pour mot.', assessments: 'Pas de question validée.', sources: 'Pas de source citée.' },
  framing: { businessGoal: 'Objectif métier', audience: 'Public', priorKnowledge: 'Connaissances préalables', notes: 'Notes sur le public', spacing: 'Rappels espacés', waivers: 'Dérogations approuvées' },
  priorKnowledge: { low: 'faibles', medium: 'moyennes', high: 'solides' },
  waiver: (code, target, by) => `${code}${target ? ` sur ${target}` : ''}, approuvée par ${by}`,
  objective: (number) => `Objectif ${number}`,
  bloom: { remember: 'mémoriser', understand: 'comprendre', apply: 'appliquer', analyze: 'analyser', evaluate: 'évaluer', create: 'créer' },
  criterion: 'Critère de réussite',
  sources: 'Sources',
  item: (number) => `Point ${number}`,
  kind: { intro: 'Introduction', exposition: 'Explication', demonstration: 'Démonstration', practice: 'Entraînement', scenario: 'Mise en situation', assessment: 'Évaluation', summary: 'Synthèse' },
  objectives: 'Objectifs',
  noObjective: 'aucun',
  voiceover: 'Voix off',
  verbatim: 'À l’identique',
  mark: {
    added: 'Ajouté', removed: 'Retiré', changed: 'Modifié', moved: (was) => `déplacé, c’était ${was}`,
    part: (from, to) => (from && to ? `passé de la partie « ${from} » à « ${to} »` : to ? `dans la partie « ${to} »` : `hors de la partie « ${from} »`),
    fields: (fields) => `modifié : ${fields.join(', ')}`
  },
  was: { objective: (number) => `l’objectif ${number}`, item: (number) => `le point ${number}`, text: (number) => `le texte ${number}`, question: (number) => `la question ${number}`, source: (number) => `la source ${number}` },
  field: {
    id: 'identifiant', title: 'titre', businessGoal: 'objectif métier', audience: 'public', duration: 'durée', spacing: 'rappels espacés', waivers: 'dérogations',
    statement: 'énoncé', short: 'nom court', bloom: 'niveau', criterion: 'critère', sources: 'sources', kind: 'nature', objectives: 'objectifs', description: 'description',
    voiceover: 'voix off', text: 'texte', verbatim: 'à l’identique', stem: 'énoncé', mode: 'type de réponse', options: 'réponses', answer: 'réponse attendue',
    tolerance: 'tolérance', unit: 'unité', feedback: 'retours', misconceptions: 'erreurs prévues', type: 'nature', version: 'version'
  },
  question: (number) => `Question ${number}`,
  mode: { single: 'Une seule bonne réponse', multiple: 'Plusieurs bonnes réponses', numeric: 'Réponse numérique' },
  correct: 'Bonne réponse',
  answer: 'Réponse attendue',
  tolerance: (value) => `à ${value} près`,
  feedbackCorrect: 'Si la réponse est juste',
  feedbackIncorrect: 'Sinon',
  misconceptions: 'Erreurs prévues',
  misconception: (value) => `Réponse ${value}`,
  sourceType: 'Nature',
  sourceVersion: 'Version',
  colophon: (plan, version, hash, date) => `Plan ${plan}${version ? `, ${version}` : ''}, empreinte ${hash}. Document établi le ${date}.`,
  footerPage: 'Page',
  colon: ' : ',
  changeAuthor: (version) => `Depuis la ${version} validée`,
  noteAuthor: 'Note pour le client',
  notesHeading: 'Notes sur les modifications'
};

const EN: DocumentWords = {
  kicker: { approved: 'Approved plan', draft: 'Course plan' },
  status: { approved: 'Approved for production', modified: (version) => `Changed since approved ${version}`, toApprove: 'To approve', draft: 'Draft' },
  property: { status: 'Status', version: 'Version', approvedBy: 'Approved by', module: 'Course', versions: 'History' },
  notApproved: 'Not approved yet',
  approvedOn: (by, date) => `${by}, on ${date}`,
  workingCopy: (latest, changes) => `${latest}, and ${changes === 1 ? 'one change' : `${changes} changes`} since`,
  noVersion: 'No version yet',
  logCreated: (version, date) => `${version} made on ${date}`,
  logSent: (version, date) => `${version} sent on ${date}`,
  logValidated: (version, by, date, reference) => `${version} approved by ${by} on ${date}${reference ? ` (${reference})` : ''}`,
  minutes: (minutes) => `${minutes} min`,
  section: { framing: 'Scope', objectives: 'Objectives', sequence: 'Sequence', texts: 'Approved texts', assessments: 'Assessments', sources: 'Sources' },
  empty: { framing: 'No scope written.', objectives: 'No objective.', sequence: 'No item.', texts: 'No text approved word for word.', assessments: 'No approved question.', sources: 'No source cited.' },
  framing: { businessGoal: 'Business goal', audience: 'Audience', priorKnowledge: 'Prior knowledge', notes: 'Notes on the audience', spacing: 'Spaced reminders', waivers: 'Approved waivers' },
  priorKnowledge: { low: 'low', medium: 'medium', high: 'high' },
  waiver: (code, target, by) => `${code}${target ? ` on ${target}` : ''}, approved by ${by}`,
  objective: (number) => `Objective ${number}`,
  bloom: { remember: 'remember', understand: 'understand', apply: 'apply', analyze: 'analyse', evaluate: 'evaluate', create: 'create' },
  criterion: 'Success criterion',
  sources: 'Sources',
  item: (number) => `Item ${number}`,
  kind: { intro: 'Introduction', exposition: 'Explanation', demonstration: 'Demonstration', practice: 'Practice', scenario: 'Scenario', assessment: 'Assessment', summary: 'Summary' },
  objectives: 'Objectives',
  noObjective: 'none',
  voiceover: 'Voice-over',
  verbatim: 'Word for word',
  mark: {
    added: 'Added', removed: 'Removed', changed: 'Changed', moved: (was) => `moved, it was ${was}`,
    part: (from, to) => (from && to ? `from part « ${from} » to « ${to} »` : to ? `into part « ${to} »` : `out of part « ${from} »`),
    fields: (fields) => `changed: ${fields.join(', ')}`
  },
  was: { objective: (number) => `objective ${number}`, item: (number) => `item ${number}`, text: (number) => `text ${number}`, question: (number) => `question ${number}`, source: (number) => `source ${number}` },
  field: {
    id: 'identifier', title: 'title', businessGoal: 'business goal', audience: 'audience', duration: 'duration', spacing: 'spaced reminders', waivers: 'waivers',
    statement: 'statement', short: 'short name', bloom: 'level', criterion: 'criterion', sources: 'sources', kind: 'kind', objectives: 'objectives', description: 'description',
    voiceover: 'voice-over', text: 'text', verbatim: 'word for word', stem: 'stem', mode: 'answer type', options: 'answers', answer: 'expected answer',
    tolerance: 'tolerance', unit: 'unit', feedback: 'feedback', misconceptions: 'expected mistakes', type: 'kind', version: 'version'
  },
  question: (number) => `Question ${number}`,
  mode: { single: 'One right answer', multiple: 'Several right answers', numeric: 'Numeric answer' },
  correct: 'Right answer',
  answer: 'Expected answer',
  tolerance: (value) => `within ${value}`,
  feedbackCorrect: 'When the answer is right',
  feedbackIncorrect: 'Otherwise',
  misconceptions: 'Expected mistakes',
  misconception: (value) => `Answer ${value}`,
  sourceType: 'Kind',
  sourceVersion: 'Version',
  colophon: (plan, version, hash, date) => `Plan ${plan}${version ? `, ${version}` : ''}, fingerprint ${hash}. Document made on ${date}.`,
  footerPage: 'Page',
  colon: ': ',
  changeAuthor: (version) => `Since approved ${version}`,
  noteAuthor: 'Note for the client',
  notesHeading: 'Notes on the changes'
};

export const DOCUMENT_WORDS: Record<DocumentLanguage, DocumentWords> = { fr: FR, en: EN };

// fr, fr-CA, fr-BE… take the French words; every other language the English ones.
export function documentLanguage(language: string | undefined): DocumentLanguage {
  return /^fr\b/i.test(language ?? '') ? 'fr' : 'en';
}

// « 5 octobre 2026 », « 5 October 2026 »: in the module's language, whatever the computer's.
export function longDate(date: string, language: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(date)?.[0];
  if (!day) return date;
  try {
    return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
  } catch {
    return day;
  }
}

export function formatNumber(value: number, language: string): string {
  try { return new Intl.NumberFormat(language, { maximumFractionDigits: 6 }).format(value); } catch { return String(value); }
}
