// What a host (the desktop app, the Node canvas host, tests) and the editor canvas (canvas.ts, the
// player mounted for one screen without SCORM, navigation chrome or saving) say to each other.
// Types only. @elabora/core renderScreen produces the render data.
//
//   host → canvas   window.postMessage (from the parent window), or window.__elaboraCanvas.receive()
//     { type: 'elabora/render', id?, render }   show a screen, or update the one shown in place
//     { type: 'elabora/view', id?, view }       change the step, the layer, the state shown or a
//                                             dialogue's path (view.dialogue)
//     { type: 'elabora/scroll', by, at? }       a wheel turned over the host's overlay: scrolls as it
//                                             would have under the pointer
//     { type: 'elabora/focus', block, x, y }   a block's focal point for the moment (the inspector's
//                                             drag): its pictures' crop follows, without a render
//   canvas → host   window.parent.postMessage, and window.__elaboraCanvas.onMessage listeners
//     { type: 'elabora/ready', chrome, protocol? }  the canvas listens
//     { type: 'elabora/layout', … }             where every block is (selection and handles)
//     { type: 'elabora/navigate', screen, by? } an event of the screen, or the live bars, go to
//                                             another screen
//     { type: 'elabora/error', id?, message }   render data that could not be shown
//
// The player's preview, elabora-player-preview/1 (page option chrome=live: the app's « Lecteur »
// tab; canvas-live.ts). Its messages carry protocol: 'elabora-player-preview/1'; one of another
// version gets elabora/error naming the version the canvas speaks.
//   host → canvas
//     { type: 'elabora/highlight', item, bar? }  outlines an item of the bars (null: none); bar
//                                             tells the two spacers apart
//     { type: 'elabora/open', panel, resource?, term? }  opens a panel: resources (a resource's
//                                             preview), glossary (at a term), about, outline,
//                                             display, language, transcript
//     { type: 'elabora/close' }                 closes what is open over the screen
//   canvas → host
//     { type: 'elabora/item', id, bar }         the author clicked an item of the bars
//     { type: 'elabora/language', language }    the author chose a language in « Langue »
// Previous, Next, the outline and a part of the progress post elabora/navigate with by: previous,
// next, outline or progress; the host renders that screen (or not). Next on a slide with steps
// left reveals the next one, as Continue does.

import type { CourseData, PlayerItemId } from './course-data.ts';

export const PLAYER_PREVIEW_PROTOCOL = 'elabora-player-preview/1';

// One screen as the canvas shows it.
export interface ScreenRender {
  // Screen id: a render of another screen replaces the one shown.
  screen: string;
  // The course data reduced to that screen: course-level fields, its section, the screen, the free
  // objects it places (and the backdrop's).
  course: CourseData;
  view: RenderView;
  // Left out by a host when unchanged since its last render (same hash).
  styles?: RenderStyles;
  // The files the screen uses, with the hash of their content: the canvas loads again what changed
  // at the same path.
  files?: RenderFile[];
  // The course's screens in order, by section, with their titles: what the live bars' outline,
  // Previous and Next go through (chrome=live).
  outline?: RenderOutline;
}

export interface RenderOutline {
  sections: { id: string; title: string; screens: { id: string; title: string }[] }[];
}

// What the host may open over the screen of the live bars.
export type PreviewPanel = 'resources' | 'glossary' | 'about' | 'outline' | 'display' | 'language' | 'transcript';

export interface RenderFile {
  // Path in the package (assets/…, theme/…, objects/<id>/…).
  path: string;
  kind: string;
  // null when the host's snapshot has none.
  hash: string | null;
}

// What the canvas shows of the screen, as captures do.
export interface RenderView {
  // 'answered': every activity shows its tallest outcome and concealed blocks are shown.
  state: 'initial' | 'answered';
  // Steps revealed up to this one; null: every step.
  step: number | null;
  // A layer opened over the screen.
  layer: string | null;
  // A timed screen as it is when one of its lines starts (or ends), or at a time in seconds on its
  // timeline (the editor's playhead; the engine turns an anchor into its time): its step, its
  // caption, its timed blocks where their effects are then.
  at?: { line: string; edge?: 'start' | 'end' } | { time: number } | null;
  // Every step shown, those after the first faded in their place (data-t-ghost): the editor's phone
  // width, where a narrated slide goes on step by step.
  ghost?: boolean;
  // A dialogue of the screen (D61) as the learner sees it after these choices (option ids, one per
  // decision, from its start), at rest: the thread so far, the options of the decision reached, or its
  // end. node: then at that node (the author selected it in the graph). null or left out: each
  // dialogue at its start, its first decision.
  dialogue?: { block: string; choices?: string[]; node?: string } | null;
}

