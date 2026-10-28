// The editor canvas: the player mounted for one screen, without SCORM, navigation chrome or saving
// (chrome: false), for the desktop app and agents to see exactly what learners will see. Bundled as
// elabora/canvas.js; a host page loads it after elabora/player.css (see canvas-protocol.ts for the
// messages).
//
// Render data for the screen shown updates it in place (screen-view.ts update): blocks whose data
// did not change keep their nodes, so a free object keeps running while the author types next to
// it; the scroll position, the step and the open layer stay. The view (state, step, layer) is
// applied as captures apply it. After each change the canvas reports where every block is, so the
// host can draw selection and handles over it.
//
// Messages from the parent window must carry the token of the page URL (?token=…) when it has one:
// a page that embeds the canvas without it cannot make it render anything.
//
// Page options, in its URL: chrome=player shows the player's bars around the screen (D58), inert,
// so a slide has the room it has in a package (elabora look); chrome=live shows them working, the
// player's preview of the app's « Lecteur » tab (canvas-live.ts, protocol elabora-player-preview/1);
// frames=<port> loads the frames of free objects from that port of the same host (frames.ts), for
// browser panes that refuse frames of an opaque origin.

import { forgetThemeKeyframes } from './timed-blocks.ts';
import { createCourseState, flatBlocks, hasBehavior } from './course-state.ts';
import type { CourseState } from './course-state.ts';
import { createScreenView } from './screen-view.ts';
import type { ScreenView } from './screen-view.ts';
import { labelsFor, formatLabel } from './labels.ts';
import { element } from './dom.ts';
import { createChrome } from './chrome.ts';
import { createLiveChrome } from './canvas-live.ts';
import type { LiveChrome, LiveOpen } from './canvas-live.ts';
import { createTooltip } from './tooltip.ts';
import type { Tooltip } from './tooltip.ts';
import type { DisplayPrefs } from './display.ts';
import { pageFramesPort } from './frames.ts';
import { isRecord } from './json.ts';
import { blockLayouts, rectOf, round, scrollFrom } from './layout-report.ts';
import { GLIDE } from './screen-objects.ts';
import type { CourseData, ObjectDefinition, ScreenData } from './course-data.ts';
import { PLAYER_PREVIEW_PROTOCOL } from './canvas-protocol.ts';
import type { BlockLayout, CanvasMessage, HostMessage, LayoutMessage, PreviewHostMessage, PreviewPanel, RenderFile, RenderOutline, RenderSheet, RenderView, ScreenRender } from './canvas-protocol.ts';
import type { PlayerItemId } from './course-data.ts';

export interface CanvasApi {
  // A message as the host would post it (no token: the caller is in the page).
  receive(message: HostMessage): void;
  // Where every block is now.
  layout(): LayoutMessage;
  // Messages the canvas sends (also posted to the parent window); returns a function that removes the listener.
  onMessage(listener: (message: CanvasMessage) => void): () => void;
  // Resolves once images, fonts and free objects of the screen are ready (as captures wait).
  ready(timeout?: number): Promise<unknown>;
  readonly screen: string | null;
  // The view (tests): the object host of a block.
  objectHost(blockId: string): unknown;
}

declare global {
  interface Window {
    __elaboraCanvas: CanvasApi;
  }
}

interface Mounted {
  course: CourseData;
  // The course-level fields it was mounted with, as JSON: a change mounts the course again.
  courseKey: string;
  state: { current: CourseState };
  view: ScreenView;
  // The view last asked for.
  requested: RenderView;
  // The live bars (chrome=live).
  live: LiveChrome | null;
  // The course's screens (the render's outline).
  outline: RenderOutline | null;
}

// The canvas is a page its host embeds (the editor's canvas, the « Lecteur » tab's preview): it never
// takes the focus from the host. What a package focuses when it opens something (a panel, a layer,
// the PDF's preview, a revealed step) moves the focus here only when the canvas has it already, the
// author working in it; opened by a render, a push or the host's messages, it opens unfocused (an
// inert dialog is shown without the dialog focusing steps moving anything).
const focusIsHere = () => document.hasFocus();
const focusElement = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function focus(this: HTMLElement, options?: FocusOptions) { if (focusIsHere()) focusElement.call(this, options); };
for (const method of ['show', 'showModal'] as const) {
  const open = HTMLDialogElement.prototype[method];
  HTMLDialogElement.prototype[method] = function (this: HTMLDialogElement) {
    if (focusIsHere()) { open.call(this); return; }
    const inert = this.inert;
    this.inert = true;
    try { open.call(this); } finally { this.inert = inert; }
  };
}

