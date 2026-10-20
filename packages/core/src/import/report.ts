import type { ImportKind } from './model.ts';
import type { ImportChoices } from './convert.ts';

// The import report (docs/decisions.md D47), read as a document of decisions: one sentence that
// sums the import up, then only what asks for a person's choice, grouped (« 29 textes en
// Frutiger LT passent en Source Sans 3 », « Accepter les 29 »), then every loss, one by one, as
// the LESSON.md export lists its own (D11). Codes and fields are stable; the sentences are written
// in the report's language (French or English).

export type LossStatus = 'fallback' | 'not-yet' | 'dropped';

export interface ImportLoss {
  code: LossCode;
  status: LossStatus; // fallback: kept in a simpler form; not-yet: the importer cannot read it yet; dropped: left out on purpose
  feature: string; // the source's feature, in its own words (« Glisser-déposer », "Labeled graphic")
  page?: string; // the source page's title
  source?: string; // the source object's name or id
  screen?: string; // where it went in the module
  block?: string;
  message: string;
}

export interface ImportChoice {
  id: string;
  label: string;
}

export interface ImportDecision {
  id: DecisionId;
  count: number;
  title: string; // « 29 textes en Frutiger LT passent en Source Sans 3 »
  detail?: string;
  applied: string; // the choice the import made (a choice id)
  accept: string; // « Accepter les 29 »
  choices: ImportChoice[]; // the import can be run again with another (ImportChoices)
  where: { screen: string; block?: string }[];
  accepted?: boolean; // the author accepted the choice applied (the app's « Accepter », settle_import_report)
}

export interface ImportReport {
  format: 'elabora-import-report/1';
  beta: true;
  language: 'fr' | 'en';
  source: { kind: ImportKind; file: string | null; title: string };
  summary: string;
  choices: ImportChoices; // what the import was made with: run it again with these and one changed
  counts: { sections: number; pages: number; screens: number; layers: number; events: number; items: number; kept: number; fallback: number; notYet: number; dropped: number; decoration: number; media: number };
  decisions: ImportDecision[];
  losses: ImportLoss[];
}

export type LossCode =
  | 'decoration' | 'background' | 'content-library' | 'media-missing' | 'media-format' | 'alt-missing' | 'media-accessibility'
  | 'font' | 'clickable' | 'hotspot' | 'states' | 'timing' | 'animation' | 'trigger' | 'action' | 'condition' | 'variable'
  | 'layer-empty' | 'feedback-layer' | 'feature' | 'unsupported' | 'notes' | 'steps' | 'options' | 'reader' | 'javascript' | 'quiz-feedback';

export type DecisionId = 'fonts' | 'backgrounds' | 'content-library' | 'alt-missing' | 'media-accessibility' | 'hotspots' | 'timing' | 'presentation' | 'quiz-feedback';

// The choice of ImportChoices each decision with several choices sets: the import runs again with it.
export const DECISION_CHOICE: Partial<Record<DecisionId, keyof ImportChoices>> = { presentation: 'presentation', backgrounds: 'backgrounds', timing: 'timing', fonts: 'fonts', 'media-accessibility': 'mediaAccessibility' };

type Language = 'fr' | 'en';

export const reportLanguage = (language: string | undefined): Language => (String(language ?? '').toLowerCase().startsWith('fr') ? 'fr' : 'en');

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

const KIND_NAMES: Record<ImportKind, Record<Language, string>> = {
  'storyline-source': { fr: 'du projet Storyline', en: 'the Storyline project' },
  'storyline-published': { fr: 'de la publication Storyline', en: 'the published Storyline course' },
  rise: { fr: 'de l\'export Rise', en: 'the Rise export' }
};

