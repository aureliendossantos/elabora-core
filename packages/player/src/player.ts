// Elabora player: renders a compiled course (window.ELABORA_COURSE) and reports to the LMS.
// Session end without `unload` (Chrome and Edge stopped firing it on 22 Sept 2026):
//   - commit early and idempotently after every significant change;
//   - last save on visibilitychange:hidden, then pagehide (finish only if the page is really going away);
//   - a visible Quit button that commits and calls LMSFinish;
//   - never LMSInitialize again after LMSFinish (bfcache restore).

import { findScorm12API, createScorm12Adapter, createStandaloneAdapter, scorm12Duration, pad } from './scorm12.ts';
import { createWebAdapter } from './web.ts';
import type { Interaction, LmsAdapter } from './scorm12.ts';
import { createCourseState, hasBehavior } from './course-state.ts';
import { createScreenView } from './screen-view.ts';
import { labelsFor, formatLabel } from './labels.ts';
import { element } from './dom.ts';
import { icon } from './icons.ts';
import { createChrome, languageName } from './chrome.ts';
import type { Chrome, SheetName } from './chrome.ts';
import { createTooltip } from './tooltip.ts';
import type { Sheet } from './sheet.ts';
import { createResources } from './resources.ts';
import { createGlossary } from './glossary.ts';
import { createAbout } from './about.ts';
import { pageFramesPort } from './frames.ts';
import { loadTimelinePrefs } from './timeline.ts';
import { alignToButton, applyDisplay, createDisplayMenu, createLanguageMenu, loadDisplayPrefs, saveDisplayPrefs } from './display.ts';
import type { Popover } from './display.ts';
import type { CourseData, ScreenData } from './course-data.ts';

declare global {
  interface Window {
    // The compiled course (elabora/course.js).
    ELABORA_COURSE: CourseData;
    // The course in the package's other languages, by language (elabora/course.<lang>.js, loaded
    // when the learner chooses one, D59).
    ELABORA_COURSES?: Record<string, CourseData>;
    // Debug and test hooks (the LMS emulator, previews, captures and tests use them).
    __elabora: DebugHooks;
    // Set by tests before the player starts: narrated screens run on a virtual clock that only
    // moves when told (__elabora.timeline.advance), as free objects do (D6).
    ELABORA_TEST?: { virtualTime?: boolean };
  }
}

// The course in the language shown: its own (course.js), or another of the package's (D59). What the
// LMS connection reads of it (its id, its tracking, its delivery) is read once, from the course's own.
const initial = window.ELABORA_COURSE;
let course = initial;
// What the browser keeps for the learner (progress on the web, display and narration choices) goes
// under the course's own id: a translation has an id of its own (<id>-<lang>), and a learner who
// switches language keeps what they chose.
const packageId = initial.id;
let labels = labelsFor(course.language, course.ui, course.presentation?.mode);
const format = (label: string, values: Readonly<Record<string, unknown>>) => formatLabel(label, values, course.language);
const app = document.getElementById('elabora-app') as HTMLElement; // index.html has it

// ── LMS connection ────────────────────────────────────────────────────
// A module built for the web never looks for an LMS: its progress stays in the browser or nowhere
// (web.ts, D41). A SCORM package uses the LMS it finds, else keeps a preview's data in the tab.
const delivery = course.delivery;
// A module for the web that keeps its progress in the browser says so, and lets the learner clear it.
const keptHere = delivery?.progress === 'local';
const found = delivery ? null : findScorm12API(window);
const lms: LmsAdapter = delivery ? createWebAdapter(packageId, { progress: delivery.progress }) : found ? createScorm12Adapter(found) : createStandaloneAdapter(packageId);
const startedAt = Date.now();
lms.initialize();
const suspendData = lms.get('cmi.suspend_data');
const savedLocation = lms.get('cmi.core.lesson_location');
const initialStatus = lms.get('cmi.core.lesson_status') || 'not attempted';
let courseState = createCourseState(course, { suspendData, initialStatus, onChange: () => syncSoon() });
if (initialStatus === 'not attempted' || initialStatus === 'browsed' || initialStatus === '') {
  lms.set('cmi.core.lesson_status', 'incomplete');
  courseState.commitStatus('incomplete');
}
// Suspend from the start: if the window is closed abruptly, the LMS keeps the resume data.
lms.set('cmi.core.exit', 'suspend');
let interactionCount = Number(lms.get('cmi.interactions._count')) || 0;