const app = document.getElementById('elabora-app') ?? document.body.appendChild(element('div', { id: 'elabora-app' }));
const token = new URLSearchParams(location.search).get('token');
const chromeOption = new URLSearchParams(location.search).get('chrome');
const chromeMode: 'none' | 'player' | 'live' = chromeOption === 'live' ? 'live' : chromeOption === 'player' ? 'player' : 'none';
// The live bars' one tooltip, and the learner's display choices while the page lives.
const tooltip: Tooltip | null = chromeMode === 'live' ? createTooltip(document.body) : null;
const displayPrefs: DisplayPrefs = { text: 'normal', captions: false, interfaceSounds: true, music: true };
const framesPort = pageFramesPort('url');
const listeners = new Set<(message: CanvasMessage) => void>();
let mounted: Mounted | null = null;
let stylesHash = '';
let sheets: readonly RenderSheet[] = [];
// Files the page uses: the hash each had when the page first used it, and the short hash of those
// changed since. A changed file is asked for again with ?v=<hash> (same path, new content: an image
// replaced, object.js edited), as the URL the browser has cached would give the old content.
const firstHashes = new Map<string, string | null>();
const changedFiles = new Map<string, string>();
let lastId: string | number | null = null;
let applyMs = 0;

function post(message: CanvasMessage) {
  if (window.parent !== window) window.parent.postMessage(message, '*');
  for (const listener of listeners) listener(message);
}

// ── Receiving ─────────────────────────────────────────────────────────
function receive(message: HostMessage) {
  // A wheel passed on: nothing to render; the scroll reports where the blocks went.
  if (message.type === 'elabora/scroll') { scrollFrom(message.by, message.at); return; }
  if (message.type === 'elabora/focus') { focusLive(message.block, message.x, message.y); return; }
  if (message.type === 'elabora/highlight' || message.type === 'elabora/open' || message.type === 'elabora/close') { preview(message); return; }
  const started = performance.now();
  const id = message.id ?? null;
  try {
    if (message.type === 'elabora/render') { endLiveFocus(); render(message.render); }
    else if (mounted) applyView(mounted, { ...mounted.requested, ...message.view }, false);
    // Blocks rendered anew (and layers opened) ask for the changed files with their hash.
    versionUrls();
    lastId = id;
  } catch (error) {
    post({ type: 'elabora/error', id, message: error instanceof Error ? error.message : String(error) });
  }
  applyMs = Math.round((performance.now() - started) * 100) / 100;
  scheduleLayout();
}

window.addEventListener('message', (event) => {
  if (window.parent === window || event.source !== window.parent) return;
  const data: unknown = event.data;
  if (!isRecord(data) || (token && data.token !== token)) return;
  if (data.type === 'elabora/render' && isRender(data.render)) receive({ type: 'elabora/render', id: idOf(data.id), render: data.render });
  else if (data.type === 'elabora/view' && isRecord(data.view)) receive({ type: 'elabora/view', id: idOf(data.id), view: viewOf(data.view) });
  else if (data.type === 'elabora/scroll' && isPoint(data.by)) receive({ type: 'elabora/scroll', by: data.by, ...(isPoint(data.at) ? { at: data.at } : {}) });
  else if (data.type === 'elabora/focus' && typeof data.block === 'string' && typeof data.x === 'number' && typeof data.y === 'number') receive({ type: 'elabora/focus', block: data.block, x: data.x, y: data.y });
  else if (data.type === 'elabora/highlight' || data.type === 'elabora/open' || data.type === 'elabora/close') {
    const message = previewMessage(data);
    if (message) receive(message);
  }
});

