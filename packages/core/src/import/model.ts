// The course an importer read, before it becomes an Elabora module: one model for Storyline's
// source (.story), Storyline's published output and Rise's exports (docs/decisions.md D47). Readers
// fill it with what the source says, in the source's terms (pages, items, boxes, triggers);
// `convert.ts` decides what each becomes in Elabora and reports every loss.

export type ImportKind = 'storyline-source' | 'storyline-published' | 'rise';

// Where a medium is in the source (a path inside its archive or folder) and what it is.
export interface SourceMedia {
  path: string;
  kind: 'image' | 'video' | 'audio';
  contentLibrary?: boolean; // Articulate's Content Library: may not leave Articulate's tools
}

// A box on a slide, in the slide's pixels (Storyline): x and y from its top left corner.
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// What an item is, in Elabora's words when there is a match, else the source's feature named.
export type SourceItemBody =
  | { kind: 'text'; markdown: string; fontSize?: number; fonts?: string[]; heading?: boolean }
  | { kind: 'heading'; text: string; level?: 2 | 3 | 4 }
  // presentation and what goes with it (D63): a title and a text beside or over it, a band's crop.
  | { kind: 'image'; media: SourceMedia; alt?: string; decorative?: boolean; caption?: string; presentation?: 'centered' | 'wide' | 'band' | 'beside' | 'over'; focus?: { x: number; y: number }; title?: string; markdown?: string; share?: 'half' | 'third' | 'two-thirds' }
  | { kind: 'video'; media: SourceMedia; title?: string; captions?: SourceMedia; transcript?: string; poster?: SourceMedia }
  | { kind: 'audio'; media: SourceMedia; title?: string; transcript?: string }
  | { kind: 'button'; label: string }
  | { kind: 'callout'; markdown: string; title?: string; variant?: 'info' | 'tip' | 'warning' | 'important' }
  // presentation: panels, tabs, flip cards or cards one at a time (D63); an item's picture when it has one.
  | { kind: 'accordion'; presentation?: 'accordion' | 'tabs' | 'cards' | 'stack'; items: { title: string; markdown: string; media?: SourceMedia; alt?: string }[] }
  | { kind: 'quiz'; stem: string; mode: 'single' | 'multiple'; options: { text: string; correct: boolean; feedback?: string }[]; correctFeedback?: string; incorrectFeedback?: string; attempts?: number; scored?: boolean }
  | { kind: 'numeric'; stem: string; answer: number; tolerance?: number; unit?: string; correctFeedback?: string; incorrectFeedback?: string; scored?: boolean }
  | { kind: 'results' }
  // The activities of D63: a text with blanks ([[answer|other]]), items to place (pairs, categories,
  // order: items in the right order), a question answered on a scale.
  | { kind: 'fill-in'; stem?: string; markdown: string; presentation?: 'typed' | 'menus' | 'bank'; distractors?: string[]; correctFeedback?: string; incorrectFeedback?: string; scored?: boolean }
  | { kind: 'sort'; presentation: 'pairs' | 'categories' | 'order'; stem?: string; items: { text: string; target?: string }[]; targets?: { ref: string; text: string }[]; correctFeedback?: string; incorrectFeedback?: string; scored?: boolean }
  | { kind: 'reflection'; prompt: string; scale?: { min: number; max: number; minLabel?: string; maxLabel?: string } }
  // A native block of D60 or D63 (statement, divider, gallery, columns, steps, hotspots, a chart)
  // with its props as Elabora writes them, its media to copy and where each goes in the props. What
  // happens when a medium cannot be kept: its prop is left out (unset), the list entry holding it
  // goes (entry), or the item becomes otherwise (block, and when nothing would be left). children:
  // items placed in the block's slots (columns).
  | { kind: 'block'; type: string; props: Record<string, unknown>; media?: SourceBlockMedia[]; otherwise?: SourceItem; children?: { slot: string; item: SourceItem }[] }
  // A Rise continue divider: what follows opens with Continue, or once the activities above are answered.
  // explored: once the blocks above are explored (Rise's "complete block above"), D63.
  | { kind: 'continue'; opens: 'continue' | 'answered' | 'explored'; label?: string }
  // A shape or line without text: decoration, which the design layer redraws if it must.
  | { kind: 'shape' }
  // A feature Elabora has no block for yet: what can be kept of it (its text, a medium) and why.
  | { kind: 'fallback'; feature: string; markdown?: string; media?: SourceMedia; alt?: string; detail?: string }
  // A feature nothing of which is kept.
  | { kind: 'unsupported'; feature: string; detail?: string }
  // A branching conversation (Rise's scenario block): its moments, each a few lines and the learner's
  // answers with where they go; what is not kept (the characters' poses, the backdrops) in lost.
  | { kind: 'dialogue'; title?: string; nodes: SourceDialogueNode[]; lost?: { feature: string; detail?: string }[] };