export function summarySentence(language: Language, kind: ImportKind, counts: ImportReport['counts'], decisions: number): string {
  const { pages, screens, kept, fallback, notYet, dropped, decoration } = counts;
  const unit = kind === 'rise' ? (language === 'fr' ? plural(pages, 'leçon', 'leçons') : plural(pages, 'lesson', 'lessons')) : (language === 'fr' ? plural(pages, 'diapositive', 'diapositives') : plural(pages, 'slide', 'slides'));
  if (language === 'fr') {
    const lost = notYet + dropped - decoration;
    return `${pages} ${unit} ${KIND_NAMES[kind].fr} ${plural(pages, 'devient', 'deviennent')} ${screens} ${plural(screens, 'écran', 'écrans')} : ${kept} ${plural(kept, 'élément repris', 'éléments repris')}, ${fallback} en repli simple, ${lost} non ${plural(lost, 'repris', 'repris')}${decoration ? ` et ${decoration} ${plural(decoration, 'forme décorative laissée', 'formes décoratives laissées')} au thème` : ''}. ${decisions ? `${decisions} ${plural(decisions, 'choix vous attend', 'choix vous attendent')}.` : 'Aucun choix ne vous attend.'}`;
  }
  return `${pages} ${unit} of ${KIND_NAMES[kind].en} became ${screens} ${plural(screens, 'screen', 'screens')}: ${kept} ${plural(kept, 'item', 'items')} kept, ${fallback} in a simple fallback, ${notYet + dropped - decoration} not kept${decoration ? ` and ${decoration} decorative ${plural(decoration, 'shape', 'shapes')} left to the theme` : ''}. ${decisions ? `${decisions} ${plural(decisions, 'choice awaits', 'choices await')} you.` : 'No choice awaits you.'}`;
}

