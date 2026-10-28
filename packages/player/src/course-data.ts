// The compiled course: what the compiler (@elabora/core compile/course-data.ts) writes into
// elabora/course.js as window.ELABORA_COURSE, and what the player reads. Types only.
//
// The data is JSON: an optional field (`field?:`) is left out when it has no value, a nullable one
// (`T | null`) is always there. Defaults of the format are applied by the compiler, so the player
// finds every rule (navigation, completion, tracking, presentation) filled in.

import type { JsonObject } from './json.ts';
import type { InterfaceRole } from './sound-roles.ts';
import type { DataSchema } from './data-schema.ts';
import type { DialogueData, DialogueEventCondition, DialogueSpeakerData } from './dialogue/types.ts';

export interface CourseData {
  format: string;
  id: string;
  title: string;
  language: string;
  // A package of several languages (D59): its languages, the course's own first; each has its
  // course data (elabora/course.<lang>.js for the others). Absent from a package of one language.
  languages?: string[];
  version: string;
  // Overrides of the player labels, by label id.
  ui: Record<string, string>;
  navigation: NavigationRules;
  completion: CompletionRules;
  tracking: TrackingRules;
  // Theme tokens resolved: charter defaults, then theme.tokens, then theme.custom (by token name).
  tokens: TokenValues;
  presentation: Presentation;
  fonts: FontData[];
  backdrop?: Backdrop;
  sections: SectionData[];
  // Every screen, in learner order.
  screens: ScreenData[];
  variables: VariableData[];
  // Free objects used by blocks or by the backdrop, by object id.
  objects: Record<string, ObjectDefinition>;
  // The player's bars (docs/decisions.md D58), resolved by the compiler: the items that show, in
  // order, with their options filled in; a bar with nothing to show is null (removed from the page).
  player: PlayerData;
  // The files of Resources, the entries of the Glossary (in the course's order: the player sorts
  // them), and what « IA et crédits » says; absent when the course has none.
  resources?: ResourceData[];
  glossary?: GlossaryData[];
  about?: AboutData;
  // The course's sounds (docs/decisions.md D67); absent when it has none: courses without sound
  // keep their bytes.
  sounds?: SoundsData;
  // Built for the web target (docs/decisions.md D41): no LMS, progress kept or not; absent in SCORM
  // packages, previews and the canvas.
  delivery?: WebDelivery;
  build: { id: string };
}

// The web target's settings, as the build wrote them. navigation free: the compiler has already
// opened the navigation rules (mode free, no lock) and the narrations' seek; it is said here too.
export interface WebDelivery {
  target: 'web';
  progress: 'local' | 'none';
  navigation: 'authored' | 'free';
  // Built for the Revue (D42): the origins of the review pages that may show the module, whose
  // messages elabora/review.js takes (docs/review-bridge.md), and the course's languages (its own and
  // its translations). Absent from every other build.
  review?: { origins: string[]; languages: string[] };
}

export type TokenValues = Record<string, string | number>;

export interface NavigationRules {
  mode: 'linear' | 'free';
  lockUntilComplete: boolean;
}

export interface PlayerData {
  top: PlayerBarData | null;
  bottom: PlayerBarData | null;
}

export interface PlayerBarData {
  // window: stays in the window; page: the top bar scrolls away, the bottom bar ends the page.
  position: 'window' | 'page';
  items: PlayerItemData[];
}

export type PlayerItemData =
  | { id: 'logo'; src: string; alt: string; plate: boolean }
  | { id: 'outline'; screenTitle: boolean }
  | { id: 'controls'; seekBar: boolean; captionsByDefault: boolean; volume: boolean; transcript: boolean; speeds: number[] }
  | { id: 'title' | 'progress' | 'spacer' | 'resources' | 'glossary' | 'language' | 'display' | 'credits' | 'previous' | 'next' | 'exit' };

export type PlayerItemId = PlayerItemData['id'];

export type ResourceData = {
  id: string;
  title: string;
  description?: string;
} & (
  // A file: its package path, its extension (lower case, without the dot) and its size in bytes.
  | { kind: 'file'; src: string; type: string; bytes: number }
  // A link, opened in a new tab.
  | { kind: 'link'; url: string }
);

export interface GlossaryData {
  id: string;
  term: string;
  definition: string;
  variants?: string[];
}

// The moments an interface sound marks (D67): a choice, a feedback good, fair or bad, going back
// or replaying, opening or closing the history or the debrief, a dialogue's successful end.
export type { InterfaceRole } from './sound-roles.ts';

