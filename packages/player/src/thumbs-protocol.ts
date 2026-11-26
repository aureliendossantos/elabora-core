// What shows a miniature of the editor: a screen in small (the list of screens, the Storyboard, the Planche), a screen at a
// moment (the Revue), a screen with a block it does not have yet (« Ajouter un bloc »), a screen with a variant of the charter
// (the Charte), and what measures a screen (« Déborde à l'écran »). Types and constants only: the window, the engine and the
// hosts build against this file (D130, D132).
//
// The window asks the host for one thing, a scene shown in an element:
//
//     host.captures.show(module, scene, element): ThumbShown
//
// - On the desktop the host does what it always did: the capture of the scene by a hidden page (`captures.thumbnail`,
//   `momentThumbnail`, `blockPreview`, `charterPreview`, kept on disk), put in an <img> that fills the element. Nothing changes.
// - In a browser the host calls the engine for the scene's render (ThumbRequests below) and gives it to `createThumbs`
//   (canvas-thumbs.ts), which shows it in a frame of the canvas page, in the element: a live thumbnail, not an image.
//
// The window guarantees to the host:
// - the element has its size when `show` is called (a box of the course's aspect, `width`/`height` of the render say it);
// - `show` is called when the element is mounted and `release()` when it goes away (a list may mount all its rows or only
//   those near the view): the host itself draws those in the view, 120 ms after they are, and keeps a frame whose element left
//   the view while a place is free (THUMB_LIMIT), so a row that comes back is drawn at once; a window that releases a row as
//   it leaves the view is right too, it only keeps nothing;
// - `refresh()` is called when what the scene shows may have changed (the host decides whether it has: see
//   THUMB_REFRESH_MS; out of the view, when the element comes back);
// - the frame of the canvas has `info.sandbox` as its sandbox attribute (canvas-page-host.ts); thumbnails carry their own.

import type { ScreenMeasurement, ScreenRender } from './canvas-protocol.ts';

// How many live thumbnails a window holds at once in a browser. A live thumbnail is a frame of the canvas page, 25 to 60 ms of
// drawing and 150 to 300 ms of loading the first time; eight of them cost +277 MB in Chromium, +133 MB in Firefox and +272 MB in
// WebKit (sixteen: +441, +238 and +561 MB, measured on a quiet Mac). Frames out of the view are kept while fewer are live; beyond
// it the frame farthest from the view gives its place to an element in the view, and an element in the view keeps its skeleton
// until a frame is free (the ones nearest to the view, and the screen of the canvas, first): a view of more than eight rows (the
// Planche shows 9 to 12) draws the eight nearest its middle (D130).
export const THUMB_LIMIT = 8;
// A live thumbnail is shown again at most this often, in ms, however often the window says its screen may have changed: a
// retouch in the canvas (a keystroke) does not draw sixteen frames each time. A refresh waits for the rest of this time,
// the screen of the canvas first, one frame in flight for each thumbnail and no more than THUMB_REFRESH_PARALLEL at once.
export const THUMB_REFRESH_MS = 400;
export const THUMB_REFRESH_PARALLEL = 2;
// How long an element is in the view before its thumbnail is asked for, in ms (a flick of the wheel asks for none).
export const THUMB_SETTLE_MS = 120;

// The screen at a moment of its timeline (the Revue's contact sheet): the step, a narration's line (its start or its end), or a time.
export interface MomentAt {
  step: number;
  line?: string;
  edge?: 'start' | 'end';
  time?: number;
}

// What « Ajouter un bloc » previews: add_block's arguments (the screen, the block, where it goes);
// replace: a block it takes the place of (the paragraph « / » was typed in: add_block's own replace);
// layout: a screen layout given to the screen instead of a block added (a recipe, D63); backdrop: a
// backdrop variant instead (null: the course's own backdrop, as a screen that picks none);
// screenStyle: a screen style instead.
export interface BlockPreviewArgs {
  replace?: string;
  screen: string;
  layout?: { layout: string; layoutProps?: Record<string, unknown> };
  backdrop?: string | null;
  screenStyle?: string;
  block?: { type: string; props?: Record<string, unknown>; style?: string; slot?: string; step?: number; blocks?: { id?: string; type: string; slot?: string; props?: Record<string, unknown> }[] };
  after?: string | null;
  layer?: string | null;
  parent?: string | null;
}