// The words of each decision, by language. `n` is the count; `a` and `b` are its subjects; `applied`
// the choice the import made, which the title says (an import run again with another choice says it).
export function decisionWords(language: Language, id: DecisionId, n: number, a = '', b = '', applied = ''): { title: string; detail?: string; accept: string; choices: ImportChoice[] } {
  const all = language === 'fr' ? (n === 1 ? 'Accepter' : n === 2 ? 'Accepter les deux' : `Accepter les ${n}`) : (n === 1 ? 'Accept' : n === 2 ? 'Accept both' : `Accept all ${n}`);
  const fr = language === 'fr';
  switch (id) {
    case 'fonts':
      return {
        title: applied === 'theme'
          ? (fr ? `${n} ${plural(n, 'texte', 'textes')} en ${a} ${plural(n, 'prend', 'prennent')} la police du thème Elabora` : `${n} ${plural(n, 'text', 'texts')} in ${a} take the Elabora theme's font`)
          : (fr ? `${n} ${plural(n, 'texte', 'textes')} en ${a} ${plural(n, 'passe', 'passent')} en ${b}` : `${n} ${plural(n, 'text', 'texts')} in ${a} move to ${b}`),
        detail: fr ? `${a} n'a pas de licence web connue d'Elabora : ${b}, une police libre fournie avec Elabora, la remplace. Pour garder ${a}, ajoutez ses fichiers WOFF2 et sa licence web (elabora font add --file).` : `Elabora knows no web licence for ${a}: ${b}, a free font shipped with Elabora, takes its place. To keep ${a}, add its WOFF2 files and web licence (elabora font add --file).`,
        accept: all,
        choices: [{ id: 'substitute', label: fr ? `Passer en ${b}` : `Use ${b}` }, { id: 'theme', label: fr ? 'Garder la police du thème Elabora' : 'Keep the Elabora theme\'s font' }]
      };
    case 'backgrounds':
      return {
        title: applied === 'keep'
          ? (fr ? `${n} ${plural(n, 'image de fond plein écran est gardée, décorative', 'images de fond plein écran sont gardées, décoratives')}` : `${n} full-slide background ${plural(n, 'image is', 'images are')} kept, decorative`)
          : (fr ? `${n} ${plural(n, 'image de fond plein écran est laissée', 'images de fond plein écran sont laissées')} de côté` : `${n} full-slide background ${plural(n, 'image is', 'images are')} left out`),
        detail: fr ? 'Une image qui couvre toute la diapositive ne se replie pas sur un téléphone : le thème du module dessine le fond. Gardez-les pour les avoir comme images décoratives en tête d\'écran.' : 'An image that covers the whole slide does not reflow on a phone: the module\'s theme draws the background. Keep them to have them as decorative images at the top of their screens.',
        accept: all,
        choices: [{ id: 'drop', label: fr ? 'Les laisser' : 'Leave them out' }, { id: 'keep', label: fr ? 'Les garder, décoratives' : 'Keep them, decorative' }]
      };
    case 'content-library':
      return {
        title: fr ? `${n} ${plural(n, 'média de la Content Library d\'Articulate n\'est pas repris', 'médias de la Content Library d\'Articulate ne sont pas repris')}` : `${n} ${plural(n, 'medium', 'media')} of Articulate's Content Library not taken`,
        detail: fr ? 'La licence de la Content Library interdit d\'utiliser ses personnages, photos et icônes hors des outils d\'Articulate. Une note marque chaque place : remplacez-les par vos propres médias.' : 'The Content Library\'s licence forbids using its characters, photos and icons outside Articulate\'s tools. A note marks each place: replace them with media of your own.',
        accept: fr ? 'Compris' : 'Understood',
        choices: [{ id: 'drop', label: fr ? 'Les laisser' : 'Leave them out' }]
      };
    case 'alt-missing':
      return {
        title: fr ? `${n} ${plural(n, 'image sans texte alternatif est marquée décorative', 'images sans texte alternatif sont marquées décoratives')}` : `${n} ${plural(n, 'image', 'images')} without alternative text marked decorative`,
        detail: fr ? 'La source ne leur donnait pas de texte alternatif. Écrivez-en un pour celles qui portent une information.' : 'The source gave them no alternative text. Write one for those that carry information.',
        accept: all,
        choices: [{ id: 'decorative', label: fr ? 'Décoratives' : 'Decorative' }]
      };
    case 'media-accessibility':
      return {
        title: applied === 'errors'
          ? (fr ? `${n} ${plural(n, 'vidéo ou son sans sous-titres ni transcription garde ses erreurs', 'vidéos ou sons sans sous-titres ni transcription gardent leurs erreurs')} de validation` : `${n} ${plural(n, 'video or sound', 'videos or sounds')} without captions or transcript ${plural(n, 'keeps its', 'keep their')} validation errors`)
          : (fr ? `${n} ${plural(n, 'vidéo ou son sans sous-titres ni transcription est marqué décoratif', 'vidéos ou sons sans sous-titres ni transcription sont marqués décoratifs')} en attendant` : `${n} ${plural(n, 'video or sound', 'videos or sounds')} without captions or transcript marked decorative for now`),
        detail: fr ? 'Elabora demande des sous-titres et une transcription à chaque vidéo parlante (WCAG). La source n\'en avait pas : ajoutez-les (elabora media captions), ou gardez les erreurs pour les voir dans la validation.' : 'Elabora asks every video with sound for captions and a transcript (WCAG). The source had none: add them (elabora media captions), or keep the errors to see them in the validation.',
        accept: all,
        choices: [{ id: 'decorative', label: fr ? 'Décoratifs en attendant' : 'Decorative for now' }, { id: 'errors', label: fr ? 'Garder les erreurs' : 'Keep the errors' }]
      };
    case 'quiz-feedback':
      return {
        title: fr ? `${n} ${plural(n, 'question sans retour reçoit', 'questions sans retour reçoivent')} un retour générique` : `${n} ${plural(n, 'question', 'questions')} without feedback get a generic one`,
        detail: fr ? 'Elabora demande à chaque réponse un retour qui explique pourquoi elle est juste ou fausse. La source n\'en avait pas : « C\'est une bonne réponse. » et « Ce n\'est pas la bonne réponse. » les remplacent en attendant les vôtres.' : 'Elabora asks every answer for feedback that explains why it is right or wrong. The source had none: "This is a right answer." and "This is not the right answer." stand in until you write yours.',
        accept: all,
        choices: [{ id: 'generic', label: fr ? 'Retour générique en attendant' : 'Generic feedback for now' }]
      };
    case 'hotspots':
      return {
        title: fr ? `${n} ${plural(n, 'zone cliquable devient un bouton nommé', 'zones cliquables deviennent des boutons nommés')} d'après la source` : `${n} clickable ${plural(n, 'area becomes a button', 'areas become buttons')} named after the source`,
        detail: fr ? 'Elabora ne rend cliquables que des boutons, que le clavier atteint aussi. Relisez leur libellé.' : 'Elabora only makes buttons clickable, which the keyboard reaches too. Check their labels.',
        accept: all,
        choices: [{ id: 'buttons', label: fr ? 'Des boutons' : 'Buttons' }]
      };
    case 'timing':
      return {
        title: applied === 'steps'
          ? (fr ? `${n} ${plural(n, 'objet apparaissait', 'objets apparaissaient')} au fil du minutage : ${plural(n, 'il apparaît', 'ils apparaissent')} en étapes` : `${n} ${plural(n, 'object', 'objects')} appeared along the timeline: now shown in steps`)
          : (fr ? `${n} ${plural(n, 'objet apparaissait', 'objets apparaissaient')} au fil du minutage : ${plural(n, 'il s\'affiche', 'ils s\'affichent')} d'emblée` : `${n} ${plural(n, 'object', 'objects')} appeared along the timeline: now shown at once`),
        detail: fr ? 'Sans narration, un écran Elabora montre tout dès son ouverture. Choisissez les étapes pour les révéler un groupe après l\'autre avec Continuer.' : 'Without narration an Elabora screen shows everything when it opens. Choose steps to reveal them group by group with Continue.',
        accept: all,
        choices: [{ id: 'together', label: fr ? 'D\'emblée' : 'At once' }, { id: 'steps', label: fr ? 'En étapes' : 'In steps' }]
      };
    case 'presentation':
      return {
        title: a === 'scroll' ? (fr ? `Les ${n} écrans sont des pages qui défilent` : `The ${n} screens are scrolling pages`) : (fr ? `Les ${n} écrans sont des diapositives` : `The ${n} screens are slides`),
        detail: fr ? 'Chaque diapositive Storyline devient un écran qui tient dans la fenêtre et se lit comme une page sur téléphone. En pages qui défilent, le texte a plus de place.' : 'Each Storyline slide becomes a screen that fits the window and reads as a page on phones. As scrolling pages, text gets more room.',
        accept: language === 'fr' ? 'Accepter' : 'Accept',
        choices: [{ id: 'slides', label: fr ? 'Diapositives' : 'Slides' }, { id: 'scroll', label: fr ? 'Pages qui défilent' : 'Scrolling pages' }]
      };
  }
}