export interface SoundsData {
  // Interface sounds, when the course has them on (sounds.interface.when, auto: when the module has
  // sound): their volume and the file of each role that sounds (a role muted by the author has none).
  interface?: { volume: number; files: Partial<Record<InterfaceRole, string>> };
}

export interface AboutData {
  // Made with AI (AI Act, art. 50): the names of the speakers whose voice is generated (a voice
  // without a speaker gives none, and voices is still there), and the kinds of generated media.
  ai?: { voices?: string[]; media?: ('image' | 'video' | 'audio')[] };
  // The author's credits, then those its voices ask for (CC-BY voices), each once.
  credits?: string[];
}

export type ReportAs = 'completed-incomplete' | 'passed-incomplete' | 'passed-failed' | 'completed-failed';

export interface CompletionRules {
  reportAs: ReportAs;
  masteryScore?: number;
}

export interface TrackingRules {
  exitAfterCompletion: 'suspend' | 'normal';
  recordInteractions: boolean;
  heartbeatSeconds: number;
}

export interface Presentation {
  mode: 'scroll' | 'slides';
  // Widths in px at the reference window; the compiler emits them in the stylesheet.
  contentWidth: number;
  wideWidth: number;
  fit?: { reference?: string; minimum?: string };
}

export interface FontData {
  family: string;
  // Path in the package (theme/…).
  src: string;
  weight: string;
  style: 'normal' | 'italic';
  // The characters the file holds (one subset of the face: latin, latin-ext): CSS unicode-range.
  unicodeRange?: string;
}

export interface Backdrop {
  layers: string[];
  variants: string[];
  // The variant of screens that pick none (theme.backdrop.default).
  default?: string;
  object?: { object: string; props: JsonObject };
}

export interface SectionData {
  id: string;
  title: string;
  // Screen ids, in learner order.
  screens: string[];
}

export interface StepSettings {
  // explored: Continue is locked until the blocks of the steps above are explored (D63).
  opens?: 'continue' | 'answered' | 'explored';
  label?: string;
}

export interface ScreenData {
  id: string;
  // Short key of the screen in the learner state (elabora.lock.json).
  key: string;
  section: string;
  title: string;
  showTitle: boolean;
  required: boolean;
  style?: string;
  // A backdrop variant, or "none".
  backdrop?: string;
  continueRevealsSteps?: false;
  // How steps open, by step number (only steps with settings): continue (default), answered or
  // explored, and the text of the Continue button that opens them in scroll presentation.
  steps?: Record<string, StepSettings>;
  // viewed, on a narrated screen: the end of its narration reached by playback.
  completeWhen: 'viewed' | 'interactions-done' | 'action';
  // Plan items the screen covers.
  covers: string[];
  // The voice of the screen and its timeline (docs/decisions.md D24).
  narration?: NarrationData;
  blocks: BlockData[];
  layers: LayerData[];
  events: EventData[];
  layout?: ScreenLayout;
}

// A timed screen's timeline: its narration's lines laid end to end with their pauses (times in
// seconds from the start of the track), each step a segment. src is null until every line has its
// audio in the language of the package: the timeline then runs silent on estimated times, with its
// captions. A screen timed in seconds, without narration, has no line and no track: its timeline
// runs on the page's clock.
export interface NarrationData {
  // learner: stops at the end of each step; auto: the steps follow each other; next-screen: then
  // the next screen comes by itself.
  advance: 'learner' | 'auto' | 'next-screen';
  seek: 'seen' | 'free' | 'none';
  // Package paths of the track and of its WebVTT captions.
  src: string | null;
  captions: string | null;
  duration: number;
  // Some line has no audio: its time is estimated.
  estimated: boolean;
  // A voice made by an AI model speaks (AI Act, art. 50).
  generated: boolean;
  // What the credits say of its voices (their models, voices and licences), each once.
  credits?: string[];
  lines: NarrationLineData[];
  // Every step of the screen, in order, with its stretch of the timeline (empty for a step without lines).
  segments: SegmentData[];
  // The events on the timeline (timeline.reached), at the time they fire when playback crosses it.
  cues: CueData[];
}

export interface CueData {
  time: number;
  event: string;
}