// A focal point being dragged (D63): the block's pictures take it as their object-position at once;
// the render that follows the saved change gives the same. Every element of the block that sets its
// own --focus-x and --focus-y (a picture's figure, a band, a statement over an image) takes it, and the
// block itself for those that inherit it.
// A render gives every element its own value again (a block left unchanged keeps its elements).
const liveFocus = new Map<HTMLElement, [string, string]>();
function focusLive(blockId: string, x: number, y: number) {
  const block = document.querySelector<HTMLElement>(`[data-block="${CSS.escape(blockId)}"]`);
  if (!block) { post({ type: 'elabora/error', id: null, message: `elabora/focus: no block "${blockId}" on the screen shown.` }); return; }
  const clamp = (value: number) => String(Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000);
  for (const element of [block, ...block.querySelectorAll<HTMLElement>('[style*="--focus-x"]')]) {
    if (!liveFocus.has(element)) liveFocus.set(element, [element.style.getPropertyValue('--focus-x'), element.style.getPropertyValue('--focus-y')]);
    element.style.setProperty('--focus-x', clamp(x));
    element.style.setProperty('--focus-y', clamp(y));
  }
}
function endLiveFocus() {
  for (const [element, values] of liveFocus) {
    ['--focus-x', '--focus-y'].forEach((name, i) => (values[i] ? element.style.setProperty(name, values[i]) : element.style.removeProperty(name)));
  }
  liveFocus.clear();
}

// ── The player's preview (chrome=live, elabora-player-preview/1) ──────
const PANELS: readonly PreviewPanel[] = ['resources', 'glossary', 'about', 'outline', 'display', 'language', 'transcript'];
const isBar = (value: unknown): value is 'top' | 'bottom' => value === 'top' || value === 'bottom';
// A message of the protocol, checked; another version or a malformed message is said back.
function previewMessage(data: Record<string, unknown>): PreviewHostMessage | null {
  const refused = (message: string) => { post({ type: 'elabora/error', id: null, message }); return null; };
  if (data.protocol !== PLAYER_PREVIEW_PROTOCOL) return refused(`${String(data.type)}: the canvas speaks ${PLAYER_PREVIEW_PROTOCOL}, not ${JSON.stringify(data.protocol ?? null)}.`);
  const protocol = PLAYER_PREVIEW_PROTOCOL;
  if (data.type === 'elabora/close') return { type: 'elabora/close', protocol };
  if (data.type === 'elabora/highlight') {
    if (data.item !== null && typeof data.item !== 'string') return refused('elabora/highlight: item is an item id or null.');
    return { type: 'elabora/highlight', protocol, item: data.item as PlayerItemId | null, ...(isBar(data.bar) ? { bar: data.bar } : {}) };
  }
  if (!PANELS.includes(data.panel as PreviewPanel)) return refused(`elabora/open: panel is one of ${PANELS.join(', ')}.`);
  return { type: 'elabora/open', protocol, panel: data.panel as PreviewPanel, ...(typeof data.resource === 'string' ? { resource: data.resource } : {}), ...(typeof data.term === 'string' ? { term: data.term } : {}) };
}
// What the host asks of the live bars; without them (another page option), nothing.
let highlighted: { item: PlayerItemId | null; bar?: 'top' | 'bottom' } = { item: null };
function preview(message: PreviewHostMessage) {
  if (message.type === 'elabora/highlight') highlighted = { item: message.item, ...(message.bar ? { bar: message.bar } : {}) };
  const live = mounted?.live;
  if (!live) return;
  if (message.type === 'elabora/highlight') live.highlight(message.item, message.bar);
  else if (message.type === 'elabora/close') live.close();
  else if (!live.open(message.panel, { resource: message.resource, term: message.term })) post({ type: 'elabora/error', id: null, message: `elabora/open: the course has nothing to show in ${message.panel}.` });
  scheduleLayout();
}

