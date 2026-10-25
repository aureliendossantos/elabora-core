// The screen on the page: what learners see of one screen, shared by the player (player.ts, with
// its LMS and navigation) and the editor canvas (canvas.ts, one screen updated in place), so the
// canvas shows exactly what a package shows. It renders the screen and its blocks, reserves the
// room of activities, hosts free objects, opens layers, reveals steps, runs the events of the
// screen and paints the backdrop. Navigation, the LMS and saving belong to the page around it.

import { behaviorOf, flatBlocks, isActivity } from './course-state.ts';
import type { CourseState, TriggerInfo } from './course-state.ts';
import { createBehaviors } from './behaviors.ts';
import { createObjectHost } from './object-host.ts';
import type { ObjectHost } from './object-host.ts';
import type { Labels } from './labels.ts';
import type { Interaction } from './scorm12.ts';
import { element, uniqueId } from './dom.ts';
import { objectFrame } from './frames.ts';
import { fieldOf } from './json.ts';
import { createTimeline } from './timeline.ts';
import type { Timeline, TimelineControls, TimelinePrefs } from './timeline.ts';
import type { Tooltip } from './tooltip.ts';
import { createTimedBlocks, forgetThemeKeyframes } from './timed-blocks.ts';
import type { TimedBlocks } from './timed-blocks.ts';
import type {
  AudioBlock, Behavior, BlockData, CourseData, LayerData, ObjectBlock, ObjectDefinition, ObjectEventDeclaration, QuizBlock, ScreenData, TriggerType, VideoBlock
} from './course-data.ts';
import type { ObjectContext, ObjectView, SafeArea } from './object-protocol.ts';
import { createTranscriptBar } from './transcript.ts';
import type { TranscriptBar } from './transcript.ts';
import type { Action } from './course-data.ts';
import type { DialoguePresentation } from './dialogue/walk.ts';

export interface ScreenViewOptions {
  // #elabora-app (data-presentation) and #t-main, where the screen goes.
  app: HTMLElement;
  main: HTMLElement;
  // The course: objects, tokens, fonts, language, backdrop. The canvas replaces its screens and
  // objects when render data arrives.
  course: CourseData;
  courseState: CourseState;
  labels: Labels;
  formatLabel(label: string, values: Readonly<Record<string, unknown>>): string;
  // Says a message in the live region.
  announce(message: string): void;
  recordInteraction(interaction: Interaction): void;
  // The course state changed (an object's state saved): the page syncs soon.
  syncSoon(): void;
  // Events of the screen ran (the player updates its navigation and syncs).
  afterEvents(): void;
  // A step was revealed (the player syncs, updates its navigation and its progress).
  afterReveal(): void;
  // An event of the screen goes to another screen: 'next', 'previous' or a screen id.
  navigate(target: string, from: ScreenData): void;
  // An event ends the course.
  exit(): void;
  // The retry button of results: take the assessment again.
  retake(): void;
  // The port free objects' frames load from (frames.ts; default null: as in a package).
  framesPort?: number | null;
  // The player's tooltip (D58): a Continue that cannot open yet says why there, moving nothing.
  tooltip?: Tooltip | null;
  // Narrated screens (docs/decisions.md D24): where their bar goes (null: no bar), whether playback
  // starts by itself, the virtual clock of tests, the learner's choices; afterTimeline: playback
  // started or stopped (the player updates its navigation). Without it, no timeline runs.
  // controls: what the player's controls item shows (D58); tooltip and sheetHost: the player's
  // tooltip and where its side panels go (the transcript).
  timeline?: { host: HTMLElement | null; autoplay: boolean; virtual: boolean; prefs: TimelinePrefs; controls?: TimelineControls; tooltip?: Tooltip | null; sheetHost?: HTMLElement | null };
  afterTimeline?(): void;
  // The editor's canvas: what plays by itself (a chart's entrance) is shown at rest.
  still?: boolean;
}

// A block of the screen being updated in place: kept as it is, kept with its slots refilled, or new.
type Plan = 'reuse' | 'keep' | 'new';

export type ScreenView = ReturnType<typeof createScreenView>;