let syncTimer = 0;
function syncSoon() {
  if (syncTimer) return;
  syncTimer = setTimeout(() => { syncTimer = 0; syncNow(); }, 0);
}
function syncNow() {
  if (lms.phase !== 'initialized') return;
  clearTimeout(syncTimer);
  syncTimer = 0;
  lms.set('cmi.suspend_data', courseState.encode());
  const screen = currentScreen();
  // The screen's permanent key (elabora.lock.json): a renamed screen keeps it, so learners resume there.
  if (screen) lms.set('cmi.core.lesson_location', screen.key);
  const { status, score } = courseState.nextLmsStatus();
  if (score.decided && score.raw !== null) {
    lms.set('cmi.core.score.min', '0');
    lms.set('cmi.core.score.max', '100');
    lms.set('cmi.core.score.raw', String(score.raw));
  }
  if (status !== courseState.lmsStatus) {
    if (lms.set('cmi.core.lesson_status', status)) courseState.commitStatus(status);
  }
  lms.set('cmi.core.exit', exitValue());
  lms.set('cmi.core.session_time', scorm12Duration(Date.now() - startedAt));
  lms.commit();
  // (Not before the bars and the screen are mounted: a language loading at the start.)
  if (view) { updateProgress(); view.refreshResults(); }
}
function exitValue() {
  const done = courseState.lmsStatus === 'completed' || courseState.lmsStatus === 'passed';
  return done && course.tracking.exitAfterCompletion === 'normal' ? '' : 'suspend';
}

function nowTime() {
  const now = new Date();
  return `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}`;
}
// SCORM 1.2 interactions are a write-only journal, appended at the next free index.
function recordInteraction({ id, type, objective, response, correctPattern, result, weight }: Interaction) {
  if (!course.tracking.recordInteractions || lms.phase !== 'initialized') return;
  const index = interactionCount++;
  const prefix = `cmi.interactions.${index}`;
  lms.setAlways(`${prefix}.id`, id.slice(0, 255));
  if (objective) lms.setAlways(`${prefix}.objectives.0.id`, objective);
  lms.setAlways(`${prefix}.time`, nowTime());
  lms.setAlways(`${prefix}.type`, type);
  if (correctPattern) lms.setAlways(`${prefix}.correct_responses.0.pattern`, correctPattern);
  if (weight) lms.setAlways(`${prefix}.weighting`, String(weight));
  lms.setAlways(`${prefix}.student_response`, String(response).slice(0, 255));
  lms.setAlways(`${prefix}.result`, result);
}

// ── Session end ───────────────────────────────────────────────────────
let ended = false;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') syncNow();
});
window.addEventListener('pagehide', (event) => {
  if (lms.phase !== 'initialized') return;
  syncNow();
  if (!event.persisted) lms.finish();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && lms.phase === 'finished') showEnded(labels.sessionRestored);
});
if (course.tracking.heartbeatSeconds > 0) {
  setInterval(() => { if (document.visibilityState === 'visible' && lms.phase === 'initialized') syncNow(); }, course.tracking.heartbeatSeconds * 1000);
}

function quit() {
  if (lms.phase !== 'initialized') return;
  syncNow();
  lms.finish();
  // On the web there is no platform to go back to, and with progress none nothing was kept.
  showEnded(delivery ? (delivery.progress === 'none' ? labels.webEndedNotKept : labels.webEndedKept) : labels.sessionEnded);
}

// Says a message in the live region (emptied first, so the same message is said again).
const announce = (message: string) => { liveRegion.textContent = ''; setTimeout(() => { liveRegion.textContent = message; }, 30); };

// ── The bars ──────────────────────────────────────────────────────────
// The two bars of course.player (D58), the one tooltip, and the side panels: Resources, Glossary,
// « IA et crédits » (the transcript is the narrated screen's own). They are mounted for the course
// in the language shown, and mounted again when the learner chooses another (D59).
const tooltip = createTooltip(document.body);
const liveRegion = element('div', { class: 't-sr-only', 'aria-live': 'polite', role: 'status' });
const keep = delivery?.progress !== 'none';
const displayPrefs = loadDisplayPrefs(packageId, keep);
let chrome!: Chrome;
let menu: HTMLElement | null = null;
let main!: HTMLElement;
let sheets: Partial<Record<SheetName, { sheet: Sheet; dispose(): void }>> = {};
let unbindTerms = () => {};
let bottomAtEnd = false;
let controlsStrip: HTMLElement | null = null;
let barsObserver: ResizeObserver | null = null;
let popovers: Popover[] = [];
const sheetToggled = (name: SheetName) => (open: boolean) => chrome.sheetButtons.get(name)?.setAttribute('aria-expanded', String(open));
// The panels and the outline go between the bars that stay in the window: their heights, measured.
const measureBars = () => {
  const height = (bar: HTMLElement | null) => (bar && !bar.hidden && bar.dataset.position !== 'page' ? bar.offsetHeight : 0);
  app.style.setProperty('--t-bar-top', `${height(chrome.top)}px`);
  app.style.setProperty('--t-bar-bottom', `${height(chrome.bottom) || (controlsStrip?.offsetHeight ?? 0)}px`);
};