const idOf = (value: unknown): string | number | undefined => (typeof value === 'string' || typeof value === 'number' ? value : undefined);
const isPoint = (value: unknown): value is { x: number; y: number } => isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
function isRender(value: unknown): value is ScreenRender {
  return isRecord(value) && typeof value.screen === 'string' && isRecord(value.course) && Array.isArray(value.course.screens) && isRecord(value.view);
}
function viewOf(value: Record<string, unknown>): Partial<RenderView> {
  const view: Partial<RenderView> = {};
  if (value.state === 'initial' || value.state === 'answered') view.state = value.state;
  if (value.step === null || typeof value.step === 'number') view.step = value.step;
  if (value.layer === null || typeof value.layer === 'string') view.layer = value.layer;
  // A moment of the timeline (the playhead, posted on each move while the author drags it).
  if (value.at === null) view.at = null;
  else if (isRecord(value.at) && typeof value.at.time === 'number' && Number.isFinite(value.at.time)) view.at = { time: Math.max(0, value.at.time) };
  else if (isRecord(value.at) && typeof value.at.line === 'string') view.at = { line: value.at.line, ...(value.at.edge === 'end' ? { edge: 'end' as const } : {}) };
  if (typeof value.ghost === 'boolean') view.ghost = value.ghost;
  if (value.dialogue === null) view.dialogue = null;
  else if (isRecord(value.dialogue) && typeof value.dialogue.block === 'string') {
    const choices = Array.isArray(value.dialogue.choices) ? value.dialogue.choices.filter((choice): choice is string => typeof choice === 'string') : [];
    view.dialogue = { block: value.dialogue.block, choices, ...(typeof value.dialogue.node === 'string' ? { node: value.dialogue.node } : {}) };
  }
  return view;
}

// ── Rendering ─────────────────────────────────────────────────────────
function render(data: ScreenRender) {
  const changed = noteFiles(data.files || []);
  if ((data.styles && data.styles.hash !== stylesHash) || [...changed].some((path) => sheets.some((sheet) => sheet.css.includes(`url("${path}`)))) {
    if (data.styles) { sheets = data.styles.sheets; stylesHash = data.styles.hash; }
    syncSheets(sheets);
    forgetThemeKeyframes();
  }
  const screen = data.course.screens.find((candidate) => candidate.id === data.screen);
  if (!screen) throw new Error(`The render data has no screen "${data.screen}".`);
  const current = mounted;
  if (!current || current.courseKey !== courseKey(data.course) || objectsChanged(current.course.objects, data.course.objects)) { mount(data, screen); return; }
  // Screens added, moved or renamed: the live bars' outline, Previous and Next follow.
  if (current.live && JSON.stringify(current.outline) !== JSON.stringify(data.outline ?? null)) { current.outline = data.outline ?? null; current.live.setOutline(current.outline); }
  const course = current.course;
  const sameScreen = current.view.screen?.id === screen.id;
  // Another screen: the layers of the one shown close without running its events.
  if (!sameScreen) current.view.closeLayers();
  const open = current.view.layers;
  course.screens = [screen];
  course.sections = data.course.sections;
  course.objects = data.course.objects;
  // The learner state of the canvas carries over to the same screen (answers given in the canvas,
  // controls visited, variables); another screen starts afresh.
  current.state.current = createCourseState(course, sameScreen ? { suspendData: current.state.current.encode() } : {});
  const fresh = current.view.update(screen, usingFiles(screen, changed));
  if (!sameScreen) { applyView(current, data.view, true); current.live?.show(screen.id); return; }
  // The same view goes on: new steps show when every step is shown, blocks rendered anew show their
  // answers, layers closed because their own data changed open again. Then what the view changes.
  const before = current.requested;
  // Every step shown again: the timeline goes back where the view puts it (reveal waits at the start
  // of the last step, which would hide what is timed after it).
  if (data.view.step === null && before.step === null) { current.view.reveal(current.view.lastStep()); showMoment(current, screenView(current, data.view)); }
  if (data.view.state === 'answered' && before.state === 'answered') current.view.showAnswered(fresh.filter((node) => !node.closest('dialog')));
  for (const layer of open) if (!current.view.layers.includes(layer)) current.view.openLayer(layer);
  applyView(current, data.view, false, before);
  // A layer opened again (its data changed) shows the moment of its timeline again.
  if (timedLayer(current, data.view) && !open.includes(data.view.layer ?? '')) showLayerMoment(current, data.view);
  current.live?.update();
}