// One loss, in words. `feature` is the source's name for what was lost.
export function lossMessage(language: Language, code: LossCode, feature: string, detail = ''): string {
  const fr = language === 'fr';
  const d = detail ? (fr ? ` (${detail})` : ` (${detail})`) : '';
  switch (code) {
    case 'decoration': return fr ? `${feature} : décoration sans texte, laissée au thème${d}` : `${feature}: decoration without text, left to the theme${d}`;
    case 'background': return fr ? `${feature} : image de fond plein écran${d}` : `${feature}: full-slide background image${d}`;
    case 'content-library': return fr ? `${feature} : média de la Content Library d'Articulate, non repris (licence)${d}` : `${feature}: Articulate Content Library medium, not taken (licence)${d}`;
    case 'media-missing': return fr ? `${feature} : fichier introuvable dans la source${d}` : `${feature}: file not found in the source${d}`;
    case 'media-format': return fr ? `${feature} : format de média que le web ne lit pas${d}` : `${feature}: a media format browsers do not play${d}`;
    case 'alt-missing': return fr ? `${feature} : sans texte alternatif, marquée décorative` : `${feature}: no alternative text, marked decorative`;
    // detail: what is missing, captions (and so the transcript) or only the transcript.
    case 'media-accessibility': return detail === 'transcript' ? (fr ? `${feature} : sans transcription` : `${feature}: no transcript`) : (fr ? `${feature} : sans sous-titres ni transcription` : `${feature}: no captions or transcript`);
    case 'font': return fr ? `${feature} : police remplacée${d}` : `${feature}: font replaced${d}`;
    case 'clickable': return fr ? `${feature} : objet cliquable devenu un bouton${d}` : `${feature}: clickable object turned into a button${d}`;
    case 'hotspot': return fr ? `${feature} : zone cliquable invisible devenue un bouton${d}` : `${feature}: invisible clickable area turned into a button${d}`;
    case 'states': return fr ? `${feature} : états personnalisés non repris, l'état normal est gardé${d}` : `${feature}: custom states not taken, the normal state is kept${d}`;
    case 'timing': return fr ? `${feature} : minutage sur la ligne de temps${d}` : `${feature}: timing on the timeline${d}`;
    case 'animation': return fr ? `${feature} : animation d'entrée ou de sortie${d}` : `${feature}: entrance or exit animation${d}`;
    case 'trigger': return fr ? `Déclencheur « ${feature} » non repris${d}` : `Trigger "${feature}" not taken${d}`;
    case 'action': return fr ? `Action « ${feature} » non reprise${d}` : `Action "${feature}" not taken${d}`;
    case 'condition': return fr ? `Déclencheur à condition sur « ${feature} » non repris${d}` : `Trigger with a condition on "${feature}" not taken${d}`;
    case 'variable': return fr ? `Variable « ${feature} » non reprise${d}` : `Variable "${feature}" not taken${d}`;
    case 'layer-empty': return fr ? `Calque « ${feature} » sans contenu repris${d}` : `Layer "${feature}" with nothing kept${d}`;
    case 'feedback-layer': return fr ? `Calque de retour « ${feature} » fondu dans le retour de la question${d}` : `Feedback layer "${feature}" merged into the question's feedback${d}`;
    case 'feature': return fr ? `${feature} : pas encore de bloc correspondant, repli simple${d}` : `${feature}: no matching block yet, simple fallback${d}`;
    case 'unsupported': return fr ? `${feature} : pas encore repris${d}` : `${feature}: not taken yet${d}`;
    case 'notes': return fr ? `${feature} : notes de la diapositive gardées dans le plan${d}` : `${feature}: slide notes kept in the plan${d}`;
    case 'steps': return fr ? `${feature} : étapes au-delà de 12, fondues dans la dernière${d}` : `${feature}: steps beyond 12 merged into the last${d}`;
    case 'options': return fr ? `${feature} : réponses au-delà de 6 non reprises${d}` : `${feature}: answers beyond 6 not taken${d}`;
    case 'reader': return fr ? `${feature}${d}` : `${feature}${d}`;
    case 'quiz-feedback': return fr ? `${feature} : question sans retour, retour générique en attendant${d}` : `${feature}: question without feedback, generic feedback for now${d}`;
    case 'javascript': return fr ? `${feature} : JavaScript de l'auteur, jamais exécuté par Elabora${d}` : `${feature}: the author's JavaScript, never run by Elabora${d}`;
  }
}

// A note for the author on the block that replaces a source feature (never shown to learners; 500 characters).
export function blockNote(language: Language, code: LossCode, feature: string, detail = ''): string {
  const prefix = language === 'fr' ? 'Import : ' : 'Import: ';
  const text = `${prefix}${lossMessage(language, code, feature, detail)}.`;
  return text.length > 500 ? `${text.slice(0, 497)}…` : text;
}