function mountBars() {
  labels = labelsFor(course.language, course.ui, course.presentation?.mode);
  chrome = createChrome(course, labels, {
    tooltip,
    actions: {
      previous: () => onPrevious(), next: () => onNext(), quit: () => confirmQuit(), outline: () => toggleMenu(),
      sheet: (name, button) => sheets[name]?.sheet.toggle(button),
      language: () => languageMenu?.toggle(),
      display: () => displayMenu?.toggle()
    }
  });
  menu = chrome.menu;
  main = element('main', { id: 't-main', class: 't-main', tabindex: '-1' });
  const banner = lms.kind === 'standalone' ? element('p', { class: 't-banner', role: 'note', text: labels.standalone }) : null;
  // A bottom bar at the end of the page (position page, scroll presentation): the controls of a
  // narrated screen stay in the window, in a strip of their own.
  bottomAtEnd = course.player.bottom?.position === 'page';
  controlsStrip = bottomAtEnd && chrome.controls && chrome.bottom?.contains(chrome.controls) ? element('div', { class: 't-bar t-bar--controls', 'data-bar': 'controls' }, chrome.controls) : null;
  app.replaceChildren(...[element('a', { class: 't-skip', href: '#t-main', text: labels.skip }), chrome.top, banner, main, controlsStrip, chrome.bottom, liveRegion].filter((node) => node !== null));
  // The panels go into the app once it holds the bars (replaceChildren would take them out).
  sheets = {
    ...(course.resources?.length ? { resources: createResources({ resources: course.resources, labels, language: course.language, format, host: app, tooltip, onToggle: sheetToggled('resources'), onModal: (open) => { if (open) view.timeline?.hold('viewer'); else view.timeline?.release('viewer'); } }) } : {}),
    ...(course.about ? { about: createAbout({ about: course.about, labels, language: course.language, host: app, tooltip, onToggle: sheetToggled('about') }) } : {})
  };
  // The glossary opens from its button and from the terms the screens link to it. Terms are linked
  // from screens and from layers, which open over the page (document.body).
  const glossary = course.glossary?.length ? createGlossary({ entries: course.glossary, labels, language: course.language, format, host: app, tooltip, onToggle: sheetToggled('glossary') }) : null;
  if (glossary) { sheets.glossary = glossary; unbindTerms = glossary.bindTerms(document.body); }
  app.dataset.presentation = course.presentation?.mode || 'scroll';
  if (course.tokens['player.density'] === 'compact') app.dataset.density = 'compact'; else delete app.dataset.density;
  document.documentElement.lang = course.language;
  document.title = course.title;
  // « Affichage » and « Langue »: their menus.
  const narrated = [...(course.player.top?.items ?? []), ...(course.player.bottom?.items ?? [])].some((item) => item.id === 'controls');
  displayMenu = chrome.displayButton ? createDisplayMenu(chrome.displayButton, { labels, prefs: displayPrefs, narrated, onChange: (prefs) => { applyDisplay(app, prefs); saveDisplayPrefs(packageId, keep, prefs); } }) : null;
  languageMenu = chrome.languageButton && course.languages ? createLanguageMenu(chrome.languageButton, { labels, languages: course.languages, current: course.language, name: languageName, choose: (code) => { void switchLanguage(code); } }) : null;
  popovers = [displayMenu, languageMenu].filter((popover): popover is Popover => popover !== null);
  applyDisplay(app, displayPrefs);
  barsObserver?.disconnect();
  barsObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(measureBars) : null;
  for (const bar of [chrome.top, chrome.bottom, controlsStrip]) if (bar) barsObserver?.observe(bar);
  measureBars();
}
let displayMenu: Popover | null = null;
let languageMenu: Popover | null = null;