// A course mounted afresh: course-level data changed (language, labels, presentation, tokens,
// backdrop, an object's definition…), or the first render.
function mount(data: ScreenRender, screen: ScreenData) {
  const scroll = { x: scrollX, y: scrollY };
  // What the live bars had open opens again in the new ones (the course's fields changed).
  const reopen: LiveOpen | null = mounted?.live?.opened() ?? null;
  mounted?.live?.dispose();
  mounted?.view.destroy();
  app.replaceChildren();
  const course: CourseData = { ...data.course, screens: [screen] };
  app.dataset.presentation = course.presentation?.mode || 'scroll';
  document.documentElement.lang = course.language;
  document.title = course.title;
  const labels = labelsFor(course.language, course.ui, course.presentation?.mode);
  const main = element('main', { id: 't-main', class: 't-main', tabindex: '-1' });
  const liveRegion = element('div', { class: 't-sr-only', 'aria-live': 'polite', role: 'status' });
  // The bar of a narrated screen goes where the player puts it: its controls item (with the bars only).
  let timelineHost: HTMLElement | null = null;
  let live: LiveChrome | null = null;
  const outline = data.outline ?? null;
  if (chromeMode === 'live' && tooltip) {
    // As the player wires them; what leaves the screen is the host's (navigate, language).
    live = createLiveChrome({
      app, course, labels, tooltip, outline, display: displayPrefs, post,
      format: (label, values) => formatLabel(label, values, course.language),
      announce: (message) => { liveRegion.textContent = ''; setTimeout(() => { liveRegion.textContent = message; }, 30); },
      steps: () => {
        const view = mounted?.view;
        const more = !!view && course.presentation?.mode === 'slides' && !view.timeline && view.revealed < view.lastStep() && view.opensWithContinue(view.nextStep());
        return { more, reveal: () => { if (view && more) view.revealStep(view.nextStep()); } };
      },
      transcript: (open) => mounted?.view.timeline?.transcript(open)
    });
    app.append(...[live.top, main, live.bottom, liveRegion].filter((node) => node !== null));
    timelineHost = live.controls;
  } else if (chromeMode === 'player') {
    // As the player shows them on a screen in the middle of the course, doing nothing.
    const bars = createChrome(course, labels, { actions: null, tooltip: null });
    for (const bar of [bars.top, bars.bottom]) if (bar) bar.inert = true;
    bars.setNav({ previous: true, next: true, nextLabel: 'next' });
    if (screen) bars.setScreen(screen.title);
    app.append(...[bars.top, main, bars.bottom, liveRegion].filter((node) => node !== null));
    timelineHost = bars.controls;
  } else app.append(main, liveRegion);
  const state = { current: createCourseState(course) };
  // Behaviours and the view keep this proxy: render data gives the canvas a new course state, and
  // the nodes kept from the previous data use it too.
  const courseState = new Proxy(state.current, { get: (_target, key) => Reflect.get(state.current, key) });
  const view = createScreenView({
    app, main, course, courseState, labels, formatLabel: (label, values) => formatLabel(label, values, course.language),
    announce: (message) => { liveRegion.textContent = ''; setTimeout(() => { liveRegion.textContent = message; }, 30); },
    // Nothing is recorded or saved: the canvas is not a learner session.
    recordInteraction: () => {}, syncSoon: () => {}, still: true,
    afterEvents: () => scheduleLayout(), afterReveal: () => scheduleLayout(),
    // next and previous are the screens around the one the event is on, in the outline the canvas
    // has now (the view outlives renders of other screens, and the outline changes with the course).
    navigate: (target, from) => post({ type: 'elabora/navigate', screen: around(mounted?.outline ?? null, from.id, target) }),
    exit: () => {}, framesPort,
    retake: () => { const target = state.current.retake(); if (target) post({ type: 'elabora/navigate', screen: target }); },
    // A narrated screen's timeline, still: the canvas shows a time (view.at), it never plays.
    timeline: {
      host: timelineHost, autoplay: false, virtual: live !== null && window.ELABORA_TEST?.virtualTime === true,
      prefs: { captions: false, muted: false, volume: 1, rate: 1, stopAtSteps: false, keep: false, chosen: {}, key: '' }, ...controlsOf(course),
      // The live bars' controls play, with their tooltip and the transcript's panel.
      ...(live ? { tooltip, sheetHost: app } : {})
    }
  });
  mounted = { course, courseKey: courseKey(course), state, view, requested: data.view, live, outline };
  view.show(screen);
  applyView(mounted, data.view, true);
  if (live) {
    live.show(screen.id);
    if (highlighted.item) live.highlight(highlighted.item, highlighted.bar);
    if (reopen?.panel) live.open(reopen.panel, reopen.resource ? { resource: reopen.resource } : {});
  }
  scrollTo(scroll.x, scroll.y);
}