// The design layer, in cascade order after elabora/player.css: one style element per sheet.
export interface RenderStyles {
  hash: string;
  sheets: RenderSheet[];
}

export interface RenderSheet {
  // layers, a stylesheet path (components/<id>/component.css, theme/theme.css), fonts or root.
  id: string;
  css: string;
}

// token: the token of the canvas page URL, when it has one (messages posted by the parent window).
export type HostMessage =
  | { type: 'elabora/render'; id?: string | number; token?: string; render: ScreenRender }
  | { type: 'elabora/view'; id?: string | number; token?: string; view: Partial<RenderView> }
  // A host that lays something over the page to take the pointer (the app's selection) takes the
  // wheel with it, and passes it on: by, the distance in CSS px of the canvas viewport; at, where
  // the pointer is there. What can still scroll that way under the point scrolls, else the page.
  | { type: 'elabora/scroll'; token?: string; by: { x: number; y: number }; at?: { x: number; y: number } }
  // The focal point being dragged in the inspector (D63): x and y from 0 to 1 become the block's
  // --focus-x and --focus-y (object-position) until the next render gives the saved one.
  | { type: 'elabora/focus'; token?: string; block: string; x: number; y: number }
  | PreviewHostMessage;

// The host's messages of the player's preview (chrome=live).
export type PreviewHostMessage =
  | { type: 'elabora/highlight'; protocol: typeof PLAYER_PREVIEW_PROTOCOL; token?: string; item: PlayerItemId | null; bar?: 'top' | 'bottom' }
  | { type: 'elabora/open'; protocol: typeof PLAYER_PREVIEW_PROTOCOL; token?: string; panel: PreviewPanel; resource?: string; term?: string }
  | { type: 'elabora/close'; protocol: typeof PLAYER_PREVIEW_PROTOCOL; token?: string };

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// A block where the canvas shows it, in CSS px of the canvas viewport.
export interface BlockLayout {
  id: string;
  rect: LayoutRect;
  // The slot of a screen layout or of a component instance that holds it (null: the screen column).
  slot: string | null;
  // The layer it is in (null: the screen).
  layer: string | null;
  // The component instance whose slot holds it.
  parent: string | null;
  // Not visible yet: a pending step or a block concealed by an event (it keeps its place in slides).
  hidden: boolean;
  // A timed block (docs/decisions.md D28) at the time shown: not there yet (before), coming, there,
  // going or gone (after), with its effect's progress (0 to 1) while it comes or goes. Before and
  // after it keeps its place, hidden.
  timed?: { state: 'before' | 'entering' | 'shown' | 'leaving' | 'after'; progress?: number };
  // Its texts the author can point at (data-t-field of the render): the prop's path below props
  // (options.1.label) and where it is. Not those of the blocks in its slots.
  fields?: FieldLayout[];
}

export interface FieldLayout {
  path: string;
  rect: LayoutRect;
}

export interface LayoutMessage {
  type: 'elabora/layout';
  // The last render or view message applied.
  id: string | number | null;
  screen: string | null;
  // Step shown, steps of the screen, open layer and state.
  step: number;
  steps: number[];
  layer: string | null;
  state: RenderView['state'];
  // Time taken to apply the last render, in ms (receipt to DOM updated).
  applyMs: number;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  screenRect: LayoutRect | null;
  blocks: BlockLayout[];
}

export type CanvasMessage =
  // chrome: the page option (none, player: the bars inert, live: the player's preview, which speaks
  // protocol).
  | { type: 'elabora/ready'; chrome: 'none' | 'player' | 'live'; protocol?: typeof PLAYER_PREVIEW_PROTOCOL }
  | LayoutMessage
  // by: what went there in the live bars (an event of the screen says none).
  | { type: 'elabora/navigate'; screen: string; by?: 'previous' | 'next' | 'outline' | 'progress' }
  | { type: 'elabora/error'; id: string | number | null; message: string }
  | { type: 'elabora/item'; protocol: typeof PLAYER_PREVIEW_PROTOCOL; id: PlayerItemId; bar: 'top' | 'bottom' }
  | { type: 'elabora/language'; protocol: typeof PLAYER_PREVIEW_PROTOCOL; language: string };