// What the bars and the screen hold, let go before they are mounted again in another language.
function unmount() {
  view.leave();
  view.destroy();
  toggleMenu(false);
  for (const popover of popovers) popover.dispose();
  for (const entry of Object.values(sheets)) entry?.dispose();
  unbindTerms();
  unbindTerms = () => {};
  tooltip.hide();
  barsObserver?.disconnect();
}

function confirmQuit() {
  const dialog: HTMLDialogElement = element('dialog', { class: 't-dialog', 'aria-labelledby': 'quit-title' },
    element('p', { id: 'quit-title', class: 't-dialog-title', text: labels.quitConfirm }),
    element('div', { class: 't-dialog-actions' },
      element('button', { class: 't-btn t-btn--secondary', type: 'button', onclick: () => dialog.close() }, labels.close),
      element('button', { class: 't-btn t-btn--primary t-quit-confirm', type: 'button', onclick: () => { dialog.close(); quit(); } }, labels.quit)));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function showEnded(message: string) {
  ended = true;
  view.dispose();
  toggleMenu(false);
  for (const entry of Object.values(sheets)) entry?.sheet.close({ refocus: false });
  const title = element('h1', { tabindex: '-1', text: course.title });
  main.replaceChildren(element('div', { class: 't-ended' }, title, element('p', { text: message }), ...(keptHere && message === labels.webEndedKept ? [progressNote()] : [])));
  app.dataset.ended = '';
  title.focus();
}

// ── Navigation ────────────────────────────────────────────────────────
// Index of the screen shown (-1 before the first one).
let current = -1;
const currentScreen = (): ScreenData | undefined => courseState.screens[current];
const requiredScreens = () => courseState.screens.filter((screen) => screen.required !== false);
const screenNumber = (id: string | undefined) => (id === undefined ? undefined : courseState.screenIndex.get(id));

function reachable(index: number) {
  if (course.navigation.mode === 'free') return true;
  const screen: ScreenData | undefined = courseState.screens[index];
  if (!screen) return false;
  if (courseState.isVisited(screen) || index === 0) return true;
  const previous = courseState.screens[index - 1];
  return courseState.isVisited(previous) && (!course.navigation.lockUntilComplete || courseState.screenComplete(previous));
}

// A Previous or Next that cannot go says why in the tooltip, next to it (nothing moves), and in
// the live region.
function refuse(button: HTMLElement | null, reason: string) {
  announce(reason);
  if (button) tooltip.flash(button, reason);
}
function onPrevious() {
  if (current <= 0) { refuse(chrome.previousButton, labels.firstScreen); return; }
  go(current - 1);
}
function onNext() {
  if (nextLocked()) { refuse(chrome.nextButton, lockReason()); return; }
  if (nextReveals()) view.revealStep(view.nextStep());
  else if (current >= courseState.screens.length - 1) refuse(chrome.nextButton, labels.lastScreen);
  else go(current + 1);
}
// In slides, Next reads Continue and reveals the next step, unless the screen leaves it to its own
// triggers (reveal-step) or the step opens once answered. In scroll presentation the page has its
// own Continue buttons, and Next goes to the next page.
const slides = () => app.dataset.presentation === 'slides';
// A narrated screen has its own Continue in the screen: Next goes to the next screen.
const nextReveals = () => slides() && !view.timeline && view.revealed < view.lastStep() && view.opensWithContinue(view.nextStep());
// Locked: activities of the revealed steps (or of the whole screen on its last step) not done yet;
// steps that Next does not reveal, not all shown yet.
function nextLocked() {
  const screen = currentScreen();
  if (!course.navigation.lockUntilComplete || !screen) return false;
  if (view.revealed < view.lastStep()) return !nextReveals() || view.listening() || !courseState.activitiesOf({ blocks: screen.blocks.filter((block) => (block.step || 1) <= view.revealed) }).every(courseState.activityDone);
  return !courseState.screenComplete(screen);
}
// A narrated step not heard to its end, or a narrated screen whose end is not reached yet: listen.
function lockReason() {
  const screen = currentScreen();
  if (view.listening()) return labels.listen;
  if (screen && view.timeline && (screen.completeWhen || 'viewed') === 'viewed' && courseState.activitiesOf(screen).every(courseState.activityDone)) return labels.listen;
  return view.revealed < view.lastStep() && !nextReveals() ? labels.explore : labels.locked;
}

function updateNav() {
  const screen = currentScreen();
  const moreSteps = nextReveals();
  const last = current >= courseState.screens.length - 1 && !moreSteps;
  const locked = !!screen && nextLocked();
  chrome.setNav({
    previous: current > 0, previousWhy: labels.firstScreen,
    next: !last && !locked, nextWhy: locked ? lockReason() : labels.lastScreen,
    nextLabel: moreSteps ? 'continue' : 'next'
  });
  // A bottom bar at the end of the page waits for the page's last step (scroll presentation).
  if (chrome.bottom && bottomAtEnd) chrome.bottom.hidden = !ended && !slides() && view.revealed < view.lastStep();
  if (screen) chrome.setScreen(screen.title);
  renderMenu();
  view.updateBackdrop();
}

function updateProgress() {
  const required = requiredScreens();
  const done = required.filter((screen) => courseState.screenComplete(screen)).length;
  const percent = required.length ? Math.round((100 * done) / required.length) : 100;
  let text = `${percent} %`;
  try { text = new Intl.NumberFormat(course.language, { style: 'percent' }).format(percent / 100); } catch { /* the plain number */ }
  chrome.setProgress(percent, text);
}

function toggleMenu(force?: boolean) {
  if (!menu || !chrome.outlineButton) return;
  const open = force ?? !!menu.hidden;
  menu.hidden = !open;
  chrome.outlineButton.setAttribute('aria-expanded', String(open));
  if (!open) return;
  alignToButton(menu, chrome.outlineButton);
  tooltip.hide();
  renderMenu();
  const currentItem = menu.querySelector<HTMLElement>('[aria-current="page"]');
  if (currentItem) menu.scrollTop = Math.max(0, currentItem.offsetTop - (menu.clientHeight - currentItem.offsetHeight) / 2);
}

// The outline covers part of the screen: it closes on Escape, on a click outside and when focus
// leaves it, so it never hides the focused element.
const outsideMenu = (target: EventTarget | null) => !(target instanceof Node && (menu?.contains(target) || chrome.outlineButton?.contains(target)));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !menu || menu.hidden) return;
  const refocus = !outsideMenu(document.activeElement);
  toggleMenu(false);
  if (refocus) chrome.outlineButton?.focus();
});
document.addEventListener('pointerdown', (event) => { if (menu && !menu.hidden && outsideMenu(event.target)) toggleMenu(false); });
document.addEventListener('focusin', (event) => { if (menu && !menu.hidden && outsideMenu(event.target)) toggleMenu(false); });