export interface NarrationLineData {
  id: string;
  step: number;
  // The speaker's name, as captions and the transcript show it.
  speaker: string | null;
  text: string;
  // When the voice starts (after its pause) and ends.
  start: number;
  end: number;
  // The captions of the line.
  cues: CaptionData[];
  // When each word is said (aligned, or placed in proportion to the text): [word, start, end].
  words?: [string, number, number][];
}

export interface CaptionData {
  start: number;
  end: number;
  text: string;
}

export interface SegmentData {
  step: number;
  start: number;
  end: number;
}

// A screen-level component, rendered with the screen's layoutProps.
export interface ScreenLayout {
  id: string;
  lineage: string[];
  fullBleed: boolean;
  defaultSlot: string | null;
  html: string;
  // What its layout hooks show (D63), when its template has them: the screen's section and rank
  // among the screens (data-t-section, data-t-lesson), its reading time in minutes (data-t-duration).
  place?: { section: string; n: number; total: number };
  minutes?: number;
}

export interface LayerData {
  id: string;
  title: string;
  presentation: 'dialog' | 'panel';
  // The layer's own timeline (docs/decisions.md D62): its lines (one segment, step 1) and its cues,
  // played through (advance auto) from 0 each time it opens, with its track (src) once every line
  // has its audio; a layer timed in seconds has no line. Its compact bar is in the layer.
  narration?: NarrationData;
  blocks: BlockData[];
}

// ── Blocks ──
// Activities carry their behaviour (also for forks of a built-in activity) and the data the player
// needs to score, save and record them; video, audio and free objects are rendered by code from
// their props; every other block is HTML rendered from its component template.

export type Behavior = 'quiz' | 'numeric' | 'fill-in' | 'sort' | 'reflection' | 'decision' | 'dialogue' | 'object' | 'results' | 'chart' | 'predict' | 'speech';

export type BlockData =
  | QuizBlock
  | NumericBlock
  | FillInBlock
  | SortBlock
  | ReflectionBlock
  | DecisionBlock
  | DialogueBlock
  | ObjectBlock
  | ResultsBlock
  | VideoBlock
  | AudioBlock
  | ChartBlock
  | PredictBlock
  | SpeechBlock
  | ContentBlock;

export interface BlockByBehavior {
  quiz: QuizBlock;
  numeric: NumericBlock;
  'fill-in': FillInBlock;
  sort: SortBlock;
  reflection: ReflectionBlock;
  decision: DecisionBlock;
  dialogue: DialogueBlock;
  object: ObjectBlock;
  results: ResultsBlock;
  chart: ChartBlock;
  predict: PredictBlock;
  speech: SpeechBlock;
}

// Blocks whose answers count: they have a key in the learner state.
export type ActivityBlock = QuizBlock | NumericBlock | FillInBlock | SortBlock | ReflectionBlock | DecisionBlock | DialogueBlock | ObjectBlock | PredictBlock;

export interface BlockBase {
  id: string;
  // Built-in type or course component id.
  type: string;
  width: 'full' | 'wide' | 'half' | 'bleed';
  // The component and its parents, when it extends another one.
  lineage?: string[];
  hidden?: true;
  // Step of the screen that reveals the block (left out for step 1).
  step?: number;
  // When it comes and goes on the screen's timeline (docs/decisions.md D28).
  timing?: TimingData;
  slot?: string;
  style?: string;
  // Extra the learner may skip: steps that open once explored and interactions-done do not wait for it (D63).
  optional?: true;
  // Continuity between screens (D65): the blocks of other screens with the same key are this one to
  // the learner; duration (ms) of the passage to it; state: for a free object, the key of the chain's
  // saved state in the learner state (one for every block of the key).
  continuity?: ContinuityData;
  // Key of its visibility in the learner state, when events show or hide it.
  vkey?: string;
  // Rendered template (blocks rendered by a template).
  html?: string;
  // Key of each named control (button, tab, disclosure) whose visited state is saved; '' names an
  // unnamed button.
  visits?: Record<string, string>;
  // What its controls are, for the words of a locked Continue ("2 markers left to open"): the steps
  // of a steps block (carousel, scroll), the events of its timeline, the markers of an interactive
  // picture (D63). Without it, "items to explore" (cards say themselves).
  explore?: 'steps' | 'events' | 'markers';
  // Slot of the template that receives blocks without a slot (components with slots).
  defaultSlot?: string | null;
  // Blocks placed in the slots of this component instance.
  blocks?: BlockData[];
}

export interface ContinuityData {
  key: string;
  duration: number;
  state?: string;
}