// What a miniature of the Charte shows: the screen with a backdrop variant (null: the course's own), a screen style or a layout.
export type CharterPreviewArgs = { screen: string; backdrop: string | null } | { screen: string; style: string } | { screen: string; layout: string };

// What is shown. `mini` (a block scene): the block alone, small, as the list of blocks shows it.
export type Scene =
  | { kind: 'screen'; screen: string; language?: string | null }
  | { kind: 'moment'; screen: string; at: MomentAt }
  | { kind: 'block'; args: BlockPreviewArgs; mini?: boolean }
  // The host turns it into a 'block' scene (backdrop, screenStyle or layout of its args).
  | { kind: 'charter'; args: CharterPreviewArgs };

// What the host gives back for `show`: release when the element goes, refresh when the scene may have changed, `drawn`
// settles once it is drawn (true) or cannot be (false: closed, refused, no frame free before it was released). A thumbnail that
// cannot be drawn stays what the window shows while it waits (its skeleton).
// A block's scene shows the part of the screen around the block (`mini`: the block alone), as the desktop's capture frames it, and
// gives `overflow`: whether the slide runs past the window with the block in it, from its first drawing (false when it cannot be
// drawn); a refresh does not change it, a scene shown again asks again.
export interface ThumbShown {
  release(): void;
  refresh(): void;
  readonly drawn: Promise<boolean>;
  readonly overflow?: Promise<boolean>;
}
// The window's call, on the host's `captures` domain (the module is the window's id of it).
export type CapturesShow = (module: string, scene: Scene, element: HTMLElement) => ThumbShown;

// ── The engine's side: the four requests of a browser's engine (packages/engine/src/browser/session.ts) ────────────
// Twins of the desktop's `thumbPush`, `momentPush`, `blockPreviewPush` and `measurePush` (the app's engine host), which push the render to a
// hidden page: these give it back. Each gives the render frozen (`ScreenRender`: its view fixed at the step, the layer and the moment asked)
// and **declares the files the render names to the relay's source**: the module's files served to the canvas are those that renders named,
// and nothing else (the security review's third lock). A request for a screen that does not exist is an error (`not_found`).
//   width/height: the course's reference size, in px: the frame is drawn at it and scaled to the element.
//   version: changes if and only if the thumbnail's pixels would (a hash of the render and the size: the desktop's thumbVersion). A thumbnail
//     already drawn at this version is not drawn again.
export interface SceneRender {
  id: string;
  render: ScreenRender;
  width: number;
  height: number;
  version: string;
}
export interface ThumbRequests {
  // A screen in the module's language, or in another (`language`: the translation as the package would have it).
  thumbRender: { params: { screen: string; language?: string | null }; result: SceneRender };
  // The screen at a moment (as the desktop's momentPush: a time, or a step and the start or end of a line).
  momentRender: { params: { screen: string; at: MomentAt }; result: SceneRender };
  // The screen as add_block would leave it (nothing is written), or with a layout, a backdrop or a screen style (as blockPreviewPush):
  // `block` is the id of the block added ('' for a layout, a backdrop or a style: the page from its top), `slides` whether the course is slides.
  blockPreviewRender: { params: { args: BlockPreviewArgs }; result: SceneRender & { block: string; slides: boolean } };
  // The screen measured as learners see it: the render has its fields (`fields: true`), and the canvas answers `measure`; `language` null is the course's own.
  measureRender: { params: { screen: string; language: string | null }; result: SceneRender };
}
export type ThumbRequestName = keyof ThumbRequests;

// What the browser's host gives `createThumbs`: the engine's four requests as one function, and nothing else of the engine.
export interface ThumbSource {
  render<Name extends ThumbRequestName>(name: Name, params: ThumbRequests[Name]['params']): Promise<ThumbRequests[Name]['result']>;
}

// A screen measured (« En contexte »): the canvas's own answer to `measure` (canvas-protocol.ts). The host's `captures.measure(module, screen, language)`
// gives it, or null when it could not be measured.
export type ScreenMeasure = ScreenMeasurement;
export type CapturesMeasure = (module: string, screen: string, language: string | null) => Promise<ScreenMeasure | null>;