// The outline: where the learner is (« Écran 3 sur 12 »), then the sections and their screens, each
// with what it is to the learner: done (a tick), shown (a dot), not open yet (a lock), as Rise's.
function renderMenu() {
  if (!menu || menu.hidden) return;
  const lists = course.sections.map((section) => element('section', { class: 't-menu-section' },
    element('h2', { text: section.title }),
    element('ul', {}, section.screens.map((id) => {
      const index = courseState.screenIndex.get(id)!; // sections list the screens of the course
      const screen = courseState.screens[index];
      const open = reachable(index);
      const done = courseState.screenComplete(screen);
      const state = done ? ` — ${labels.completed}` : open ? '' : ` — ${labels.menuLocked}`;
      const mark = done ? icon('checkCircle') : index === current ? icon('dot') : open ? element('span', { class: 't-menu-ring', 'aria-hidden': 'true' }) : icon('lock');
      return element('li', {}, element('button', {
        type: 'button', class: 't-menu-item', 'aria-current': index === current ? 'page' : undefined,
        'aria-disabled': open ? undefined : 'true', 'data-state': done ? 'done' : open ? 'open' : 'locked',
        onclick: () => { if (open) { toggleMenu(false); go(index); } }
      }, element('span', { class: 't-menu-mark' }, mark), element('span', { class: 't-menu-text', text: screen.title }), element('span', { class: 't-sr-only', text: state })));
    }))));
  const where = element('p', { class: 't-menu-where', text: format(labels.screenOf, { n: current + 1, total: courseState.screens.length }) });
  menu.replaceChildren(where, ...lists, ...(keptHere ? [progressNote()] : []));
}

