// The rules a diagnostic's `rule` names: Elabora's pedagogical guardrails (letters A to I, from the
// research on learning design and AI authoring) and the LMS delivery checklist (LMS-n). Each is the
// rule as Elabora checks it; docs/diagnostics.md lists them with the codes that cite them.

export const RULES: Readonly<Record<string, string>> = {
  A1: 'Every screen, activity or question serves an item of the plan, and every item of the plan is covered by a screen (constructive alignment).',
  A2: 'Each objective gets practice and an assessment at the same level as the objective.',
  A3: 'Objectives are observable behaviours (an action verb, a condition, a criterion), never « understand » or « know » alone.',
  A4: 'The plan states the business goal the module serves; when the cause of a gap is not a skill, a performance aid may serve better than a course.',
  A5: 'The module follows the plan the client validated: the texts and questions it keeps are referenced, never copied, and what changed since the validated version is listed.',
  'AI-50': 'Audio, images and video made by an AI are marked as generated (EU AI Act, article 50).',
  B1: 'No more than a few exposition screens in a row without something to retrieve, decide or produce.',
  B5: 'Spaced retrieval is planned after the module (for example on days 2, 7 and 30).',
  C1: 'Questions follow item-writing rules: about three plausible options, no « all/none of the above », no hidden negation, homogeneous options, a correct option that is not given away.',
  D1: 'Each option of a question has elaborated feedback (why it is right or wrong, what to review), not only « correct » or « incorrect ».',
  D3: 'A scenario\'s feedback shows the realistic consequences of each choice.',
  E3: 'Segmenting: media come in short parts the learner controls, and the text on one screen is bounded.',
  E4: 'Redundancy: on-screen text does not repeat the narration said at the same time; captions can be switched on and off.',
  E5: 'Signalling: headings and highlights show the structure, and key concepts come before complex content.',
  E7: 'No neuromyths (learning styles and the like); an agent points out those a request contains.',
  F1: 'No accessibility violation found by axe-core (WCAG 2.2 A and AA) on any screen or interactive state.',
  F2: 'What tools cannot judge is reviewed by a person (RGAA 4.1.2, WCAG 2.2): relevant text alternatives, reading order, keyboard use, target sizes.',
  F3: 'Every medium has captions or a transcript, and every meaningful visual a text alternative.',
  G1: 'Every factual claim (a rule, a procedure, a figure) traces to a source of the client or an expert; otherwise it is marked to be checked.',
  I1: 'Words live in blocks, where authors edit them and translators find them: never in stylesheets, templates or figures.',
  'LMS-1': 'The session ends without `unload`: the state is committed after every change and when the page is hidden, and Quit finishes the session.',
  'LMS-3': 'The learner\'s state fits the suspend-data limit of each target LMS, in the worst case.',
  'LMS-5': 'A page restored by the browser or launched again initialises once and resumes where the learner was.',
  'LMS-6': 'The SCORM API is found in every launch topology of the target LMSs (iframe, popup, nested frames).',
  'LMS-7': 'An update keeps the progress of learners who started, or says which LMSs will lose it.',
  'LMS-8': 'The package is defensive for each target LMS: manifest at the root, portable file names, no external resource, size, file count, compression ratio and file types within its limits.',
  'LMS-9': 'The package\'s standard is one the target LMS supports.',
  'LMS-13': 'Status and score follow one state machine: a status never regresses, and pass/fail reporting needs a mastery score and scored questions.',
  'LMS-14': 'Times are sent in the format the standard requires (`cmi.core.session_time` as HHHH:MM:SS.SS in SCORM 1.2) at every commit.',
  'LMS-15': 'LMS profiles are executable facts with their sources: a value not documented is listed to be measured, never assumed.'
};