// The screen an event's next or previous names, from the outline (else as the event says it).
function around(outline: RenderOutline | null, from: string, target: string): string {
  if (target !== 'next' && target !== 'previous') return target;
  const order = outline?.sections.flatMap((section) => section.screens.map((entry) => entry.id)) ?? [];
  const index = order.indexOf(from);
  return index < 0 ? target : order[index + (target === 'next' ? 1 : -1)] ?? target;
}

// What the course's controls item shows of a narrated screen's bar (D58).
function controlsOf(course: CourseData): { controls?: { seekBar: boolean; volume: boolean; transcript: boolean; speeds: number[] } } {
  const item = [...(course.player?.top?.items ?? []), ...(course.player?.bottom?.items ?? [])].find((entry) => entry.id === 'controls');
  return item?.id === 'controls' ? { controls: { seekBar: item.seekBar, volume: item.volume, transcript: item.transcript, speeds: item.speeds } } : {};
}

// Shows the view asked for, as captures do: the step, the answered state, then the layer.
// full: the screen was just shown; otherwise from the view shown before.
function applyView(current: Mounted, view: RenderView, full: boolean, before: RenderView = current.requested) {
  current.requested = view;
  if (!full && before.state === 'answered' && view.state === 'initial') {
    // Back to the initial state: the screen afresh, with a new learner state.
    const screen = current.view.screen;
    if (!screen) return;
    current.state.current = createCourseState(current.course);
    current.view.closeLayers();
    current.view.leave();
    current.view.show(screen);
    applyView(current, view, true);
    return;
  }
  const moved = JSON.stringify(view.at ?? null) !== JSON.stringify(before.at ?? null);
  if (full || view.step !== before.step || moved) {
    current.view.reveal(view.step ?? current.view.lastStep());
    showMoment(current, screenView(current, view));
  }
  if (view.state === 'answered' && (full || before.state !== 'answered')) current.view.showAnswered();
  if (full || !!view.ghost !== !!before.ghost || view.step !== before.step) applyGhost(current, !!view.ghost);
  if (full || view.layer !== before.layer) {
    current.view.closeLayers(view.layer);
    if (view.layer && !current.view.layers.includes(view.layer)) current.view.openLayer(view.layer);
  }
  if (timedLayer(current, view) && (full || view.layer !== before.layer || moved)) showLayerMoment(current, view);
  if (full || JSON.stringify(view.dialogue ?? null) !== JSON.stringify(before.dialogue ?? null)) showDialogue(current, view, full ? null : before);
}

// A dialogue after the choices of the view (D61), at rest; the one shown before back at its start.
function showDialogue(current: Mounted, view: RenderView, before: RenderView | null) {
  const dialogues = current.view.dialogues;
  if (!dialogues) return;
  if (before?.dialogue && before.dialogue.block !== view.dialogue?.block) dialogues.showPath(before.dialogue.block, []);
  if (view.dialogue) dialogues.showPath(view.dialogue.block, view.dialogue.choices ?? [], view.dialogue.node);
}

// The layer shown has a timeline of its own (D62): the moment of the view is on it, and the screen
// under it shows its end (or its step).
function timedLayer(current: Mounted, view: RenderView): boolean {
  return !!view.layer && !!current.view.screen?.layers.find((layer) => layer.id === view.layer)?.narration;
}
const screenView = (current: Mounted, view: RenderView): RenderView => (timedLayer(current, view) ? { ...view, at: null } : view);

// An open layer at a time or a line of its timeline; without one, at its end (as captures show it).
// Its captions show where the screen's do: with the player's bars around the slide. The editor's
// canvas without them (Diapositive) shows the slide uncovered, the layer's as the screen's.
function showLayerMoment(current: Mounted, view: RenderView) {
  const layer = view.layer;
  const timeline = layer ? current.view.layerTimeline(layer) : null;
  if (!layer || !timeline) return;
  const captions = chromeMode !== 'none';
  if (view.at && 'time' in view.at) current.view.showLayerTime(layer, view.at.time, { captions });
  else if (view.at) current.view.showLayerLine(layer, view.at.line, { edge: view.at.edge, captions });
  else current.view.showLayerTime(layer, timeline.duration, { captions: false });
}