export function createScreenView(options: ScreenViewOptions) {
  const { app, main, course, courseState, labels, announce, recordInteraction, framesPort = null } = options;
  // The screen shown, its steps and the step reached.
  let screen: ScreenData | undefined;
  let steps = [1];
  let revealed = 1;
  // The narrated screen's timeline: it shows the steps up to where it is (seeking back hides later
  // steps without changing the step reached).
  let timeline: Timeline | null = null;
  // Its timed blocks: what is seen of them follows the playhead (docs/decisions.md D28).
  let timed: TimedBlocks | null = null;
  const shownStep = () => (timeline ? Math.min(revealed, timeline.displayStep()) : revealed);

  // Blocks that go edge to edge (width bleed, a template's data-t-bleed, D63) are as wide as the
  // screen's area: #t-main without the window's scrollbar, which 100vw would count. Kept on #t-main as
  // --t-page-width (its own CSS px: the learner's text size zooms it as a whole).
  const pageWidth = () => main.style.setProperty('--t-page-width', `${main.clientWidth}px`);
  pageWidth();
  if (typeof ResizeObserver === 'function') new ResizeObserver(pageWidth).observe(main);

  // ── Steps ─────────────────────────────────────────────────────────────
  // Blocks of a screen may carry a step; Continue reveals the next one before leaving the screen.
  // A pending step takes no room in scroll presentation and keeps its place in slides (the view
  // does not move). Back on a screen left part-way, the learner finds the step reached.
  const lastStep = () => steps[steps.length - 1];
  const nextStep = () => steps[steps.indexOf(revealed) + 1];
  // The last step of the screen up to step (the first step when there is none).
  const reachedStep = (step: number) => steps.filter((candidate) => candidate <= step).pop() ?? steps[0];
  // The steps of a screen: those of its blocks and of its narration's lines.
  const stepsOf = (shown: ScreenData) => [...new Set([...shown.blocks.map((block) => block.step || 1), ...(shown.narration?.segments.map((segment) => segment.step) ?? [])])].sort((a, b) => a - b);
  const slides = () => app.dataset.presentation === 'slides';
  // How a step opens (screen.steps): with Continue (default), or by itself once the activities of
  // the steps above are answered. A screen with continueRevealsSteps: false leaves its steps to its
  // own triggers.
  const stepSettings = (step: number) => screen?.steps?.[String(step)] || {};
  const opensWithContinue = (step: number) => screen?.continueRevealsSteps !== false && stepSettings(step).opens !== 'answered';
  const shownActivities = () => (screen ? courseState.activitiesOf({ blocks: screen.blocks.filter((block) => (block.step || 1) <= revealed) }) : []);
  // With navigation.lockUntilComplete, a narrated step must also have been heard to its end.
  const listening = () => !!course.navigation.lockUntilComplete && !!timeline && !timeline.segmentHeard(revealed);
  const continueLocked = () => exploreLocked() || (!!course.navigation.lockUntilComplete && (!shownActivities().every(courseState.activityDone) || listening()));
  // Steps that wait for exploration (screen.steps opens "explored", D63): their Continue is shown but
  // locked until every activity of the steps above is answered and every control of their blocks is
  // visited, optional blocks (and what they hold) and blocks concealed by events aside.
  const waitsForExploring = (step: number | undefined) => step !== undefined && stepSettings(step).opens === 'explored';
  function leftAbove(step: number) {
    const left = { answer: 0, explore: 0, cards: 0 };
    const count = (blocks: readonly BlockData[] | undefined) => {
      for (const block of blocks || []) {
        if (block.optional || !courseState.blockVisible(block)) continue;
        if (isActivity(block) && !courseState.activityAnswered(block)) left.answer++;
        const node = main.querySelector<HTMLElement>(`[data-block="${CSS.escape(block.id)}"]`);
        // The controls of its template, by name (a name is one control, whatever holds it).
        const controls = node ? behaviors.controls(node) : Object.keys(block.visits || {}).map((name) => ({ name, hook: 'click' as const }));
        const named = new Set<string>();
        for (const control of controls) {
          if (named.has(control.name) || !block.visits?.[control.name] || courseState.controlVisited(block.id, control.name)) continue;
          named.add(control.name);
          left.explore++;
          if (control.hook === 'flip') left.cards++;
        }
        count(block.blocks);
      }
    };
    count(screen?.blocks.filter((block) => (block.step || 1) < step));
    return left;
  }
  // What is left before the next step opens, or null when it does not wait for exploration or nothing is left.
  function exploreLeft() {
    const next = nextStep();
    if (!screen || revealed >= lastStep() || !waitsForExploring(next)) return null;
    const left = leftAbove(next);
    return left.answer + left.explore ? left : null;
  }
  const exploreLocked = () => exploreLeft() !== null;
  // Locked, it says what is left: "1 question left to answer. 2 cards left to turn over."
  function exploreReason(): string {
    const left = exploreLeft();
    if (!left) return '';
    const parts: string[] = [];
    if (left.answer) parts.push(options.formatLabel(labels.leftToAnswer, { n: left.answer }));
    if (left.explore) parts.push(options.formatLabel(left.cards === left.explore ? labels.leftCards : labels.leftToExplore, { n: left.explore }));
    return parts.join(' ');
  }
  const lockedWhy = () => (listening() ? labels.listen : exploreLocked() ? exploreReason() : labels.locked);
  // The blocks of the latest step shown get data-t-current (styles: the next thing to click).
  function applySteps() {
    if (!screen) return;
    const shown = shownStep();
    for (const block of screen.blocks) {
      const node = main.querySelector<HTMLElement>(`[data-block="${block.id}"]`);
      if (!node) continue;
      const pending = (block.step || 1) > shown;
      node.toggleAttribute('data-t-pending', pending);
      node.toggleAttribute('data-t-current', (block.step || 1) === shown);
      syncInert(node);
    }
    // Blocks that come into view visit what they show first (a sequence's item): before Continue is
    // drawn, so that it knows what is left.
    behaviors.noteShown(main);
    syncContinue();
  }
  // Scroll presentation: the next step opens with a Continue button in the page, where the shown
  // content ends (the continue dividers of Rise); in slides the page's Next button does it. With
  // navigation.lockUntilComplete the button waits for the activities shown above.
  // A narrated screen offers Continue once the step shown has been heard to its end (seek seen or
  // none), at any time with free seeking. In slides wider than a phone, its place is kept at the end
  // of the screen from the start, so that it appears without moving anything; on phones and in scroll
  // pages it comes in the page, where the next step will open.
  const continueOffered = () => !timeline || screen?.narration?.seek === 'free' || timeline.segmentHeard(revealed);
  function continueControl(next: number | undefined, className: string) {
    const button = element('button', {
      type: 'button', class: 't-btn t-btn--primary t-continue-btn', 'aria-disabled': continueLocked() ? 'true' : undefined,
      onclick: () => {
        const step = next ?? nextStep();
        if (step === undefined) return;
        if (continueLocked()) { const why = lockedWhy(); options.tooltip?.flash(button, why); announce(why); return; }
        revealStep(step);
      }
    }, (next !== undefined && stepSettings(next).label) || labels.continue);
    options.tooltip?.attach(button, () => (button.getAttribute('aria-disabled') === 'true' ? lockedWhy() : null));
    const control = element('div', { class: className, 'data-step': next === undefined ? undefined : String(next) }, button);
    syncHint(control, next ?? nextStep());
    return control;
  }
  // A Continue that waits for exploration says what is left under it; its line stays once nothing is
  // left, so that nothing moves when it unlocks.
  function syncHint(control: HTMLElement, next: number | undefined) {
    let hint = control.querySelector<HTMLElement>('.t-continue-hint');
    const button = control.querySelector<HTMLElement>('.t-continue-btn');
    if (!waitsForExploring(next)) { hint?.remove(); button?.removeAttribute('aria-describedby'); return; }
    if (!hint) { hint = element('p', { class: 't-continue-hint', id: uniqueId('t-continue-hint') }); control.append(hint); }
    const why = exploreReason();
    hint.textContent = why || '\u00a0';
    hint.toggleAttribute('data-t-empty', !why);
    if (why) button?.setAttribute('aria-describedby', hint.id); else button?.removeAttribute('aria-describedby');
  }
  function syncContinue() {
    if (timeline && slides() && !phone()) { syncContinueSlot(); return; }
    for (const node of main.querySelectorAll('.t-continue')) node.remove();
    if (!screen || (slides() && !timeline) || revealed >= lastStep()) return;
    const next = nextStep();
    if (!opensWithContinue(next) || !continueOffered()) return;
    const first = screen.blocks.find((block) => (block.step || 1) === next);
    const anchor = first && main.querySelector<HTMLElement>(`[data-block="${first.id}"]`);
    // A step with lines and no block: Continue at the end of what is shown.
    const article = main.querySelector<HTMLElement>(':scope > article.t-screen');
    const control = continueControl(next, 't-continue');
    if (anchor?.parentElement) anchor.parentElement.insertBefore(control, anchor);
    else article?.append(control);
  }
  // The kept place of a narrated slide's Continue: hidden (and out of reach) while it waits.
  function syncContinueSlot() {
    for (const node of main.querySelectorAll('.t-continue:not(.t-continue--slot)')) node.remove();
    const article = main.querySelector<HTMLElement>(':scope > article.t-screen');
    let slot = main.querySelector<HTMLElement>('.t-continue--slot');
    if (!screen || !article || !steps.slice(1).some(opensWithContinue)) { slot?.remove(); return; }
    if (!slot) { slot = continueControl(undefined, 't-continue t-continue--slot'); article.append(slot); }
    const next = nextStep();
    const offered = revealed < lastStep() && next !== undefined && opensWithContinue(next) && continueOffered();
    slot.toggleAttribute('data-t-waiting', !offered);
    slot.inert = !offered;
    const button = slot.querySelector<HTMLElement>('.t-continue-btn');
    if (button) {
      button.textContent = (next !== undefined && stepSettings(next).label) || labels.continue;
      if (offered && continueLocked()) button.setAttribute('aria-disabled', 'true'); else if (offered) button.removeAttribute('aria-disabled'); else button.setAttribute('aria-disabled', 'true');
    }
    syncHint(slot, next);
  }
  // Steps that open once the activities above them are answered, right or wrong (screen.steps
  // opens "answered"): they appear without taking the focus, so the learner reads the feedback first.
  function openAnswered() {
    if (!screen) return;
    while (revealed < lastStep()) {
      const next = nextStep();
      if (stepSettings(next).opens !== 'answered') return;
      // A narrated step goes to its end before the next one opens.
      if (timeline && !timeline.segmentHeard(revealed)) return;
      const activities = shownActivities();
      if (!activities.length || !activities.every(courseState.activityAnswered)) return;
      revealStep(next, { focus: false });
    }
  }
  // A block is out of reach while its step is pending, while an event keeps it concealed, or while
  // its timing keeps it hidden.
  function syncInert(node: HTMLElement) { node.inert = node.hasAttribute('data-t-pending') || node.hasAttribute('data-t-concealed') || node.hasAttribute('data-t-timed'); }

  // play: a narrated step plays its stretch of the timeline (a seek that reaches it does not).
  function revealStep(step: number, { animate = true, focus = true, play = true }: { animate?: boolean; focus?: boolean; play?: boolean } = {}) {
    if (!screen) return;
    const before = revealed;
    revealed = step;
    courseState.saveStep(screen, revealed, lastStep());
    // Every step shown now fades in (reveal-step may skip ahead).
    if (animate) for (const block of screen.blocks) if ((block.step || 1) > before && (block.step || 1) <= step) main.querySelector(`[data-block="${block.id}"]`)?.setAttribute('data-t-revealed', '');
    if (timeline && play) timeline.onReveal(step);
    applySteps();
    // A narrated screen is viewed once its timeline ends, not once its last step shows.
    if (revealed === lastStep() && !timeline) courseState.visit(screen);
    if (focus) focusStep(step);
    options.afterReveal();
  }
  // Focus goes to the first block of the step: screen readers read it, keyboards continue from it.
  function focusStep(step: number) {
    const first = screen?.blocks.find((block) => (block.step || 1) === step);
    const node = first && main.querySelector<HTMLElement>(`[data-block="${first.id}"]`);
    if (!node) return;
    node.setAttribute('tabindex', '-1');
    node.focus({ preventScroll: true });
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView?.({ block: slides() ? 'nearest' : 'start', behavior: reduce ? 'auto' : 'smooth' });
  }

  // ── Showing a screen ──────────────────────────────────────────────────
  // Leaving the screen shown: its objects stop and its layers close (their events still belong to it).
  function leave() {
    behaviors.dialogues.dispose();
    transcriptBar?.dispose();
    transcriptBar = null;
    timed?.dispose();
    timed = null;
    timeline?.dispose();
    timeline = null;
    app.removeAttribute('data-timeline');
    disposeHosts();
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog.t-layer')) dialog.close();
  }
  function show(next: ScreenData) {
    screen = next;
    steps = stepsOf(next);
    // Back on a screen left part-way: the step reached (the steps saved may have changed since);
    // a screen seen to the end shows every step; a new screen starts at its first step.
    const saved = courseState.savedStep(next);
    revealed = saved != null ? reachedStep(saved) : courseState.isVisited(next) ? lastStep() : steps[0];
    courseState.saveStep(next, revealed, lastStep());
    renderScreen(next);
    applySteps();
    courseState.visit(next, { allSteps: revealed === lastStep() && !(next.narration && options.timeline) });
    startTimeline(next);
    behaviors.dialogues.afterShow();
    trigger('screen.enter', {});
  }

  // ── The timeline of a narrated screen ─────────────────────────────────
  // It starts at the start of the step reached; a screen seen to its end waits at its end.
  const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;
  // A narrated slide's Continue moves between its kept place and the page as the window crosses the phone width.
  if (typeof matchMedia === 'function') matchMedia('(max-width: 760px)').addEventListener?.('change', () => { if (timeline) syncContinue(); });
  function startTimeline(shown: ScreenData, { autoplay = options.timeline?.autoplay ?? false }: { autoplay?: boolean } = {}) {
    timed?.dispose();
    timed = null;
    timeline?.dispose();
    timeline = null;
    transcriptBar?.dispose();
    transcriptBar = null;
    const narration = shown.narration;
    const settings = options.timeline;
    if (!narration && settings?.host && settings.controls?.transcript !== false) startTranscriptBar(shown, settings.host, settings.sheetHost ?? app, settings.tooltip ?? null);
    if (!narration || !settings) return;
    const done = courseState.screenComplete(shown) && revealed === lastStep();
    const start = done ? narration.duration : narration.segments.find((segment) => segment.step === revealed)?.start ?? 0;
    app.setAttribute('data-timeline', narration.seek);
    // Animations and objects the learner's Pause stopped, to play again.
    const stilled = new Set<Animation>();
    timeline = createTimeline({
      narration, labels, format: options.formatLabel, host: settings.host, overlay: main, prefs: settings.prefs, virtual: settings.virtual,
      controls: settings.controls, tooltip: settings.tooltip, sheetHost: settings.sheetHost,
      start, reached: start, autoplay: autoplay && !done, phone,
      offerStopAtSteps: course.screens.some((candidate) => !!candidate.narration && candidate.narration.advance !== 'learner'),
      // A layer that speaks has the shortcuts (D62); the transcript adds each layer's lines.
      keys: () => !speakingLayer(),
      transcriptLayers: shown.layers.filter((layer) => layer.narration?.lines.length).map((layer) => ({ title: layer.title, lines: layer.narration!.lines })),
      transcriptDialogues: () => behaviors.dialogues.transcripts(),
      view: {
        revealed: () => revealed,
        lastStep,
        display: () => {
          applySteps();
          // Focus in a block that a seek back hid goes to the seek bar.
          const focused = document.activeElement;
          if (focused instanceof HTMLElement && focused.closest('[data-t-pending]') && main.contains(focused)) timeline?.focusSeek();
        },
        moved: (time) => {
          // Charts whose items come with the voice follow the playhead.
          behaviors.charts.at(time);
          if (!timed) return;
          timed.apply(time);
          // Focus in a block its timing hid (a seek back before it came) goes to the seek bar.
          const focused = document.activeElement;
          if (focused instanceof HTMLElement && focused.closest('[data-t-timed]') && main.contains(focused)) timeline?.focusSeek();
        },
        chain: (next) => {
          if (!opensWithContinue(next) || continueLocked()) return false;
          revealStep(next, { focus: false });
          return true;
        },
        canReach: (step) => opensWithContinue(step),
        reach: (step) => { if (step > revealed) revealStep(reachedStep(step), { focus: false, play: false }); },
        cue: (event) => trigger('timeline.reached', { event }),
        ended: () => {
          if (screen !== shown) return;
          // The voice is done: every chart at rest, whatever a rounding left of its last beat.
          behaviors.charts.at(Infinity);
          courseState.visit(shown);
          options.afterReveal();
          trigger('timeline.ended', {});
        },
        segmentEnded: (step) => {
          if (screen !== shown) return;
          openAnswered();
          syncContinue();
          options.afterTimeline?.();
          // The voice stopped and Continue came, without taking the focus: said once.
          const next = nextStep();
          if (revealed === step && next !== undefined && opensWithContinue(next)) announce(options.formatLabel(labels.stepEnded, { n: steps.indexOf(step) + 1 }));
        },
        advance: () => { if (screen === shown) options.navigate('next', shown); },
        proceed: () => {
          const next = nextStep();
          if (screen !== shown || next === undefined || !opensWithContinue(next) || continueLocked()) return false;
          revealStep(next);
          return true;
        },
        // The learner's Pause stops everything: the voice, the animations, the free objects.
        still: (paused) => {
          if (screen !== shown) return;
          for (const host of hosts.values()) if (paused) host.pause(); else host.resume();
          if (paused) {
            for (const animation of main.getAnimations?.({ subtree: true }) ?? []) if (animation.playState === 'running') { animation.pause(); stilled.add(animation); }
          } else {
            for (const animation of stilled) animation.play();
            stilled.clear();
          }
        },
        changed: () => {
          // Two voices never overlap: the narration pauses the sounds and videos of the screen, and its dialogues.
          if (timeline?.playing) { pauseMedia(); behaviors.dialogues.pauseAll(); }
          syncContinue();
          options.afterTimeline?.();
        }
      }
    });
    startTimedBlocks(shown);
    applySteps();
  }
  // A screen without narration whose layers speak, or which holds a dialogue, has a transcript all the
  // same: a button in the player's controls item (D62, D61).
  let transcriptBar: TranscriptBar | null = null;
  function startTranscriptBar(shown: ScreenData, host: HTMLElement, sheetHost: HTMLElement, tooltip: Tooltip | null) {
    const layers = shown.layers.filter((layer) => layer.narration?.lines.length);
    const dialogues = flatBlocks(shown.blocks).some((block) => behaviorOf(block) === 'dialogue') || shown.layers.some((layer) => flatBlocks(layer.blocks).some((block) => behaviorOf(block) === 'dialogue'));
    if (!layers.length && !dialogues) return;
    transcriptBar = createTranscriptBar({
      host, sheetHost, labels, tooltip,
      sections: () => [
        ...layers.map((layer) => ({ title: layer.title, lines: layer.narration!.lines.map((line) => ({ ...(line.speaker ? { speaker: line.speaker } : {}), text: line.text })) })),
        ...behaviors.dialogues.transcripts().map((section) => ({ ...section, dialogue: true }))
      ]
    });
  }

  // The sounds and videos the learner plays (a voice that starts pauses them).
  function pauseMedia() {
    for (const media of document.querySelectorAll<HTMLMediaElement>('#t-main .t-figure video:not(.t-loop), #t-main .t-figure audio, dialog.t-layer .t-figure video:not(.t-loop), dialog.t-layer .t-figure audio')) if (!media.paused) media.pause();
  }

  // ── The timeline of a layer (docs/decisions.md D62) ───────────────────
  // A layer with a narration or timed blocks has its own timeline: another instance whose compact bar
  // is in the layer. It starts at 0 when the layer opens and stops when it closes. While it speaks the
  // screen's timeline is held (two voices never overlap): a dialog holds it until it closes, a panel
  // until its narration ends. The learner's Pause stops what is in the layer.
  interface LayerTimeline { timeline: Timeline; timed: TimedBlocks | null; dialog: HTMLDialogElement; panel: boolean; held: Timeline | null }
  const layerTimelines = new Map<string, LayerTimeline>();
  // The layer whose voice is live (the last opened that still plays or waits), which takes the shortcuts.
  const speakingLayer = (): string | null => [...layerTimelines.keys()].pop() ?? null;
  function startLayerTimeline(layer: LayerData, dialog: HTMLDialogElement, panel: boolean, host: HTMLElement) {
    const narration = layer.narration;
    const settings = options.timeline;
    if (!narration || !settings) return;
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timed = createTimedBlocks(dialog, layer.blocks, { reducedMotion, onChange: (node) => { syncInert(node); behaviors.noteShown(dialog); } });
    timed.apply(0);
    // The screen waits while the layer speaks (a modal dialog already holds it until it closes).
    const held = timeline;
    if (narration.lines.length && panel) held?.hold(`voice:${layer.id}`);
    const stilled = new Set<Animation>();
    // The timeline calls its view while it is made (its first move, autoplay): the entry exists first.
    const entry = { timed, dialog, panel, held } as LayerTimeline;
    entry.timeline = createTimeline({
        narration, labels, format: options.formatLabel, host, overlay: dialog, prefs: settings.prefs, virtual: settings.virtual,
        controls: { seekBar: settings.controls?.seekBar ?? true, volume: false, transcript: false, speeds: [] }, tooltip: settings.tooltip,
        compact: true, label: `${labels.narration} · ${layer.title}`, keys: () => speakingLayer() === layer.id,
        start: 0, reached: 0, autoplay: settings.autoplay, phone: () => false, offerStopAtSteps: false,
        view: {
          revealed: () => 1, lastStep: () => 1, display: () => {}, chain: () => false, canReach: () => false, reach: () => {}, segmentEnded: () => {}, advance: () => {}, proceed: () => false,
          moved: (time) => {
            entry.timed?.apply(time);
            // Charts whose items come with the layer's voice follow its playhead (D60, D62).
            behaviors.charts.at(time, dialog);
            const focused = document.activeElement;
            if (focused instanceof HTMLElement && focused.closest('[data-t-timed]') && dialog.contains(focused)) entry.timeline?.focusSeek();
          },
          cue: (event) => trigger('timeline.reached', { event }),
          ended: () => {
            behaviors.charts.at(Infinity, dialog);
            // A panel gives the screen its voice back once it has spoken.
            if (entry.panel) releaseLayerHold(layer.id, entry);
            trigger('timeline.ended', { layer: layer.id });
          },
          // The learner's Pause stops what is in the layer: its animations and free objects.
          still: (paused) => {
            for (const [id, host] of hosts) if (dialog.querySelector(`[data-block="${CSS.escape(id)}"]`)) { if (paused) host.pause(); else host.resume(); }
            if (paused) {
              for (const animation of dialog.getAnimations?.({ subtree: true }) ?? []) if (animation.playState === 'running') { animation.pause(); stilled.add(animation); }
            } else {
              for (const animation of stilled) animation.play();
              stilled.clear();
            }
          },
          changed: () => {
            if (entry.timeline?.playing) { pauseMedia(); behaviors.dialogues.pauseAll(); if (timeline?.playing) timeline.pause(); }
            options.afterTimeline?.();
          }
        }
    });
    layerTimelines.set(layer.id, entry);
  }
  function releaseLayerHold(id: string, entry: LayerTimeline) {
    if (!entry.panel || !entry.held) return;
    const held = entry.held;
    entry.held = null;
    if (held === timeline) held.release(`voice:${id}`);
  }
  function stopLayerTimeline(id: string) {
    const entry = layerTimelines.get(id);
    if (!entry) return;
    layerTimelines.delete(id);
    entry.timed?.dispose();
    entry.timeline.dispose();
    releaseLayerHold(id, entry);
  }
  // The timed blocks of the screen shown, placed at the playhead (blocks rendered again in the
  // canvas get their effects again).
  function startTimedBlocks(shown: ScreenData) {
    timed?.dispose();
    timed = null;
    // Without a timeline, charts with beats play their entrance like the others.
    behaviors.charts.at(timeline ? timeline.time : null);
    if (!timeline) return;
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    timed = createTimedBlocks(main, shown.blocks, { reducedMotion, onChange: (node) => { syncInert(node); behaviors.noteShown(main); } });
    timed.apply(timeline.time);
  }

  // ── Events ────────────────────────────────────────────────────────────
  // Events triggered by events nest up to this depth.
  let depth = 0;
  function trigger(type: TriggerType, info: TriggerInfo) {
    const shown = screen;
    if (!shown || depth > 8) return;
    depth++;
    let navigation: string | null = null;
    const changedVariables: string[] = [];
    for (const run of courseState.eventsFor(shown, type, info)) {
      for (const action of run.actions) {
        const done = runAction(action, shown);
        if (done.navigation) navigation = done.navigation;
        if (done.variable) changedVariables.push(done.variable);
      }
    }
    for (const variable of changedVariables) trigger('variable.changed', { variable });
    depth--;
    courseState.refreshScreenCompletion(shown);
    // An answer may open the next step, or unlock its Continue button.
    if (depth === 0 && screen === shown) { openAnswered(); syncContinue(); }
    options.afterEvents();
    if (navigation && depth === 0) options.navigate(navigation, shown);
  }
  // One action of an event (or of a dialogue: presentation actions only, D61).
  function runAction(action: Action, shown: ScreenData): { navigation?: string; variable?: string } {
    let navigation: string | undefined;
    const changedVariables: string[] = [];
    switch (action.type) {
      case 'go-to': navigation = action.screen; break;
      case 'show-layer': openLayer(action.layer); break;
      case 'hide-layer': (action.layer === undefined ? topLayer() : document.querySelector<HTMLDialogElement>(`dialog.t-layer[data-layer="${action.layer}"]`))?.close(); break;
      case 'show-block': case 'hide-block': {
        courseState.setBlockVisible(action.block, action.type === 'show-block');
        const node = document.querySelector<HTMLElement>(`[data-block="${action.block}"]`);
        if (node) { node.toggleAttribute('data-t-concealed', action.type === 'hide-block'); syncInert(node); behaviors.noteShown(main); }
        break;
      }
      case 'reveal-step': if (action.step > revealed) revealStep(reachedStep(action.step)); else focusStep(action.step); break;
      case 'set-variable': if (courseState.setVar(action.variable, action.value)) changedVariables.push(action.variable); break;
      case 'increment-variable': if (courseState.incrementVar(action.variable, action.by)) changedVariables.push(action.variable); break;
      case 'complete-screen': courseState.markComplete(shown); break;
      case 'set-object-props': {
        const host = hosts.get(action.block);
        host?.updateProps(action.props);
        break;
      }
      case 'exit-course': setTimeout(() => options.exit(), 0); break;
      // With layer, the timeline of that layer while it is open (D62).
      case 'pause-timeline': (action.layer !== undefined ? layerTimelines.get(action.layer)?.timeline : timeline)?.pause(); break;
      case 'play-timeline': (action.layer !== undefined ? layerTimelines.get(action.layer)?.timeline : timeline)?.play(); break;
      case 'seek-timeline': if (typeof action.time === 'number') (action.layer !== undefined ? layerTimelines.get(action.layer)?.timeline : timeline)?.jump(action.time); break;
      case 'play-media': case 'pause-media': {
        const media = document.querySelector<HTMLMediaElement>(`[data-block="${action.block}"] video, [data-block="${action.block}"] audio`);
        if (media && action.type === 'play-media') void media.play().catch(() => {}); else media?.pause();
        break;
      }
      // A dialogue block of the screen (D61): begin it, move it to a node, start it over.
      case 'start-dialogue': behaviors.dialogues.start(action.block); break;
      case 'goto-dialogue': behaviors.dialogues.goto(action.block, action.node); break;
      case 'restart-dialogue': behaviors.dialogues.restart(action.block); break;
    }
    return { navigation, variable: changedVariables[0] };
  }
  // A dialogue's options and cues run presentation actions only (the validator refuses the others).
  const PRESENTATION = new Set<Action['type']>(['show-block', 'hide-block', 'show-layer', 'hide-layer', 'play-media', 'pause-media', 'set-object-props', 'reveal-step']);
  function dialogueActions(actions: readonly { type: string }[]) {
    const shown = screen;
    if (!shown) return;
    for (const action of actions) if (PRESENTATION.has(action.type as Action['type'])) runAction(action as Action, shown);
    behaviors.noteShown(main);
    options.afterEvents();
  }
  // What a dialogue's replayed path leaves on the screen: the blocks it showed or hid, the props it
  // set, the step it revealed. No layer opens and no media plays.
  function dialoguePresentation(presentation: DialoguePresentation) {
    for (const [id, visible] of Object.entries(presentation.blocks)) {
      const node = document.querySelector<HTMLElement>(`[data-block="${CSS.escape(id)}"]`);
      if (node) { node.toggleAttribute('data-t-concealed', !visible); syncInert(node); }
    }
    for (const [id, props] of Object.entries(presentation.props)) hosts.get(id)?.updateProps(props as Record<string, never>);
    if (presentation.step > revealed) revealStep(reachedStep(presentation.step), { animate: false, focus: false, play: false });
    behaviors.noteShown(main);
  }
  // While a dialogue speaks, the narration of the screen waits (and a layer's stops).
  const dialogueHolds = new Map<string, Timeline>();

  // ── Screens and blocks ────────────────────────────────────────────────
  // Every block arrives as HTML rendered at build time from its component template (structure,
  // decoration and bound props, checked by the validator), with its slots and behaviour hooks. The
  // player places the blocks of each slot, then binds behaviours: what is scored, saved, announced
  // and keyboard-operable is never left to a template. Video, audio and free objects are code.
  const behaviors = createBehaviors({
    courseState, labels, language: course.language, formatLabel: options.formatLabel, announce, recordInteraction, trigger, retake: options.retake, still: options.still, courseTitle: course.title,
    // A control seen as its block came into view (a sequence's first item): a step waiting for
    // exploration looks again, and the page's Next with it.
    onVisited: () => { if (!screen) return; syncContinue(); options.afterEvents(); },
    dialogueHost: {
      virtual: options.timeline?.virtual === true || window.ELABORA_TEST?.virtualTime === true,
      prefs: () => options.timeline?.prefs ?? FALLBACK_PREFS,
      hold: (reason) => {
        for (const entry of layerTimelines.values()) if (entry.timeline.playing) entry.timeline.pause();
        if (timeline && !dialogueHolds.has(reason)) { dialogueHolds.set(reason, timeline); timeline.hold(reason); }
      },
      release: (reason) => {
        const held = dialogueHolds.get(reason);
        dialogueHolds.delete(reason);
        if (held && held === timeline) held.release(reason);
        timeline?.refreshTranscript();
        transcriptBar?.refresh();
      },
      act: (actions) => dialogueActions(actions),
      present: (presentation) => dialoguePresentation(presentation),
      slides,
      instantText: () => app.hasAttribute('data-text-instant')
    }
  });

  // Screens: without layout, blocks stack in the reading column (.t-blocks). With a layout (a
  // screen-level component), its template receives the blocks in its slots and the title in data-title.
  function renderScreen(shown: ScreenData) {
    const article = screenArticle(shown);
    if (!shown.layout) article.append(element('div', { class: 't-blocks' }, shown.blocks.map((block) => renderBlock(block))));
    else placeInSlots(article, shown.blocks, shown.layout.defaultSlot);
    main.replaceChildren(article);
    flushRooms();
  }
  // The article of a screen and its title, without its blocks.
  function screenArticle(shown: ScreenData): HTMLElement {
    const title = element('h1', { tabindex: '-1', class: shown.showTitle === false ? 't-sr-only' : 't-screen-title', text: shown.title });
    const layout = shown.layout || null;
    const article = element('article', {
      class: `t-screen${layout ? ` t-layout ${layout.lineage.map((id) => `t-layout--${id}`).join(' ')}` : ''}${shown.style ? ` t-s-${shown.style}` : ''}`,
      'data-screen': shown.id, 'data-section': shown.section, 'data-layout': layout?.id, 'data-component': layout ? layout.lineage.join(' ') : undefined, 'data-style': shown.style
    });
    main.toggleAttribute('data-full-bleed', !!layout?.fullBleed);
    if (!layout) article.append(title);
    else {
      article.innerHTML = layout.html;
      behaviors.primitives(article, { id: shown.id });
      layoutHooks(article, layout);
      const titleHost = article.querySelector('[data-title]');
      if (titleHost) titleHost.append(title); else article.prepend(title);
    }
    return article;
  }
  // What a layout says about its screen (D63), in the course's words: its section, its rank
  // (« Leçon 2 sur 6 ») and its reading time (« 6 min », named for screen readers).
  function layoutHooks(article: HTMLElement, layout: NonNullable<ScreenData['layout']>) {
    const fill = (hook: string, write: (node: HTMLElement) => void) => { for (const node of article.querySelectorAll<HTMLElement>(`[data-t-${hook}]`)) if (!node.textContent?.trim()) write(node); };
    const place = layout.place;
    fill('section', (node) => { node.textContent = place?.section ?? ''; });
    fill('lesson', (node) => { node.textContent = place ? options.formatLabel(labels.lessonOf, { n: place.n, total: place.total }) : ''; });
    fill('duration', (node) => {
      if (layout.minutes === undefined) return;
      node.append(element('span', { class: 't-sr-only', text: `${labels.readingTime}${labels.colon}` }), options.formatLabel(labels.minutes, { n: layout.minutes }));
    });
  }

  // ── Room for answers (slides) ─────────────────────────────────────────
  // In slides, answering must not move the slide: every activity reserves from the start the height
  // of its tallest outcome (feedback, flags, messages), measured on hidden copies at the same width,
  // and grows inside that room. A template whose feedback floats over its content opts out with
  // data-t-reserve="off". Blocks concealed by events keep their place the same way (CSS).
  const ROOM_BEHAVIORS = new Set<Behavior | null>(['quiz', 'numeric', 'fill-in', 'sort', 'reflection', 'decision', 'results', 'predict']);
  const roomQueue: [HTMLElement, BlockData][] = [];
  // The reserved rooms of the screen, measured again by ready() (fit checks and captures measure the
  // final room, whatever was still loading when the screen was shown).
  const roomFits = new Set<() => void>();
  const blockOf = (node: HTMLElement) => courseState.blockIndex.get(node.dataset.block ?? '')?.block;
  // Rooms are measured once the blocks are in the page.
  function flushRooms() {
    for (const [wrap, block] of roomQueue.splice(0)) reserveRoom(wrap, block);
    for (const [wrap, block] of itemRoomQueue.splice(0)) reserveItemRooms(wrap, block);
  }
  // What shows one thing at a time (a sequence, D63) reserves the room of its tallest item, in every
  // presentation and in layers too: moving through it never moves what is around it. (A flip card
  // needs no measure: its faces share one cell, player.css.)
  const itemRoomQueue: [HTMLElement, BlockData][] = [];
  function reserveItemRooms(wrap: HTMLElement, block: BlockData) {
    for (const { host, measure } of behaviors.rooms(wrap)) {
      // Measured again when the width changes, and when the content may have (images and fonts
      // loading): at a given width the room only grows.
      let width = 0;
      let room = 0;
      const fit = (force = false) => {
        if (!host.isConnected) return;
        const measuredWidth = Math.round(cssPx(host, host.getBoundingClientRect().width));
        if (!measuredWidth || (!force && measuredWidth === width)) return;
        if (measuredWidth !== width) room = 0;
        width = measuredWidth;
        room = Math.max(room, cssPx(host, measure()));
        host.style.minHeight = `${Math.ceil(room)}px`;
      };
      fit();
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
      observer?.observe(host);
      const refit = () => fit(true);
      host.addEventListener('load', refit, true); // images of the items (load does not bubble)
      document.fonts?.ready.then(refit);
      document.fonts?.addEventListener?.('loadingdone', refit);
      const later = setTimeout(refit, 700);
      roomFits.add(refit);
      cleanup(block.id, () => { observer?.disconnect(); document.fonts?.removeEventListener?.('loadingdone', refit); clearTimeout(later); roomFits.delete(refit); });
    }
  }
  // Boxes in the CSS px of the block: under the learner's text size (a CSS zoom on #t-main,
  // « Affichage »), getBoundingClientRect gives zoomed px, which written back as CSS px would be
  // zoomed again.
  const cssPx = (node: HTMLElement, px: number) => px / ((node as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1);
  // compact: measured as if the quiz's feedback were compact (feedbackRooms).
  function outcomeRooms(wrap: HTMLElement, block: BlockData, compact = false) {
    const width = cssPx(wrap, wrap.getBoundingClientRect().width);
    const ghost = () => {
      const copy = wrap.cloneNode(true) as HTMLElement;
      for (const node of [copy, ...copy.querySelectorAll('[id]')]) node.removeAttribute('id');
      // A copy in the same radio group would uncheck the learner's choice when it enters the page.
      for (const node of copy.querySelectorAll('input[name]')) node.removeAttribute('name');
      copy.setAttribute('aria-hidden', 'true');
      copy.inert = true;
      Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', left: '0', top: '0', width: `${width}px`, minHeight: '0' });
      wrap.parentElement!.append(copy); // same containers: container queries resolve as for the block
      return copy;
    };
    const measure = (index: number | null) => {
      const copy = ghost();
      const outcomes = behaviors.outcomes(copy, block);
      if (compact) for (const node of [copy, ...copy.querySelectorAll('[data-t-group]')]) node.setAttribute('data-t-feedback-style', 'compact');
      if (index !== null) outcomes[index]?.();
      const height = cssPx(copy, copy.getBoundingClientRect().height);
      copy.remove();
      return { height, count: outcomes.length };
    };
    const first = measure(null);
    const rooms = [first.height];
    for (let index = 0; index < first.count; index++) rooms.push(measure(index).height);
    return rooms; // [as it is now, outcome 0, outcome 1, …]
  }
  function reserveRoom(wrap: HTMLElement, block: BlockData) {
    if (!slides() || wrap.querySelector('[data-t-reserve="off"]')) return;
    // Measured again when the width changes and when the content does (images and fonts loading,
    // an answer): the room only grows at a given width, so answering never makes it shrink either.
    let width = 0;
    let content = -1;
    let room = 0;
    const fit = (force = false) => {
      if (!wrap.isConnected) return;
      const measuredWidth = Math.round(cssPx(wrap, wrap.getBoundingClientRect().width));
      const measuredContent = Math.round(cssPx(wrap, [...wrap.children].reduce((height, node) => height + node.getBoundingClientRect().height, 0)));
      if (!measuredWidth || (!force && measuredWidth === width && measuredContent === content)) return;
      if (measuredWidth !== width) room = 0;
      width = measuredWidth;
      content = measuredContent;
      room = Math.max(room, ...outcomeRooms(wrap, block));
      wrap.style.minHeight = `${Math.ceil(room)}px`;
    };
    fit();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    if (observer) for (const node of [wrap, ...wrap.children]) observer.observe(node);
    wrap.addEventListener('load', () => fit(), true); // images inside the activity (load does not bubble)
    // Text only the outcomes show (feedback) may wait for a font or a fallback glyph that the activity
    // as shown does not need: measured again once fonts are loaded, and once more shortly after.
    const refit = () => fit(true);
    document.fonts?.ready.then(refit);
    document.fonts?.addEventListener?.('loadingdone', refit);
    const later = setTimeout(refit, 700);
    roomFits.add(refit);
    cleanup(block.id, () => { observer?.disconnect(); document.fonts?.removeEventListener?.('loadingdone', refit); clearTimeout(later); roomFits.delete(refit); });
  }
  // Renders the tallest outcome of every activity among nodes (default: the screen and its open
  // layers) and shows the concealed blocks: the slide as it looks once everything is answered (fit,
  // screenshots, the canvas).
  function showAnswered(nodes: Iterable<HTMLElement> = main.querySelectorAll<HTMLElement>('.t-block[data-block]')) {
    const changed: (string | undefined)[] = [];
    for (const node of nodes) {
      const block = blockOf(node);
      // A sequence shows its tallest item (D63): the room it reserves, filled.
      if (block && behaviors.rooms(node).length) { behaviors.showTallest(node); changed.push(block.id); }
      if (!block || !ROOM_BEHAVIORS.has(behaviorOf(block))) continue;
      const rooms = outcomeRooms(node, block).slice(1);
      if (!rooms.length) continue;
      const index = rooms.indexOf(Math.max(...rooms));
      behaviors.outcomes(node, block)[index]();
      changed.push(block.id);
    }
    for (const node of main.querySelectorAll<HTMLElement>('.t-block[data-t-concealed]')) { node.removeAttribute('data-t-concealed'); syncInert(node); changed.push(node.dataset.block); }
    return { screen: screen?.id, changed };
  }

  // The room the quizzes of the screen with full feedback reserve for their tallest outcome, and the
  // room they would reserve with compact feedback (fit says what feedbackStyle "compact" saves).
  function feedbackRooms(nodes: Iterable<HTMLElement> = main.querySelectorAll<HTMLElement>('.t-block[data-block]')) {
    const rooms: { block: string; full: number; compact: number }[] = [];
    for (const node of nodes) {
      const block = blockOf(node);
      if (!block || behaviorOf(block) !== 'quiz' || (block as QuizBlock).props.feedbackStyle === 'compact') continue;
      const full = Math.max(0, ...outcomeRooms(node, block).slice(1));
      const compact = Math.max(0, ...outcomeRooms(node, block, true).slice(1));
      rooms.push({ block: block.id, full: Math.ceil(full), compact: Math.ceil(compact) });
    }
    return rooms;
  }

  // Slots of a template (screen layout or component instance) receive their blocks in order.
  function placeInSlots(host: HTMLElement, blocks: readonly BlockData[] | undefined, defaultSlot: string | null | undefined) {
    const slots = slotsOf(host);
    for (const block of blocks || []) slotFor(slots, host, block, defaultSlot).append(renderBlock(block));
    for (const node of slots.values()) node.toggleAttribute('data-empty', !node.children.length);
  }
  // The slots of a template, by name (those of its own markup: not the slots of the blocks it holds).
  function slotsOf(host: HTMLElement): Map<string, HTMLElement> {
    const owner = host.closest('.t-block[data-block]');
    const own = [...host.querySelectorAll<HTMLElement>('[data-slot]')].filter((node) => node.parentElement?.closest('.t-block[data-block]') === owner);
    return new Map(own.map((node) => { node.classList.add('t-slot'); return [node.dataset.slot ?? '', node] as const; }));
  }
  function slotFor(slots: ReadonlyMap<string, HTMLElement>, host: HTMLElement, block: BlockData, defaultSlot: string | null | undefined): HTMLElement {
    const slotNamed = (name: string | null | undefined) => (name == null ? undefined : slots.get(name));
    return slotNamed(block.slot || defaultSlot) || slotNamed(defaultSlot) || host;
  }

  // Blocks rendered by code, by type.
  const isVideo = (block: BlockData): block is VideoBlock => block.type === 'video';
  const isAudio = (block: BlockData): block is AudioBlock => block.type === 'audio';
  const isFreeObject = (block: BlockData): block is ObjectBlock => block.type === 'free-object';

  // A block with the blocks of its slots.
  function renderBlock(block: BlockData): HTMLElement {
    const wrap = blockShell(block);
    if (block.html != null && (block.blocks?.length || block.defaultSlot)) placeInSlots(wrap, block.blocks, block.defaultSlot);
    return wrap;
  }
  // A block without the blocks of its slots.
  function blockShell(block: BlockData): HTMLElement {
    const lineage = block.lineage || [block.type];
    const wrap = element('div', {
      class: `t-block ${lineage.map((type) => `t-block--${type}`).join(' ')} t-w-${block.width || 'full'}${block.style ? ` t-s-${block.style}` : ''}`,
      'data-block': block.id, 'data-type': block.type, 'data-component': lineage.length > 1 ? lineage.join(' ') : undefined,
      'data-behavior': block.behavior, 'data-style': block.style, 'data-t-concealed': !courseState.blockVisible(block)
    });
    syncInert(wrap);
    if (block.html != null) {
      wrap.innerHTML = block.html;
      // A template asks to go edge to edge from its root (an image band, D63), as width bleed does.
      if (wrap.querySelector(':scope > [data-t-bleed]')) wrap.classList.add('t-w-bleed');
      // Behaviours bind before the slots are filled: hooks of nested blocks belong to those blocks.
      behaviors.primitives(wrap, block);
      behaviors.bind(wrap, block);
      cleanup(block.id, () => behaviors.release(wrap));
      if (ROOM_BEHAVIORS.has(behaviorOf(block))) roomQueue.push([wrap, block]);
      if (behaviors.rooms(wrap).length) itemRoomQueue.push([wrap, block]);
      return wrap;
    }
    if (isVideo(block)) wrap.append(block.props.loop || block.props.decorative ? loopFigure(block) : videoFigure(block));
    else if (isAudio(block)) wrap.append(audioFigure(block));
    else if (isFreeObject(block)) wrap.append(renderObject(block));
    return wrap;
  }

  // A video the learner plays: its captions, its transcript; a silent one described by its alt
  // when it has no transcript.
  function videoFigure(block: VideoBlock): HTMLElement {
    const props = block.props;
    const described = !props.transcriptHtml && props.alt ? `t-alt-${block.id}` : undefined;
    return element('figure', { class: 't-figure' },
      listened(block, element('video', { controls: true, preload: 'metadata', poster: props.poster, title: props.title, 'aria-describedby': described },
        element('source', { src: props.src }),
        props.captions ? element('track', { kind: 'captions', src: props.captions, srclang: course.language, label: course.language, default: true }) : null)),
      element('figcaption', { text: props.title }),
      described ? element('p', { class: 't-sr-only', id: described, text: props.alt }) : null,
      props.generated ? element('p', { class: 't-genmark', text: labels.generated }) : null,
      transcript(props.transcriptHtml));
  }

  // A sound the learner plays, its player named by its title (as a video's), with its transcript. A
  // decorative one (an ambiance, music) carries no information: no transcript, even one left in its
  // props; the learner still starts it, so its player stays named and in reach.
  function audioFigure(block: AudioBlock): HTMLElement {
    const props = block.props;
    return element('figure', { class: 't-figure' },
      element('figcaption', { text: props.title }), listened(block, element('audio', { controls: true, preload: 'metadata', src: props.src, title: props.title })),
      props.generated ? element('p', { class: 't-genmark', text: labels.generated }) : null,
      props.decorative ? null : transcript(props.transcriptHtml));
  }

  // A loop, like an animated image: muted, starting by itself unless the learner prefers reduced
  // motion, with a button that pauses it (WCAG 2.2.2). Its alt names it as an image; a decorative
  // one is hidden from assistive technologies, its button is not.
  function loopFigure(block: VideoBlock): HTMLElement {
    const props = block.props;
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const video = element('video', {
      class: 't-loop', muted: true, loop: true, playsinline: true, autoplay: !still, preload: 'auto', poster: props.poster,
      'aria-hidden': props.decorative ? 'true' : undefined, role: props.decorative ? undefined : 'img', 'aria-label': props.decorative ? undefined : props.alt || undefined
    }, element('source', { src: props.src }));
    video.muted = true;
    const toggle = element('button', { type: 'button', class: 't-loop-toggle' });
    const sync = () => {
      toggle.dataset.state = video.paused ? 'paused' : 'playing';
      toggle.setAttribute('aria-label', video.paused ? labels.playAnimation : labels.pauseAnimation);
    };
    // What the button says, not video.paused: a loop that is still loading (or out of the window,
    // where Chrome holds it) is paused until it starts by itself; « pause » then keeps it still.
    toggle.addEventListener('click', () => {
      if (toggle.dataset.state === 'paused') void video.play().catch(sync);
      else video.pause();
      sync();
    });
    video.addEventListener('play', sync);
    video.addEventListener('pause', sync);
    toggle.dataset.state = still ? 'paused' : 'playing';
    toggle.setAttribute('aria-label', still ? labels.playAnimation : labels.pauseAnimation);
    return element('figure', { class: 't-figure t-figure--loop' },
      element('div', { class: 't-loop-frame' }, video, toggle),
      props.generated ? element('p', { class: 't-genmark', text: labels.generated }) : null);
  }

  // A sound or video the learner plays: it pauses the narration (two voices never overlap), and its
  // end fires media.ended.
  function listened<M extends HTMLMediaElement>(block: BlockData, media: M): M {
    media.addEventListener('play', () => {
      behaviors.dialogues.pauseAll();
      if (timeline?.playing) timeline.pause();
      for (const entry of layerTimelines.values()) if (entry.timeline.playing) entry.timeline.pause();
    });
    media.addEventListener('ended', () => trigger('media.ended', { target: block.id }));
    return media;
  }

  function transcript(html: string): HTMLElement | null {
    return html ? element('details', { class: 't-transcript' }, element('summary', { text: labels.transcript }), element('div', { class: 't-text', html })) : null;
  }

  // ── Free objects ──────────────────────────────────────────────────────
  // The host of a block's object, and whether it failed to load (shown with its text version).
  type BlockObjectHost = ObjectHost & { failed?: () => boolean };
  const hosts = new Map<string, BlockObjectHost>();
  // Frames follow the size class of the page (1rem): sent at initialize and when the window crosses one.
  const rootSize = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  let lastRootSize = rootSize();
  const onResize = () => {
    const px = rootSize();
    if (px === lastRootSize) return;
    lastRootSize = px;
    for (const host of hosts.values()) host.setRootSize(px);
    backdropHost?.setRootSize(px);
  };
  window.addEventListener('resize', onResize);
  // Undone when the screen changes, by block: observers and timers of objects and reserved rooms.
  const cleanups = new Map<string, (() => void)[]>();
  function cleanup(blockId: string, undo: () => void) {
    const list = cleanups.get(blockId);
    if (list) list.push(undo); else cleanups.set(blockId, [undo]);
  }
  function disposeHosts() {
    for (const host of hosts.values()) host.dispose();
    hosts.clear();
    for (const list of cleanups.values()) for (const undo of list) undo();
    cleanups.clear();
  }
  // A block that leaves the page: its object stops, its observers and timers end.
  function disposeBlock(blockId: string) {
    behaviors.dialogues.forget(blockId);
    hosts.get(blockId)?.dispose();
    hosts.delete(blockId);
    for (const undo of cleanups.get(blockId) || []) undo();
    cleanups.delete(blockId);
  }
  const SIDES = ['top', 'right', 'bottom', 'left'] as const;
  // Frames also move without a scroll, when content above them changes size (an image decoded, a
  // disclosure opened, a step revealed): the screen's size changes, and every frame measures again.
  const viewSyncs = new Set<() => void>();
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { for (const sync of viewSyncs) sync(); }).observe(main);
  // Where a frame is in the window, for objects that follow the scroll: the CSS view() timeline of
  // its box (object-protocol.ts, ObjectView). Rounded so that a still page sends nothing.
  function viewOf(node: HTMLElement): ObjectView {
    const box = node.getBoundingClientRect();
    const windowHeight = window.innerHeight || document.documentElement.clientHeight || 1;
    const height = Math.max(1, box.height);
    const contained = Math.min(height, windowHeight);
    const share = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
    return {
      visible: box.height > 0 && box.bottom > 0 && box.top < windowHeight,
      ratio: share((Math.min(box.bottom, windowHeight) - Math.max(box.top, 0)) / height),
      progress: share((windowHeight - box.top) / (windowHeight + height)),
      entry: share((windowHeight - box.top) / contained),
      exit: share((contained - box.bottom) / contained)
    };
  }

  function renderObject(block: ObjectBlock) {
    const props = block.props;
    const definition = course.objects[props.object];
    const descriptionId = uniqueId('desc');
    const iframe = element('iframe', {
      title: props.title, ...objectFrame(definition.dir, definition.permissions || [], framesPort, document.baseURI),
      allow: '', referrerpolicy: 'no-referrer', 'aria-describedby': descriptionId, loading: 'eager'
    });
    const error = element('p', { class: 't-object-error', role: 'alert', hidden: true, text: labels.objectError });
    const loading = element('div', { class: 't-object-loading', role: 'status', hidden: true }, element('span', { class: 't-object-spinner', 'aria-hidden': 'true' }), element('span', { text: labels.objectLoading }));
    // Safe area: the layout declares, with --t-safe-top/right/bottom/left, the part of the frame its
    // own content covers (a title floating over a stage); a hidden probe resolves it to px for the object.
    const safeProbe = element('div', { class: 't-object-safe', 'aria-hidden': 'true' });
    const frame = element('div', { class: 't-object-frame' }, iframe, loading, safeProbe);
    const textAlternative = element('details', { class: 't-text-alt' }, element('summary', { text: labels.textVersion }), element('div', { class: 't-text', html: props.textAlternativeHtml }));
    const figure = element('figure', { class: 't-object' }, frame, element('p', { id: descriptionId, class: 't-sr-only', text: props.a11y?.description || definition.a11y?.description || '' }), error, textAlternative);
    // Size: aspect ratio on wide containers, narrowAspectRatio under 640 px; auto = height requested
    // by the object (host.requestHeight), fill = height of the layout slot; min/max clamp.
    let requested: number | null = null;
    const clampHeight = (height: number) => Math.max(props.minHeight || 120, Math.min(props.maxHeight || 4000, Math.round(height)));
    const applySize = () => {
      const width = frame.clientWidth || figure.clientWidth;
      const ratio = (width > 0 && width < 640 && props.narrowAspectRatio) || props.aspectRatio || '16:9';
      frame.dataset.ratio = ratio;
      frame.style.aspectRatio = /^\d+:\d+$/.test(ratio) ? ratio.replace(':', ' / ') : 'auto';
      frame.style.height = ratio === 'auto' ? `${clampHeight(requested ?? props.minHeight ?? 420)}px` : ratio === 'fill' ? '100%' : '';
      frame.style.minHeight = props.minHeight ? `${props.minHeight}px` : ratio === 'fill' ? '320px' : '';
      frame.style.maxHeight = props.maxHeight ? `${props.maxHeight}px` : '';
    };
    let safe: SafeArea | null = null;
    const readSafe = (): SafeArea => {
      const style = getComputedStyle(safeProbe);
      return { top: Math.round(parseFloat(style.paddingTop) || 0), right: Math.round(parseFloat(style.paddingRight) || 0), bottom: Math.round(parseFloat(style.paddingBottom) || 0), left: Math.round(parseFloat(style.paddingLeft) || 0) };
    };
    const syncSafe = () => {
      if (!safeProbe.isConnected) return;
      const next = readSafe();
      const previous = safe;
      if (previous && SIDES.every((side) => next[side] === previous[side])) return;
      safe = next;
      host?.setSafeArea(safe);
    };
    applySize();
    // Where the frame is in the window: sent when it changes (scroll, resize, a step revealed), at
    // most once a frame. Scroll events of inner scrollers reach the window in the capture phase.
    let lastView = '';
    let viewFrame = 0;
    const syncView = () => {
      viewFrame = 0;
      if (!frame.isConnected || !host.ready) return;
      const next = viewOf(frame);
      const key = JSON.stringify(next);
      if (key === lastView) return;
      lastView = key;
      host.setView(next);
    };
    const queueView = () => { if (!viewFrame) viewFrame = requestAnimationFrame(syncView); };
    window.addEventListener('scroll', queueView, { passive: true, capture: true });
    window.addEventListener('resize', queueView);
    viewSyncs.add(queueView);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { applySize(); syncSafe(); queueView(); }) : null;
    observer?.observe(figure);
    let failed = false;
    let timedOut = false;
    // Without a GPU, an object may take seconds to start: after a moment, say it is loading.
    const loadingTimer = setTimeout(() => { if (!host.ready && !failed) { loading.hidden = false; figure.setAttribute('aria-busy', 'true'); } }, 400);
    const stopLoading = () => { clearTimeout(loadingTimer); loading.hidden = true; figure.removeAttribute('aria-busy'); };
    const fail = (message: string) => { failed = true; stopLoading(); error.hidden = false; textAlternative.open = true; if (message) console.warn(`[elabora] free object ${definition.id}: ${message}`); };
    const loadTimer = setTimeout(() => { if (!host.ready) { timedOut = true; fail('no answer from the object frame after 15 s'); } }, 15000);
    cleanup(block.id, () => {
      observer?.disconnect(); clearTimeout(loadTimer); clearTimeout(loadingTimer);
      window.removeEventListener('scroll', queueView, { capture: true }); window.removeEventListener('resize', queueView); viewSyncs.delete(queueView); cancelAnimationFrame(viewFrame);
    });
    const host: BlockObjectHost = createObjectHost({
      iframe, def: definition, props: props.props, strings: props.strings || {}, tokens: course.tokens, locale: course.language, fonts: course.fonts || [], rootSize: rootSize(),
      safeArea: () => { safe = safeProbe.isConnected ? readSafe() : { top: 0, right: 0, bottom: 0, left: 0 }; return safe; },
      view: () => { if (!frame.isConnected) return null; const now = viewOf(frame); lastView = JSON.stringify(now); return now; },
      reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false,
      savedState: courseState.objectSavedState(block.id), seed: 1,
      onEvent: (name, payload, declaration) => onObjectEvent(block, definition, host, name, payload, declaration),
      // Before the object answers, an error means it could not load: the text version opens. Once it
      // runs, errors are logged; the text version stays one click away.
      onError: (message) => (host.ready ? console.warn(`[elabora] free object ${definition.id}: ${message}`) : fail(message)),
      // An object slower than the timeout (a GPU-less machine) recovers when it finally answers.
      onReady: () => { clearTimeout(loadTimer); stopLoading(); queueView(); if (timedOut) { timedOut = false; failed = false; error.hidden = true; textAlternative.open = false; } },
      onResize: (height) => { requested = height; applySize(); },
      onLog: (entry) => console.info(`[elabora] free object ${definition.id}:`, entry.message)
    });
    host.failed = () => failed;
    hosts.set(block.id, host);
    return figure;
  }

  function onObjectEvent(block: ObjectBlock, definition: ObjectDefinition, host: ObjectHost, name: string, payload: unknown, declaration: ObjectEventDeclaration) {
    const tracking = declaration.tracking || {};
    const interaction = tracking.interaction;
    if (interaction) {
      const response = interaction.responseField ? fieldOf(payload, interaction.responseField) : name;
      const correct = interaction.correctField ? fieldOf(payload, interaction.correctField) : undefined;
      const single = typeof response === 'string' && /^[0-9a-z]$/.test(response);
      const type = interaction.type === 'choice' && !single ? 'performance' : interaction.type;
      recordInteraction({
        id: `${block.id}-${name}`.replace(/[^A-Za-z0-9_.-]/g, '-'), type, objective: interaction.objective, weight: block.props.weight || 1,
        response: typeof response === 'string' ? response : JSON.stringify(response), result: correct === undefined ? 'neutral' : correct ? 'correct' : 'wrong'
      });
    }
    if (tracking.completion) courseState.completeObject(block.id, tracking.score ? fieldOf(payload, tracking.score.field) : undefined);
    if (definition.persistMax) host.getState().then((state) => { courseState.saveObjectState(block.id, state, definition.persistMax); options.syncSoon(); }, () => {});
    trigger('object.event', { target: block.id, name, payload });
  }

  // ── Layers ────────────────────────────────────────────────────────────
  // The focused element, to give the focus back (HTML and SVG elements take it).
  const focusedElement = () => document.activeElement as (Element & HTMLOrSVGElement) | null;
  // Layers in the order they opened: hide-layer without a layer closes the one on top, a dialog
  // (modal, over everything) before a panel, the last opened first.
  let openedLayers: HTMLDialogElement[] = [];
  function topLayer(): HTMLDialogElement | undefined {
    openedLayers = openedLayers.filter((dialog) => dialog.isConnected && dialog.open);
    const dialogs = openedLayers.filter((dialog) => dialog.classList.contains('t-dialog'));
    const over = dialogs.length ? dialogs : openedLayers;
    return over[over.length - 1];
  }
  function openLayer(id: string) {
    const shown = screen;
    if (!shown) return;
    const layer = (shown.layers || []).find((candidate) => candidate.id === id);
    if (!layer || document.querySelector(`dialog.t-layer[data-layer="${id}"]`)) return;
    const titleId = uniqueId('layer');
    const panel = layer.presentation === 'panel';
    const back = focusedElement();
    const heading = element('h2', { id: titleId, class: 't-dialog-title', tabindex: panel ? '-1' : undefined, text: layer.title });
    // A layer with its own timeline (D62) has its compact bar next to Close.
    const bar = layer.narration && options.timeline ? element('div', { class: 't-layer-timeline' }) : null;
    const dialog: HTMLDialogElement = element('dialog', { class: `t-layer ${panel ? 't-panel' : 't-dialog'}`, 'data-layer': id, 'aria-labelledby': titleId, ...(bar ? { 'data-timeline': layer.narration!.seek } : {}) },
      heading,
      element('div', { class: 't-blocks' }, layer.blocks.map((block) => renderBlock(block))),
      element('div', { class: 't-dialog-actions' }, bar, element('button', { type: 'button', class: 't-btn t-btn--primary', onclick: () => dialog.close() }, labels.close)));
    roomQueue.length = 0; // a layer scrolls inside: its activities need no reserved room
    // A modal layer pauses the narration and its closing resumes it; a panel does not.
    const held = timeline;
    dialog.addEventListener('close', () => {
      stopLayerTimeline(id);
      dialog.remove();
      if (panel && back?.isConnected && !dialog.contains(back)) back.focus({ preventScroll: true });
      if (!panel && held === timeline) held?.release(`layer:${id}`);
      trigger('layer.closed', { target: id });
    });
    openedLayers.push(dialog);
    if (!panel) {
      held?.hold(`layer:${id}`);
      document.body.append(dialog);
      if (bar) startLayerTimeline(layer, dialog, false, bar);
      else behaviors.charts.at(null, dialog);
      dialog.showModal();
      flushRooms();
      behaviors.noteShown(dialog);
      return;
    }
    // A panel opens over part of the slide without blocking it (like a Storyline layer): the slide
    // stays usable, Escape or Close dismisses it and focus goes back where it was.
    dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); dialog.close(); } });
    main.append(dialog);
    if (bar) startLayerTimeline(layer, dialog, true, bar);
    else behaviors.charts.at(null, dialog);
    dialog.show();
    flushRooms();
    behaviors.noteShown(dialog);
    heading.focus({ preventScroll: true });
  }

  // ── Backdrop ──────────────────────────────────────────────────────────
  // Decoration behind every screen (theme.backdrop): layers painted by the theme stylesheet and an
  // optional decorative object, mounted once for the whole session. It follows the learner
  // (data-screen, data-section, data-step, data-variant; the object gets the same context) and is
  // never content: hidden from screen readers, out of the tab order, under the course.
  const backdrop = course.backdrop || null;
  const backdropElement = backdrop ? element('div', { class: 't-backdrop', 'aria-hidden': 'true', inert: true }, backdrop.layers.map((id) => element('div', { class: 't-backdrop-layer', 'data-layer': id }))) : null;
  let backdropHost: ObjectHost | null = null;
  // The context last applied, as JSON.
  let backdropSent = '';
  if (backdrop && backdropElement) {
    app.prepend(backdropElement);
    const decoration = backdrop.object;
    if (decoration && course.objects[decoration.object]) {
      const definition = course.objects[decoration.object];
      const iframe = element('iframe', { title: definition.id, ...objectFrame(definition.dir, [], framesPort, document.baseURI), allow: '', referrerpolicy: 'no-referrer', tabindex: '-1', loading: 'eager' });
      const holder = element('div', { class: 't-backdrop-object' }, iframe);
      backdropElement.append(holder);
      backdropHost = createObjectHost({
        iframe, def: definition, props: decoration.props, tokens: course.tokens, locale: course.language, fonts: course.fonts || [], rootSize: rootSize(),
        reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false, decorative: true, context: backdropContext, seed: 1,
        onError: (message) => { if (!backdropHost?.ready) holder.hidden = true; console.warn(`[elabora] backdrop ${definition.id}: ${message}`); },
        onLog: (entry) => console.info(`[elabora] backdrop ${definition.id}:`, entry.message)
      });
    }
  }
  function backdropContext(): ObjectContext {
    return { screen: screen?.id || null, section: screen?.section || null, step: revealed, variant: screen?.backdrop || null };
  }
  function updateBackdrop() {
    if (!backdropElement) return;
    const context = backdropContext();
    const key = JSON.stringify(context);
    if (key === backdropSent) return;
    backdropSent = key;
    for (const name of ['screen', 'section', 'step', 'variant'] as const) {
      const value = context[name];
      if (value == null) delete backdropElement.dataset[name]; else backdropElement.dataset[name] = String(value);
    }
    const off = context.variant === 'none';
    backdropElement.hidden = off;
    if (!backdropHost) return;
    if (off) backdropHost.pause();
    else { backdropHost.resume(); backdropHost.setContext(context); }
  }

  // ── Updating in place (the editor canvas) ─────────────────────────────
  // New data for the screen shown: blocks whose data did not change keep their node (a free object
  // keeps running, a video keeps its frame), a component instance whose own data did not change
  // keeps its node and gets its slots refilled, other blocks are rendered again. Nodes move with
  // moveBefore where the browser has it, so frames are not reloaded. The step reached and the open
  // layers are kept. Blocks in dirty are rendered again whatever their data (a file they use
  // changed). Returns the nodes rendered anew.
  function update(next: ScreenData, dirty: ReadonlySet<string> = new Set()): HTMLElement[] {
    const previous = screen;
    const article = main.querySelector<HTMLElement>(':scope > article.t-screen');
    if (!previous || !article || previous.id !== next.id) { leave(); show(next); return [...main.querySelectorAll<HTMLElement>('.t-block[data-block]')]; }
    // The blocks shown now (screen and open layers), with the data they were rendered from.
    const nodes = new Map<string, HTMLElement>();
    for (const node of document.querySelectorAll<HTMLElement>('#t-main .t-block[data-block], dialog.t-layer .t-block[data-block]')) nodes.set(node.dataset.block ?? '', node);
    const before = new Map<string, BlockData>();
    for (const block of [...flatBlocks(previous.blocks), ...previous.layers.flatMap((layer) => flatBlocks(layer.blocks))]) before.set(block.id, block);
    const plans = new Map<string, Plan>();
    const kept = new Set<string>();
    // Where a block goes (its slot) and when (its step) do not change its node: placing and
    // applySteps take care of them, so a block moved to another slot keeps running.
    const rendering = (block: BlockData, children = true) => ({ ...block, slot: undefined, step: undefined, timing: undefined, ...(children ? {} : { blocks: undefined }) });
    const planOf = (block: BlockData) => {
      const old = before.get(block.id);
      const reusable = !!old && nodes.has(block.id) && !dirty.has(block.id);
      const clean = !flatBlocks(block.blocks).some((child) => dirty.has(child.id));
      if (reusable && clean && same(rendering(old), rendering(block))) { plans.set(block.id, 'reuse'); for (const id of [block.id, ...flatBlocks(block.blocks).map((child) => child.id)]) kept.add(id); return; }
      const keep = reusable && block.html != null && same(rendering(old, false), rendering(block, false));
      plans.set(block.id, keep ? 'keep' : 'new');
      if (keep) kept.add(block.id);
      for (const child of block.blocks || []) planOf(child);
    };
    for (const block of [...next.blocks, ...next.layers.flatMap((layer) => layer.blocks)]) planOf(block);
    // Blocks rendered again or gone stop before anything is rendered (hosts are kept by block id).
    for (const id of before.keys()) if (!kept.has(id)) disposeBlock(id);
    screen = next;

    const fresh: HTMLElement[] = [];
    const placed = new Map<string, HTMLElement>();
    const wanted = new Map<HTMLElement, HTMLElement[]>();
    const slotted: HTMLElement[] = [];
    const nodeFor = (block: BlockData): HTMLElement => {
      const plan = plans.get(block.id);
      let node = plan === 'reuse' || plan === 'keep' ? nodes.get(block.id) : undefined;
      if (!node) { node = blockShell(block); fresh.push(node); }
      placed.set(block.id, node);
      return node;
    };
    // Places the blocks of a host (in its slots, or in a column), then the blocks of their slots.
    // Nodes are only moved here: what a container no longer holds leaves once everything is placed,
    // so a node going to another container moves there without leaving the page.
    const fill = (host: HTMLElement, blocks: readonly BlockData[], defaultSlot: string | null | undefined, column: HTMLElement | null) => {
      const slots = column ? new Map<string, HTMLElement>() : slotsOf(host);
      slotted.push(...slots.values());
      const lists = new Map<HTMLElement, HTMLElement[]>(column ? [[column, []]] : [...[...slots.values(), host].map((container) => [container, []] as [HTMLElement, HTMLElement[]])]);
      for (const block of blocks) lists.get(column || slotFor(slots, host, block, defaultSlot))?.push(nodeFor(block));
      for (const [container, list] of lists) { arrange(container, list); wanted.set(container, list); }
      for (const block of blocks) {
        const node = placed.get(block.id);
        if (node && plans.get(block.id) !== 'reuse' && block.html != null && (block.blocks?.length || block.defaultSlot)) fill(node, block.blocks || [], block.defaultSlot, null);
      }
    };
    // The article: kept when the screen's own data is the same, otherwise a new one next to it.
    const own = (shown: ScreenData) => ({ ...shown, blocks: undefined, layers: undefined, events: undefined, key: undefined, covers: undefined, completeWhen: undefined, required: undefined, continueRevealsSteps: undefined, backdrop: undefined });
    let target = article;
    if (!same(own(previous), own(next))) {
      target = screenArticle(next);
      article.after(target);
    }
    if (next.layout) fill(target, next.blocks, next.layout.defaultSlot, null);
    else {
      let column = target.querySelector<HTMLElement>(':scope > .t-blocks');
      if (!column) { column = element('div', { class: 't-blocks' }); target.append(column); }
      fill(target, next.blocks, null, column);
    }
    // Open layers: refilled, or closed when the layer is gone or changed (the canvas opens it again).
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog.t-layer')) {
      const id = dialog.dataset.layer ?? '';
      const layer = next.layers.find((candidate) => candidate.id === id);
      const old = previous.layers.find((candidate) => candidate.id === id);
      const column = dialog.querySelector<HTMLElement>(':scope > .t-blocks');
      if (layer && old && column && layer.title === old.title && layer.presentation === old.presentation && same(layer.narration ?? null, old.narration ?? null)) {
        fill(dialog, layer.blocks, null, column);
        // Its timed blocks follow the playhead again (blocks rendered anew get their effects).
        const entry = layerTimelines.get(id);
        if (entry) {
          entry.timed?.dispose();
          const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
          entry.timed = createTimedBlocks(dialog, layer.blocks, { reducedMotion, onChange: (node) => { syncInert(node); behaviors.noteShown(dialog); } });
          entry.timed.apply(entry.timeline.time);
        }
      } else { stopLayerTimeline(id); dialog.remove(); }
    }
    for (const [container, list] of wanted) for (const child of [...container.children]) if (child instanceof HTMLElement && isBlockNode(child) && !list.includes(child)) child.remove();
    if (target !== article) article.remove();
    for (const node of slotted) node.toggleAttribute('data-empty', !node.children.length);
    // Kept blocks that left the page with a closed layer stop too.
    for (const id of kept) if (!placed.get(id)?.isConnected && !nodes.get(id)?.isConnected) disposeBlock(id);
    // A layer scrolls inside: its activities need no reserved room.
    roomQueue.splice(0, roomQueue.length, ...roomQueue.filter(([wrap]) => !wrap.closest('dialog')));
    flushRooms();
    steps = stepsOf(next);
    revealed = reachedStep(revealed);
    if (JSON.stringify(previous.narration) !== JSON.stringify(next.narration)) {
      const at = timeline?.time;
      startTimeline(next, { autoplay: false });
      if (at !== undefined) timeline?.showAt(Math.min(at, timeline.duration));
    } else {
      forgetThemeKeyframes();
      startTimedBlocks(next);
    }
    applySteps();
    updateBackdrop();
    behaviors.dialogues.afterShow();
    return fresh;
  }

  return {
    get screen() { return screen; },
    get revealed() { return revealed; },
    get steps() { return steps; },
    lastStep, nextStep, reachedStep, opensWithContinue, shownStep,
    leave, show, update,
    trigger, revealStep, focusStep, applySteps,
    // Shows the screen as it is at step n (may go back to an earlier step); a narrated screen waits
    // at the start of that step.
    reveal(step: number) {
      revealed = reachedStep(step);
      const segment = screen?.narration?.segments.find((candidate) => candidate.step === revealed);
      if (timeline && segment) timeline.showAt(segment.start);
      applySteps();
    },
    get timeline() { return timeline; },
    // A narrated screen as it is when a line starts (or ends): its step reached, its caption shown
    // (captions on); nothing fires. False without that line.
    showLine(line: string, { edge = 'start', captions = true }: { edge?: 'start' | 'end'; captions?: boolean } = {}): boolean {
      const found = screen?.narration?.lines.find((candidate) => candidate.id === line);
      if (!timeline || !found) return false;
      if (found.step > revealed) revealStep(reachedStep(found.step), { animate: false, focus: false, play: false });
      if (captions) timeline.prefs.captions = true;
      timeline.showAt(edge === 'end' ? Math.max(found.start, found.end - 0.05) : found.start + 0.01);
      applySteps();
      return true;
    },
    // A timed screen as it is at a time (seconds on its timeline): the steps it falls in reached,
    // the captions shown (captions on); nothing fires. False without a timeline.
    showTime(time: number, { captions = true }: { captions?: boolean } = {}): boolean {
      const segments = screen?.narration?.segments ?? [];
      if (!timeline || !segments.length) return false;
      const into = [...segments].reverse().find((segment) => segment.start <= time + 1e-6) ?? segments[0];
      if (into.step > revealed) revealStep(reachedStep(into.step), { animate: false, focus: false, play: false });
      if (captions) timeline.prefs.captions = true;
      timeline.showAt(Math.max(0, Math.min(time, timeline.duration)));
      applySteps();
      return true;
    },
    get timed() { return timed; },
    // The timeline of an open layer (D62), and its timed blocks.
    layerTimeline: (layer: string) => layerTimelines.get(layer)?.timeline ?? null,
    layerTimed: (layer: string) => layerTimelines.get(layer)?.timed ?? null,
    get layerTimelines() { return [...layerTimelines.keys()]; },
    // An open layer as it is at a time on its timeline, or when one of its lines starts (or ends):
    // its caption shown (captions on); nothing fires. False without that timeline or line.
    showLayerTime(layer: string, time: number, { captions = true }: { captions?: boolean } = {}): boolean {
      const entry = layerTimelines.get(layer);
      if (!entry) return false;
      if (captions) entry.timeline.prefs.captions = true;
      entry.timeline.showAt(Math.max(0, Math.min(time, entry.timeline.duration)));
      return true;
    },
    showLayerLine(layer: string, line: string, { edge = 'start', captions = true }: { edge?: 'start' | 'end'; captions?: boolean } = {}): boolean {
      const entry = layerTimelines.get(layer);
      const at = entry?.timeline.lineAt(line, edge);
      if (!entry || at === null || at === undefined) return false;
      const start = entry.timeline.lineAt(line, 'start') ?? at;
      if (captions) entry.timeline.prefs.captions = true;
      entry.timeline.showAt(edge === 'end' ? Math.max(start, at - 0.05) : at + 0.01);
      return true;
    },
    // Next waits until the narrated step has been heard (navigation.lockUntilComplete).
    listening,
    // Next (in slides) waits until the blocks above a step that opens once explored are (D63), and says what is left.
    exploreLocked, exploreReason,
    openLayer, showAnswered, feedbackRooms,
    // Heights of an activity of the screen: as it is now, then once answered, outcome by outcome.
    rooms(blockId: string) { const node = main.querySelector<HTMLElement>(`[data-block="${blockId}"]`); const block = courseState.blockIndex.get(blockId)?.block; return node && block ? outcomeRooms(node, block) : null; },
    objectHost: (blockId: string) => hosts.get(blockId),
    refreshResults: () => behaviors.refreshResults(),
    // The dialogues of the screen (D61): their state, the editor's paths, the tests' clock.
    get dialogues() { return behaviors.dialogues; },
    // The transcript's panel (the narration's, or the one of a screen whose layers or dialogues speak).
    transcript(open: boolean) { if (timeline) timeline.transcript(open); else transcriptBar?.toggle(open); },
    updateBackdrop,
    dispose: disposeHosts,
    // Closes the open layers but one, without their events (the canvas shows the layer asked for).
    closeLayers(except: string | null = null) {
      for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog.t-layer')) {
        if (dialog.dataset.layer === except) continue;
        for (const node of dialog.querySelectorAll<HTMLElement>('.t-block[data-block]')) disposeBlock(node.dataset.block ?? '');
        dialog.remove();
      }
    },
    get layers() { return [...document.querySelectorAll<HTMLDialogElement>('dialog.t-layer')].map((dialog) => dialog.dataset.layer ?? ''); },
    // Everything the view put in the page goes (the canvas mounts a course again).
    destroy() {
      behaviors.dialogues.dispose();
      transcriptBar?.dispose();
      disposeHosts();
      backdropHost?.dispose();
      backdropElement?.remove();
      for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog.t-layer')) dialog.remove();
      window.removeEventListener('resize', onResize);
    },
    // Resolves when the fonts are loaded, the images of the screen decoded and its free objects
    // answered (or failed), and the layout has settled (reserved rooms measured again): previews,
    // screenshots and fit checks wait for it instead of a fixed delay.
    async ready(timeout = 20000) {
      const begin = Date.now();
      const images = [...document.querySelectorAll<HTMLImageElement>('#t-main img, dialog img')];
      for (const image of images) image.loading = 'eager';
      await Promise.all(images.map((image) => (image.complete ? null : new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); setTimeout(resolve, timeout); }))));
      // Loaded is not drawn: a large photograph (a band, a cover) is decoded first, or a capture of
      // the whole page may find its place still empty.
      await Promise.all(images.map((image) => (image.complete && image.naturalWidth ? image.decode().catch(() => {}) : null)));
      await Promise.race([document.fonts?.ready, new Promise((resolve) => setTimeout(resolve, timeout))]);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      for (const fit of roomFits) fit();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      while ([...hosts.values()].some((host) => !host.ready && !host.failed?.()) && Date.now() - begin < timeout) await new Promise((resolve) => setTimeout(resolve, 100));
      return { images: images.length, objects: [...hosts.entries()].map(([id, host]) => ({ block: id, ready: host.ready, failed: !!host.failed?.() })) };
    }
  };
}

// Same data (the compiler writes block and screen data in a fixed key order).
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const isBlockNode = (node: Element): boolean => node.matches('.t-block[data-block]');

// Puts nodes in a container in order, before the blocks it no longer holds and after its other
// content: moved only when out of place, with moveBefore when the browser has it (an iframe moved
// with it keeps running; insertBefore would load it again).
type MovableParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
function arrange(container: MovableParent, nodes: readonly HTMLElement[]) {
  nodes.forEach((node, index) => {
    const current = [...container.children].filter(isBlockNode);
    if (current[index] === node) return;
    const before = current[index] ?? null;
    if (container.moveBefore && node.isConnected && container.isConnected) container.moveBefore(node, before);
    else container.insertBefore(node, before);
  });
}

// The learner's voice settings where no narration's bar keeps them (the canvas without bars).
const FALLBACK_PREFS = { rate: 1, volume: 1, muted: false };