// ── Progress kept in this browser (the web target, progress local: keptHere) ──
// The learner is told, quietly, that the progress stays in this browser, and may clear it: the
// kept elements leave localStorage and the module starts again from the beginning.
function progressNote(): HTMLElement {
  const note = element('div', { class: 't-progress-note' });
  const offer = () => {
    note.replaceChildren(element('p', { text: labels.progressKept }),
      element('button', { type: 'button', class: 't-link-btn', onclick: ask }, labels.clearProgress));
  };
  const ask = () => {
    const cancel = element('button', { type: 'button', class: 't-btn t-btn--secondary', onclick: () => { offer(); note.querySelector<HTMLElement>('button')?.focus(); } }, labels.cancel);
    note.replaceChildren(element('p', { id: 't-clear-question', text: labels.clearProgressConfirm }),
      element('div', { class: 't-progress-note-actions', role: 'group', 'aria-labelledby': 't-clear-question' }, cancel,
        element('button', { type: 'button', class: 't-btn t-btn--primary t-clear-progress', onclick: clearProgress }, labels.clearProgressYes)));
    cancel.focus();
  };
  offer();
  return note;
}

// Ends the visit without saving it, forgets what was kept, and starts the module again. The visit is
// finished first so that nothing writes the progress back on the way out (pagehide, the heartbeat).
function clearProgress() {
  ended = true;
  if (lms.phase === 'initialized') lms.finish();
  lms.reset?.();
  location.reload();
}

// index: undefined for a screen id that does not exist.
function go(index: number | undefined, { focus = true }: { focus?: boolean } = {}) {
  if (ended || index === undefined || index < 0 || index >= courseState.screens.length) return;
  if (!reachable(index)) { announce(labels.locked); return; }
  view.leave();
  current = index;
  view.show(courseState.screens[index]);
  preloadNarration(courseState.screens[index + 1]);
  syncNow();
  updateNav();
  if (focus) main.querySelector('h1')?.focus();
  window.scrollTo?.(0, 0);
}

// The next screen's narration loads while the learner is on this one.
let preloaded: HTMLAudioElement | null = null;
function preloadNarration(screen: ScreenData | undefined) {
  const src = screen?.narration?.src;
  if (!src || preloaded?.getAttribute('src') === src || window.ELABORA_TEST?.virtualTime) return;
  preloaded = element('audio', { preload: 'auto', src });
}

// ── The screen ────────────────────────────────────────────────────────
// Rendering, rooms, free objects, layers, steps, events and backdrop (screen-view.ts, shared with
// the editor canvas). Events that leave the screen, end the course or retake it come back here.
// The controls item of the player says what a narrated screen's bar shows (D58).
let view!: ReturnType<typeof createScreenView>;
function mountView() {
  const controlsItem = [...(course.player.top?.items ?? []), ...(course.player.bottom?.items ?? [])].find((item) => item.id === 'controls');
  const controls = controlsItem?.id === 'controls' ? controlsItem : null;
  view = createScreenView({
    app, main, course, courseState, labels, formatLabel: format, announce, recordInteraction, syncSoon, framesPort: pageFramesPort('meta'), tooltip,
    timeline: {
      host: chrome.controls, autoplay: true, virtual: window.ELABORA_TEST?.virtualTime === true, tooltip, sheetHost: app,
      prefs: loadTimelinePrefs({ keep, captions: controls?.captionsByDefault ?? false, speeds: controls?.speeds, course: packageId }),
      ...(controls ? { controls: { seekBar: controls.seekBar, volume: controls.volume, transcript: controls.transcript, speeds: controls.speeds } } : {})
    },
    afterTimeline: () => { updateNav(); mentionGeneratedVoice(); },
    afterEvents: () => { updateNav(); syncSoon(); },
    afterReveal: () => { syncSoon(); updateNav(); updateProgress(); },
    navigate: (target, from) => {
      const index = screenNumber(from.id) ?? current;
      const destination = target === 'next' ? index + 1 : target === 'previous' ? index - 1 : screenNumber(target);
      setTimeout(() => go(destination), 0);
    },
    exit: quit,
    retake: () => { const id = courseState.retake(); syncNow(); go(screenNumber(id)); }
  });
}