// A narrated screen at the end shows every step; at a line, as it is when the line is said; at a time
// (the editor's playhead), as it is then, effects included.
function showMoment(current: Mounted, view: RenderView) {
  if (view.at && 'time' in view.at) current.view.showTime(view.at.time);
  else if (view.at) current.view.showLine(view.at.line, { edge: view.at.edge });
  else if (view.step === null && current.view.timeline) current.view.timeline.showAt(current.view.timeline.duration);
}

// The steps after the first, faded in their place (the editor's phone width shows every step).
function applyGhost(current: Mounted, ghost: boolean) {
  const screen = current.view.screen;
  const first = current.view.steps[0] ?? 1;
  for (const block of screen?.blocks ?? []) {
    const node = document.querySelector<HTMLElement>(`#t-main [data-block="${CSS.escape(block.id)}"]`);
    node?.toggleAttribute('data-t-ghost', ghost && (block.step || 1) > first);
  }
}

function courseKey(course: CourseData): string {
  const { screens, sections, objects, build, ...rest } = course;
  return JSON.stringify(rest);
}
// A definition that changed (a manifest edited) restarts the objects using it.
function objectsChanged(before: Readonly<Record<string, ObjectDefinition>>, after: Readonly<Record<string, ObjectDefinition>>): boolean {
  return Object.keys(after).some((id) => before[id] && JSON.stringify(before[id]) !== JSON.stringify(after[id]));
}