// A timed block's coming (in) or going (out): when, in seconds on the screen's timeline, and how.
// effect: none, fade, rise, slide, zoom, wipe, draw, or an effect of the theme (its stylesheet's
// @keyframes t-fx-<name>, and t-fx-<name>-out for its going).
export interface MomentData {
  at: number;
  effect: string;
  duration: number;
  direction?: 'left' | 'right' | 'up' | 'down';
}

export interface TimingData {
  in?: MomentData;
  out?: MomentData;
}

export interface QuizBlock extends BlockBase {
  behavior: 'quiz';
  key: string;
  props: QuizProps;
}

export interface NumericBlock extends BlockBase {
  behavior: 'numeric';
  key: string;
  props: NumericProps;
}

// Activities of D63: blanks to fill, items to place, a reflection. Their markup comes from their
// template; the player builds the fields, lists and buttons in its hooks.
export interface FillInBlock extends BlockBase {
  behavior: 'fill-in';
  key: string;
  props: FillInProps;
}

export interface SortBlock extends BlockBase {
  behavior: 'sort';
  key: string;
  props: SortProps;
}

export interface ReflectionBlock extends BlockBase {
  behavior: 'reflection';
  key: string;
  props: ReflectionProps;
}

export interface DecisionBlock extends BlockBase {
  behavior: 'decision';
  key: string;
  props: DecisionProps;
}

// A branching conversation (D61): its graph, its keys and its settings, read by the pure walk
// (dialogue/); its progress is saved under key (dialogue/state.ts).
export interface DialogueBlock extends BlockBase {
  behavior: 'dialogue';
  key: string;
  props: DialogueProps;
}
export type DialogueProps = DialogueData;

export interface ObjectBlock extends BlockBase {
  type: 'free-object';
  behavior: 'object';
  key: string;
  props: ObjectBlockProps;
}

export interface ResultsBlock extends BlockBase {
  behavior: 'results';
  props: ResultsProps;
}

export interface VideoBlock extends BlockBase {
  type: 'video';
  behavior?: undefined;
  props: VideoProps;
}

export interface AudioBlock extends BlockBase {
  type: 'audio';
  behavior?: undefined;
  props: AudioProps;
}

// Charts and diagrams (D60): their markup is the chart at rest, drawn when the course is built; the
// chart behaviour moves it. A trend in predict mode is an activity: its guess is kept under key.
export interface ChartBlock extends BlockBase {
  behavior: 'chart';
  props: ChartProps;
}
export interface PredictBlock extends BlockBase {
  behavior: 'predict';
  key: string;
  props: ChartProps & { predict: PredictData };
}
export interface ChartProps {
  chart: string;
  highlight?: string;
  // Narrated screens: when the voice brings each item (seconds on the timeline, by item id), and
  // when it is done with them; whether items appear at their moment or only take the spotlight.
  beats?: Record<string, number>;
  beatsEnd?: number;
  revealOnBeats?: boolean;
  // trend: its points (px and py are fractions of the plot, from its top left), its scale and format.
  points?: { x: number | string; y: number; px: number; py: number }[];
  domain?: [number, number];
  format?: { unit?: string; decimals?: number };
}
export interface PredictData {
  // Index of the last point shown before the guess.
  from: number;
  hint?: string;
  button?: string;
  close?: string;
  far?: string;
  tolerance: number;
  scored: boolean;
  weight: number;
  objective?: string;
}

// A character speaking (D63): the speaker as course.json gives it (its name, colour and look, its SVG
// sanitized), or null when the course has no such speaker (E_SPEECH_SPEAKER).
export interface SpeechBlock extends BlockBase {
  behavior: 'speech';
  props: SpeechProps;
}
export interface SpeechProps {
  speaker: DialogueSpeakerData | null;
}

// Headings, text, images, callouts, buttons… and course components without a behaviour.
export interface ContentBlock extends BlockBase {
  behavior?: undefined;
  props?: undefined;
}

export interface QuizProps {
  mode: 'single' | 'multiple';
  objective?: string;
  scored: boolean;
  weight: number;
  attempts: number;
  showCorrectAnswer: boolean;
  // compact: the feedback without the chosen option's text, which only screen readers hear.
  feedbackStyle?: 'compact';
  // images: picture cards; image: zones on one picture, named « Zone n » until the answer is final
  // (absent: text).
  presentation?: 'images' | 'image';
  options: QuizOption[];
  questionRef?: string;
}