// ── Languages (D59) ───────────────────────────────────────────────────
// A package of several languages holds the course in each (elabora/course.<lang>.js). The learner
// switches from « Langue »: the bars and the screen are mounted again in that language, on the same
// screen and step, with the same progress (it is keyed by element keys, the same in every language);
// the LMS session goes on, and the language chosen is kept with the progress.
function courseIn(code: string): Promise<CourseData | null> {
  if (code === initial.language) return Promise.resolve(initial);
  const loaded = window.ELABORA_COURSES?.[code];
  if (loaded) return Promise.resolve(loaded);
  if (!initial.languages?.includes(code)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const script = element('script', { src: `elabora/course.${code}.js` });
    script.addEventListener('load', () => resolve(window.ELABORA_COURSES?.[code] ?? null));
    script.addEventListener('error', () => resolve(null));
    document.head.append(script);
  });
}
// The course state in another language, with the learner's progress as it is.
function useCourse(data: CourseData) {
  const progress = courseState.encode();
  const status = courseState.lmsStatus;
  course = data;
  courseState = createCourseState(course, { suspendData: progress, initialStatus: status, onChange: () => syncSoon() });
  courseState.st.language = data.language === initial.language ? undefined : data.language;
}
async function switchLanguage(code: string) {
  if (ended || code === course.language) return;
  const data = await courseIn(code);
  if (!data || ended) return;
  const index = current;
  syncNow();
  unmount();
  useCourse(data);
  mountBars();
  mountView();
  current = -1;
  go(index, { focus: false });
  updateProgress();
  chrome.languageButton?.focus();
  announce(languageName(code));
}

// A generated voice is said to be one the first time it plays (AI Act, art. 50(5): at the latest at
// the first exposure): « Voix générée par IA » in the tooltip of « IA et crédits », for a while.
let mentioned = false;
function mentionGeneratedVoice() {
  const button = chrome.sheetButtons.get('about');
  if (mentioned || !button || !view.timeline?.playing || !currentScreen()?.narration?.generated) return;
  mentioned = true;
  // Said in the live region too, for screen readers (AI Act, art. 50(5): at the first exposure).
  announce(labels.generatedVoice);
  tooltip.flash(button, labels.generatedVoice, { duration: 6000 });
}

// ── Start ─────────────────────────────────────────────────────────────
// In the language the learner chose last time (D59), else the course's own. The location is a
// screen key; packages built before 2026-10-07 wrote the screen id.
function boot() {
  mountBars();
  mountView();
  const savedByKey = course.screens.findIndex((screen) => screen.key === savedLocation);
  const start = savedByKey >= 0 ? savedByKey : courseState.screenIndex.get(savedLocation) ?? 0;
  go(start, { focus: false });
  updateProgress();
  window.__elabora = debugHooks;
}