export interface SourceBlockMedia {
  at: (string | number)[]; // where the asset path goes in the block's props
  media: SourceMedia;
  hint?: string; // a name for the asset file
  missing: 'unset' | 'entry' | 'block';
}

export interface SourceDialogueNode {
  ref: string;
  title?: string;
  // Lines in order: a character's (speaker: their name), or a narration (no speaker).
  lines: { speaker?: string; text: string }[];
  options: SourceDialogueOption[];
  // Where the node goes when it has no options, or for options without a way of their own: a node's
  // ref, or the end (default: the next node of the list).
  next?: string | { end: true };
}

export interface SourceDialogueOption {
  text: string;
  feedback?: string;
  quality?: 'good' | 'ok' | 'bad';
  // A node's ref, the end, the same options again (try again); null: the node's way out.
  to: { node: string } | { end: true } | { retry: true } | null;
}

export type SourceItem = SourceItemBody & {
  ref: string; // the source's id of the item, for the report and the triggers
  name?: string; // the name the author gave it in the source (Storyline's timeline names)
  box?: Box; // positioned sources (Storyline)
  start?: number; // seconds after the slide starts when the item appears (Storyline's timeline)
  hidden?: boolean; // hidden until a trigger shows it
  states?: string[]; // custom states beyond the built-in ones (Storyline)
  order?: number; // the source's own reading order (Storyline's focus order), when it has one
  width?: 'half'; // two items side by side in the source (Rise's two columns)
  // The item stands for a source feature Elabora has no block for yet (tabs read as an accordion):
  // reported as a fallback, with a note for the author on its block.
  fallbackOf?: { feature: string; detail?: string };
};

export interface SourceCondition {
  variable: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
  value: string | number | boolean;
}

export type SourceAction =
  | { type: 'go-to'; page: string } // a page's ref, or next / previous
  | { type: 'show-layer'; layer: string }
  | { type: 'hide-layer'; layer?: string }
  | { type: 'show-item'; item: string }
  | { type: 'hide-item'; item: string }
  | { type: 'set-variable'; variable: string; value: string | number | boolean }
  | { type: 'adjust-variable'; variable: string; by: number }
  | { type: 'play-media'; item: string }
  | { type: 'pause-media'; item: string }
  | { type: 'exit' }
  | { type: 'other'; label: string }; // JavaScript, change state, lightbox…: reported, not run

export type SourceTriggerEvent =
  | { type: 'click'; item: string }
  | { type: 'page-start' }
  | { type: 'page-end' } // the slide's timeline ends
  | { type: 'layer-closed'; layer: string }
  | { type: 'media-ended'; item: string }
  | { type: 'variable-changed'; variable: string }
  | { type: 'other'; label: string }; // hover, drag and drop, key press, timeline cue…

export interface SourceTrigger {
  ref: string;
  on: SourceTriggerEvent;
  conditions: SourceCondition[];
  actions: SourceAction[];
}

export interface SourceLayer {
  ref: string;
  title: string;
  modal: boolean; // the base layer cannot be used while it shows
  feedback?: 'correct' | 'incorrect' | 'try-again'; // a question's feedback layer
  items: SourceItem[];
  triggers: SourceTrigger[];
}

export interface SourcePage {
  ref: string;
  title: string;
  notes?: string; // Storyline's slide notes (often the narration's script)
  kind: 'content' | 'question' | 'result';
  positioned: boolean; // items carry boxes on a slide of the course's size
  items: SourceItem[]; // in the source's order: z-order on a slide, reading order in Rise
  layers: SourceLayer[];
  triggers: SourceTrigger[];
}

export interface SourceSection {
  ref: string;
  title: string;
  pages: SourcePage[];
}

export interface SourceVariable {
  name: string;
  type: 'boolean' | 'number' | 'string';
  default: string | number | boolean;
}

// A loss the reader found while reading (a feature it skipped, a part it could not read).
export interface ReaderLoss {
  page?: string; // page ref
  item?: string; // item ref
  feature: string;
  detail?: string;
}

export interface SourceCourse {
  kind: ImportKind;
  title: string;
  description?: string;
  language?: string; // BCP 47, when the source says
  slideSize?: { width: number; height: number };
  sections: SourceSection[];
  variables: SourceVariable[];
  passingScore?: number; // 0–100, the source's quiz passing score
  accentColor?: string; // #rrggbb: Rise's theme colour
  fonts?: { body?: string; heading?: string }; // the course's typefaces, when its texts do not say theirs
  navigation?: 'free' | 'linear'; // Rise's restricted navigation is linear
  losses: ReaderLoss[];
}