export interface QuizOption {
  id: string;
  text: string;
  correct: boolean;
  feedbackHtml: string;
}

export interface NumericTolerance {
  absolute?: number;
  percent?: number;
}

export interface NumericProps {
  answer: number;
  tolerance: NumericTolerance | null;
  unit: string;
  objective?: string;
  scored: boolean;
  weight: number;
  attempts: number;
  showCorrectAnswer: boolean;
  feedback: { correctHtml: string; incorrectHtml: string };
  misconceptions: Misconception[];
  questionRef?: string;
}

export interface Misconception {
  id: string;
  value: number;
  tolerance: NumericTolerance | null;
  feedbackHtml: string;
}

// The rendered text holds a <span data-t-blank="n"> (n from 1) where each blank was; its answers are here.
export interface FillInProps {
  presentation: 'typed' | 'menus' | 'bank';
  objective?: string;
  scored: boolean;
  weight: number;
  attempts: number;
  showCorrectAnswer: boolean;
  ignoreAccents: boolean;
  // Accepted answers (the first is shown after the last try) and, typed, the longest answer kept.
  blanks: { answers: string[]; maxLength: number }[];
  // menus: the words of each list (every blank's first answer once, and the distractors); bank: the
  // words to place (every blank's first answer, and the distractors). In their fixed shuffled order.
  words: string[];
  feedback: { correctHtml: string; incorrectHtml: string };
}

export interface SortProps {
  presentation: 'pairs' | 'categories' | 'order';
  objective?: string;
  scored: boolean;
  weight: number;
  attempts: number;
  showCorrectAnswer: boolean;
  // In the author's order (order: the right one); target: the index of the item's target (-1: none).
  // The markup shows them in a fixed shuffled order.
  items: { id: string; label: string; target: number }[];
  targets: { id: string; label: string }[];
  // The items' indices in the order they are shown at first (fixed at build time, never the right one).
  shuffled: number[];
  feedback: { correctHtml: string; incorrectHtml: string };
}

export interface ReflectionProps {
  presentation: 'text' | 'scale';
  objective?: string;
  // The prompt as plain text: « Mes réponses » and the interaction's description.
  prompt: string;
  maxLength: number;
  rows: number;
  modelHtml: string;
  download: boolean;
  scale: { min: number; max: number; minLabel: string; maxLabel: string };
}

export interface DecisionProps {
  objective?: string;
  scored: boolean;
  weight: number;
  allowChange: boolean;
  options: DecisionOption[];
}

export interface DecisionOption {
  id: string;
  label: string;
  feedbackHtml: string;
  correct?: boolean;
}

export type AspectRatio = '16:9' | '21:9' | '3:2' | '4:3' | '1:1' | '3:4' | '2:3' | '9:16' | 'auto' | 'fill';

export interface ObjectBlockProps {
  // Object id, a key of CourseData.objects.
  object: string;
  title: string;
  // Prop values of the object: manifest defaults (or their theme token), then the block's.
  props: JsonObject;
  aspectRatio: AspectRatio;
  narrowAspectRatio: AspectRatio | null;
  minHeight: number | null;
  maxHeight: number | null;
  textAlternativeHtml: string;
  scored: boolean;
  weight: number;
  // The block's wording of the object's accessibility texts (the block schema has keyboard only).
  a11y?: { description?: string; keyboard?: string };
  // Words of the object: manifest strings, reworded or translated by the block.
  strings: Record<string, string>;
}

export interface ResultsProps {
  showScore: boolean;
  showStatus: boolean;
  allowRetry: boolean;
  passedMessageHtml: string;
  failedMessageHtml: string;
  completedMessageHtml: string;
}

export interface VideoProps {
  // Paths in the package (assets/…).
  src: string;
  captions?: string;
  poster?: string;
  title: string;
  transcriptHtml: string; // empty: none
  alt: string; // what a loop or a silent video shows
  loop: boolean; // muted, in a loop, like an animated image
  decorative: boolean; // a loop ignored by assistive technologies
  generated: boolean;
}

export interface AudioProps {
  src: string;
  title: string;
  transcriptHtml: string; // empty: none
  decorative: boolean; // a sound that carries no information (an ambiance, music): no transcript
  generated: boolean;
}

// ── Events (trigger → conditions → actions), as authored in the screen ──