// Debug and test hooks (also used by the LMS emulator and by agents' preview screenshots).
// engine: the course state (the name is kept for the tools that read engine.screens and engine.st).
const debugHooks = {
  get course() { return course; },
  get engine() { return courseState; },
  lms,
  // Shows the course in another language of the package (D59).
  language: (code: string) => switchLanguage(code),
  get screen() { return currentScreen()?.id; },
  go: (id: string | number) => go(typeof id === 'number' ? id : courseState.screenIndex.get(id)),
  quit,
  openLayer: (id: string) => view.openLayer(id),
  showAnswered: () => view.showAnswered(),
  feedbackRooms: () => view.feedbackRooms(),
  // Heights of an activity of the current screen: as it is now, then once answered, outcome by outcome.
  rooms: (blockId: string) => view.rooms(blockId),
  // Reveals every step of the current screen (emulator, fit checks, screenshots); a narrated screen
  // waits at its end, without playing (nothing fires: timeline.toEnd plays it).
  revealAll: () => {
    if (view.revealed < view.lastStep()) view.revealStep(view.lastStep(), { animate: false, focus: false, play: false });
    if (view.timeline) { view.timeline.showAt(view.timeline.duration); view.applySteps(); }
  },
  // Shows the screen as it is at step n (previews and screenshots; may go back to an earlier step).
  reveal: (step: number) => { view.reveal(step); updateNav(); },
  // The narrated screen's timeline (docs/decisions.md D24): its state, playing, seeking, a line.
  timeline: {
    state: () => view.timeline?.state() ?? null,
    play: () => view.timeline?.play(),
    pause: () => view.timeline?.pause(),
    seek: (time: number) => view.timeline?.seek(time),
    // Moves the virtual clock of tests (window.ELABORA_TEST.virtualTime) while it plays.
    advance: (seconds: number) => view.timeline?.advance(seconds),
    // Shows the screen as it is when a line starts (or ends): its step, its caption; nothing fires.
    at: (line: string, options: { edge?: 'start' | 'end'; captions?: boolean } = {}) => { const shown = view.showLine(line, options); updateNav(); return shown; },
    // Shows a timed screen as it is at a time (seconds): its step, its caption, its timed blocks
    // where their effects are then; nothing fires.
    atTime: (time: number, options: { captions?: boolean } = {}) => { const shown = view.showTime(time, options); updateNav(); return shown; },
    // Which timed blocks are hidden by their timing at the time shown.
    hiddenByTiming: () => view.timed?.hidden() ?? [],
    // The timeline of an open layer (D62): the same controls, on its own clock; null when the layer
    // is not open or has no timeline. layers: the open layers that have one.
    layers: () => view.layerTimelines,
    layer: (id: string) => {
      const timeline = view.layerTimeline(id);
      if (!timeline) return null;
      return {
        state: () => timeline.state(),
        play: () => timeline.play(),
        pause: () => timeline.pause(),
        seek: (time: number) => timeline.seek(time),
        advance: (seconds: number) => timeline.advance(seconds),
        at: (line: string, options: { edge?: 'start' | 'end'; captions?: boolean } = {}) => view.showLayerLine(id, line, options),
        atTime: (time: number, options: { captions?: boolean } = {}) => view.showLayerTime(id, time, options),
        hiddenByTiming: () => view.layerTimed(id)?.hidden() ?? []
      };
    },
    // Plays to the end on the virtual clock (crossing every cue), opening the steps that open with
    // Continue on the way and closing the dialogs cues open, as a learner would; stops where an
    // answer is awaited. A dialog's close event comes with the next frame: it waits for it.
    toEnd: async () => {
      const timeline = view.timeline;
      if (!timeline) return null;
      if (timeline.time >= timeline.duration - 1e-3) timeline.seek(view.screen?.narration?.segments.find((segment) => segment.step === view.revealed)?.start ?? 0);
      for (let guard = 0; guard < 1000; guard++) {
        // A panel that speaks holds the narration until it has spoken (D62): heard to its end.
        for (const layer of view.layerTimelines) {
          const own = view.layerTimeline(layer);
          if (!own || own.time >= own.duration - 1e-3) continue;
          if (!own.playing) own.play();
          own.advance(own.duration + 1);
        }
        // A dialog a cue opened holds the narration: closed, as a learner would.
        const open = [...document.querySelectorAll<HTMLDialogElement>('dialog.t-layer.t-dialog[open]')];
        for (const dialog of open) dialog.close();
        if (open.length) await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        if (!timeline.playing) timeline.play();
        timeline.advance(timeline.duration + 1);
        if (document.querySelector('dialog.t-layer.t-dialog[open]')) continue;
        if (timeline.time >= timeline.duration - 1e-3 && view.revealed === view.lastStep()) break;
        const next = view.nextStep();
        if (next === undefined || !view.opensWithContinue(next) || view.listening()) break;
        view.revealStep(next, { focus: false });
      }
      updateNav();
      return timeline.state();
    }
  },
  get step() { return { revealed: view.revealed, steps: [...view.steps] }; },
  state: () => ({ screen: currentScreen()?.id, status: courseState.lmsStatus, score: courseState.score(), suspendData: courseState.encode() }),
  objectHost: (blockId: string) => view.objectHost(blockId),
  // Resolves when the fonts are loaded, the images of the current screen decoded and its free
  // objects answered (or failed), and the layout has settled (reserved rooms measured again):
  // previews, screenshots and fit checks wait for it instead of a fixed delay.
  ready: (timeout?: number) => view.ready(timeout),
  test: {
    // Used by the LMS emulator: completes a free object as if it emitted its completion event.
    completeObject(blockId: string, score = 1) {
      const block = courseState.blockIndex.get(blockId)?.block;
      if (!block || !hasBehavior(block, 'object')) return false;
      const events = course.objects[block.props.object]?.events || {};
      const name = Object.keys(events).find((candidate) => events[candidate]?.tracking?.completion);
      courseState.completeObject(blockId, score);
      if (name) view.trigger('object.event', { target: blockId, name, payload: { score } });
      const screen = currentScreen();
      if (screen) courseState.refreshScreenCompletion(screen);
      syncNow();
      updateNav();
      return true;
    }
  }
};
type DebugHooks = typeof debugHooks;
const chosen = courseState.st.language;
if (chosen && chosen !== course.language && initial.languages?.includes(chosen)) {
  void courseIn(chosen).then((data) => { if (data) useCourse(data); boot(); });
} else boot();