// ── Files changed at the same path ────────────────────────────────────
const shortHash = (hash: string | null) => (hash ?? '').replace(/^sha256:/, '').slice(0, 12);
// The paths whose hash changed since the page first used them.
function noteFiles(files: readonly RenderFile[]): Set<string> {
  const changed = new Set<string>();
  for (const file of files) {
    if (!firstHashes.has(file.path)) { firstHashes.set(file.path, file.hash); continue; }
    const now = changedFiles.get(file.path) ?? shortHash(firstHashes.get(file.path) ?? null);
    if (file.hash && shortHash(file.hash) !== now) { changedFiles.set(file.path, shortHash(file.hash)); changed.add(file.path); }
  }
  return changed;
}
// Blocks that use a changed file: they are rendered again (a video takes its new source, a free
// object restarts with its new code or assets).
function usingFiles(screen: ScreenData, changed: ReadonlySet<string>): Set<string> {
  const blocks = new Set<string>();
  if (!changed.size) return blocks;
  for (const block of [...flatBlocks(screen.blocks), ...screen.layers.flatMap((layer) => flatBlocks(layer.blocks))]) {
    const own = JSON.stringify({ ...block, blocks: undefined });
    const object = hasBehavior(block, 'object') ? `objects/${block.props.object}/` : null;
    if ([...changed].some((path) => (object && path.startsWith(object)) || own.includes(`"${path}`))) blocks.add(block.id);
  }
  return blocks;
}
// URLs of changed files, in the page: asked for with their hash.
const versioned = (url: string) => { const path = url.split(/[?#]/)[0]; const hash = changedFiles.get(path); return hash ? `${path}?v=${hash}${url.includes('#') ? url.slice(url.indexOf('#')) : ''}` : url; };
function versionUrls() {
  if (!changedFiles.size) return;
  for (const node of document.querySelectorAll('#t-main [src], #t-main [poster], #t-main [href], dialog.t-layer [src], dialog.t-layer [poster], dialog.t-layer [href], .t-backdrop [src]')) {
    for (const name of ['src', 'poster', 'href']) {
      const value = node.getAttribute(name);
      if (!value) continue;
      const next = versioned(value);
      if (next === value) continue;
      node.setAttribute(name, next);
    }
  }
}
const versionedCss = (css: string) => (changedFiles.size ? css.replace(/url\("([^"?#]+)/g, (match: string, path: string) => (changedFiles.has(path) ? `url("${versioned(path)}` : match)) : css);

// One style element per sheet, after elabora/player.css, in order; unchanged sheets are not touched
// (the browser parses again only what changed).
function syncSheets(sheets: readonly RenderSheet[]) {
  const existing = new Map([...document.querySelectorAll<HTMLStyleElement>('style[data-elabora-sheet]')].map((node) => [node.dataset.elaboraSheet ?? '', node]));
  let anchor: Element | null = document.querySelector('link[rel="stylesheet"][href$="player.css"]');
  for (const sheet of sheets) {
    let node = existing.get(sheet.id);
    existing.delete(sheet.id);
    if (!node) { node = document.createElement('style'); node.dataset.elaboraSheet = sheet.id; }
    const css = versionedCss(sheet.css);
    if (node.textContent !== css) node.textContent = css;
    if (!anchor) document.head.append(node);
    else if (anchor.nextElementSibling !== node) anchor.after(node);
    anchor = node;
  }
  for (const node of existing.values()) node.remove();
}

// ── Layout ────────────────────────────────────────────────────────────
function timedOf(id: string): { timed?: NonNullable<BlockLayout['timed']> } {
  const view = mounted?.view;
  // A block of an open layer follows its layer's timeline (D62).
  const timed = view?.timed?.has(id) ? view.timed : view?.layerTimelines.map((layer) => view.layerTimed(layer)).find((candidate) => candidate?.has(id)) ?? null;
  if (!timed?.has(id)) return {};
  const state = timed.state(id);
  const progress = timed.progress(id);
  return { timed: { state, ...(progress !== null ? { progress } : {}) } };
}

function layout(): LayoutMessage {
  const view = mounted?.view;
  const blocks = blockLayouts(timedOf);
  const article = document.querySelector('#t-main > article.t-screen');
  return {
    type: 'elabora/layout', id: lastId, screen: view?.screen?.id ?? null,
    step: view?.revealed ?? 1, steps: [...(view?.steps ?? [])], layer: view?.layers[0] ?? null, state: mounted?.requested.state ?? 'initial', applyMs,
    viewport: { width: innerWidth, height: innerHeight, scrollX: round(scrollX), scrollY: round(scrollY) },
    screenRect: article ? rectOf(article) : null, blocks
  };
}

// Reported once per frame at most, when something moved.
let layoutQueued = false;
let lastLayout = '';
function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    // Blocks an event of the screen rendered (a layer opened by a click) too.
    versionUrls();
    observeBlocks();
    landing();
    const message = layout();
    const key = JSON.stringify({ ...message, applyMs: 0 });
    if (key === lastLayout) return;
    lastLayout = key;
    post(message);
  });
}
// A block gliding from where its counterpart was (D65) is measured on its way: once more where it lands.
const gliding = new Set<Animation>();
function landing() {
  for (const animation of document.getAnimations?.() ?? []) {
    if (animation.id !== GLIDE || gliding.has(animation)) continue;
    gliding.add(animation);
    animation.finished.catch(() => {}).finally(() => { gliding.delete(animation); scheduleLayout(); });
  }
}
// Blocks are watched as they come and go: a block that grows moves the others.
const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleLayout()) : null;
const watched = new Set<Element>();
function observeBlocks() {
  if (!resizes) return;
  for (const node of watched) if (!node.isConnected) { resizes.unobserve(node); watched.delete(node); }
  for (const node of [document.documentElement, ...document.querySelectorAll('#t-main, #t-main .t-block[data-block], dialog.t-layer .t-block[data-block]')]) {
    if (!watched.has(node)) { resizes.observe(node); watched.add(node); }
  }
}
new MutationObserver(() => scheduleLayout()).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-t-pending', 'data-t-concealed', 'open', 'hidden'] });
addEventListener('scroll', scheduleLayout, { capture: true, passive: true });
addEventListener('resize', scheduleLayout);

window.__elaboraCanvas = {
  receive,
  layout,
  onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  ready: (timeout) => mounted?.view.ready(timeout) ?? Promise.resolve(null),
  get screen() { return mounted?.view.screen?.id ?? null; },
  objectHost: (blockId) => mounted?.view.objectHost(blockId)
};
post({ type: 'elabora/ready', chrome: chromeMode, ...(chromeMode === 'live' ? { protocol: PLAYER_PREVIEW_PROTOCOL } : {}) });