export type TriggerType = 'screen.enter' | 'click' | 'quiz.submitted' | 'decision.selected' | 'object.event' | 'variable.changed' | 'layer.closed' | 'timeline.reached' | 'timeline.ended' | 'media.ended' | 'dialogue.started' | 'dialogue.node' | 'dialogue.line' | 'dialogue.chosen' | 'dialogue.ended';

export interface EventData {
  id: string;
  description?: string;
  on: Trigger;
  if?: Condition[];
  do: Action[];
  else?: Action[];
}

export interface Trigger {
  type: TriggerType;
  // Block or layer id.
  target?: string;
  result?: 'correct' | 'incorrect' | 'any';
  option?: string;
  // dialogue.node, dialogue.chosen: a node; dialogue.line: a line; dialogue.ended: an ending.
  node?: string;
  line?: string;
  ending?: string;
  name?: string;
  where?: Record<string, string | number | boolean | null>;
  variable?: string;
  // timeline.reached: a line of the narration, its start (default) or its end.
  at?: { line: string; edge?: 'start' | 'end' };
  // timeline.ended (and timeline.reached in seconds): the timeline of that layer (D62); absent: the
  // screen's.
  layer?: string;
}

export type VariableValue = boolean | number | string;

export type Condition =
  | { variable: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; value: VariableValue; visited?: undefined }
  | { visited: string; name?: string; variable?: undefined }
  // What a dialogue's scored run gave (dialogue/run.ts eventConditionHolds).
  | (DialogueEventCondition & { variable?: undefined; visited?: undefined });

export type Action =
  | { type: 'go-to'; screen: string }
  | { type: 'show-layer'; layer: string }
  // Without a layer: the one open on top.
  | { type: 'hide-layer'; layer?: string }
  | { type: 'show-block' | 'hide-block'; block: string }
  | { type: 'reveal-step'; step: number }
  | { type: 'set-variable'; variable: string; value: VariableValue }
  | { type: 'increment-variable'; variable: string; by: number }
  | { type: 'complete-screen' }
  | { type: 'set-object-props'; block: string; props: JsonObject }
  | { type: 'exit-course' }
  // layer: the timeline of that layer while it is open (D62).
  | { type: 'pause-timeline' | 'play-timeline'; layer?: string }
  // to: compiled to the time of the moment (seconds on the timeline); layer: on that layer's timeline
  // (named, or the layer whose line it goes to).
  | { type: 'seek-timeline'; to: unknown; time?: number; layer?: string }
  | { type: 'play-media' | 'pause-media'; block: string }
  // A dialogue block of the screen: begin it, move it to a node, start it over (D61).
  | { type: 'start-dialogue' | 'restart-dialogue'; block: string }
  | { type: 'goto-dialogue'; block: string; node: string };

// ── Variables ──

export interface VariableData {
  id: string;
  type: 'boolean' | 'number' | 'string' | 'choice';
  default: VariableValue;
  description?: string;
  maxLength?: number;
  options?: string[];
  minimum?: number;
  maximum?: number;
  persist?: boolean;
  // Key in the learner state; null when the variable is not persisted.
  key: string | null;
}

// ── Free objects ──

export interface ObjectDefinition {
  id: string;
  version: string;
  // Folder of the object in the package (objects/<id>).
  dir: string;
  // Parts with a stable id (manifest objects).
  objects: ObjectPart[];
  // Declared events, by name.
  events: Record<string, ObjectEventDeclaration>;
  // Maximum JSON length of the saved state; 0 when the state is not saved.
  persistMax: number;
  assets: ObjectAsset[];
  // Extra sandbox permissions (allow-<permission>).
  permissions: string[];
  a11y: { description?: string; keyboard?: string };
  decoration?: true;
}

export interface ObjectPart {
  id: string;
  label: string;
  selectable?: boolean;
}

export interface ObjectAsset {
  id: string;
  // Path relative to the object folder.
  file: string;
  type: string;
}

export interface ObjectEventDeclaration {
  payload: DataSchema | null;
  tracking: ObjectEventTracking | null;
}

export interface ObjectEventTracking {
  interaction?: {
    type: 'choice' | 'true-false' | 'performance' | 'sequencing' | 'numeric' | 'fill-in' | 'matching' | 'likert';
    objective?: string;
    // Payload field holding the learner response.
    responseField?: string;
    // Payload boolean field telling whether the response is correct.
    correctField?: string;
  };
  // Payload field holding a score between 0 and 1.
  score?: { field: string };
  completion?: boolean;
}
