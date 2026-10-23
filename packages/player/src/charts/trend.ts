// trend (D60): the line draws itself from left to right, its value riding at its head; the note
// appears when the head reaches its year; the end dot lands. With a voice, the head goes to each
// point as the voice names it. Pointing at the plot shows the year's knob and value, softly.
//
// Predict mode: the line stops at predict.from. The learner draws the rest in the zone (pointer) or
// sets it with the slider under the chart (keys, screen readers), then presses the button: the real
// line draws over the guess, and the feedback names both values. The guess is kept like a numeric
// answer (course-state answerPredict), so a resumed screen shows it revealed.
//
// Geometry comes from the core (props.points: px and py, fractions of the plot from its top left):
// the player computes the same monotone curve, so what rides the line stays on it.

import type { PredictBlock } from '../course-data.ts';
import { hasBehavior } from '../course-state.ts';
import type { ChartDom, ChartView } from './view.ts';
import { writtenText } from './view.ts';
import { clamp01, easeInOut, easeOut, monotonePath, monotoneY, play, prefersLessMotion } from './kit.ts';
import type { XY } from './kit.ts';

const W = 1000, H = 360; // the core's viewBox
const HEAD_SECONDS = 1.2; // the head's move to a point the voice names
const REVEAL_SECONDS = 1.4;

interface Trend {
  points: XY[];
  values: number[];
  xs: (number | string)[];
  domain: [number, number];
  box: HTMLElement;
  line: SVGPathElement | null;
  area: SVGPathElement | null;
  guessPath: SVGPathElement | null;
  start: HTMLElement | null;
  dot: HTMLElement | null;
  end: HTMLElement | null;
  note: { element: HTMLElement; x: number } | null;
  rest: Map<HTMLElement, { left: string; top: string }>;
  // Predict mode.
  predict: PredictBlock['props']['predict'] | null;
  from: number;
  revealed: boolean;
  guesses: Map<number, number>;
  zone: HTMLElement | null;
  guessLabel: HTMLElement | null;
  ask: { button: HTMLButtonElement | null; range: HTMLInputElement | null; feedback: HTMLElement | null } | null;
  revealing: { stop(): void } | null;
}
const trends = new WeakMap<HTMLElement, Trend>();

function trendOf(dom: ChartDom): Trend {
  const known = trends.get(dom.root);
  if (known) return known;
  const props = dom.block.props;
  const raw = props.points ?? [];
  const box = dom.root.querySelector<HTMLElement>('.t-trend-area-box') ?? dom.body;
  const end = dom.root.querySelector<HTMLElement>('.t-trend-end');
  const dot = dom.root.querySelector<HTMLElement>('.t-trend-dot');
  const noteElement = dom.root.querySelector<HTMLElement>('.t-trend-note');
  const noteIndex = Number(noteElement?.dataset.tAt?.slice(1));
  const predict = hasBehavior(dom.block, 'predict') ? dom.block.props.predict : null;
  const rest = new Map<HTMLElement, { left: string; top: string }>();
  for (const element of [end, dot]) if (element) rest.set(element, { left: element.style.left, top: element.style.top });
  // The last value as the core wrote it, kept before the head writes others.
  if (end) writtenText(end);
  const ask = dom.root.querySelector<HTMLElement>('.t-trend-ask');
  const trend: Trend = {
    points: raw.map((point) => ({ x: point.px, y: point.py })),
    values: raw.map((point) => point.y),
    xs: raw.map((point) => point.x),
    domain: props.domain ?? [0, 1],
    box,
    line: dom.root.querySelector('.t-trend-line'),
    area: dom.root.querySelector('.t-trend-area'),
    guessPath: dom.root.querySelector('.t-trend-guess'),
    start: dom.root.querySelector('.t-trend-start'),
    dot, end,
    note: noteElement && Number.isFinite(noteIndex) && raw[noteIndex] ? { element: noteElement, x: raw[noteIndex].px } : null,
    rest,
    predict,
    from: predict ? predict.from : raw.length - 1,
    revealed: !predict,
    guesses: new Map(),
    zone: dom.root.querySelector('.t-trend-zone'),
    guessLabel: dom.root.querySelector('.t-trend-guess-label'),
    ask: ask ? { button: ask.querySelector('.t-trend-reveal'), range: ask.querySelector('.t-trend-range'), feedback: ask.querySelector('.t-trend-feedback') } : null,
    revealing: null
  };
  trends.set(dom.root, trend);
  return trend;
}

const valueOf = (trend: Trend, fy: number) => trend.domain[0] + (1 - fy) * (trend.domain[1] - trend.domain[0]);
const fyOf = (trend: Trend, value: number) => 1 - (value - trend.domain[0]) / (trend.domain[1] - trend.domain[0] || 1);
const pct = (fraction: number) => `${Math.round(fraction * 100000) / 1000}%`;
// How far the line may draw now: to the last point, or to the last one shown before the guess.
const reach = (trend: Trend) => (trend.revealed ? 1 : trend.points[trend.from]?.x ?? 1);

// The line and its area drawn up to x (a fraction of the plot), the dot and the value at its head.
function drawTo(dom: ChartDom, trend: Trend, x: number, { atRest = false } = {}): void {
  const clip = x >= 1 ? '' : `inset(-20% ${pct(1 - x)} -20% -2%)`;
  if (trend.line) trend.line.style.clipPath = clip;
  if (trend.area) trend.area.style.clipPath = clip;
  const y = monotoneY(trend.points, x);
  const last = trend.points.length - 1;
  const settled = atRest && x >= 1;
  for (const element of [trend.dot, trend.end]) {
    if (!element) continue;
    const rest = trend.rest.get(element)!;
    element.style.left = settled ? rest.left : pct(x);
    element.style.top = settled ? rest.top : pct(y);
  }
  if (trend.end) {
    const index = trend.points.findIndex((point) => Math.abs(point.x - x) < 1e-6);
    // On a point, the value the core wrote for it; between two, the line's value at the head.
    trend.end.textContent = settled || index === last ? writtenText(trend.end) : dom.format_(index >= 0 ? trend.values[index] : valueOf(trend, y));
  }
  if (trend.note) {
    // It fades in over the next 5 % of the width once the head reaches its year.
    const shown = x + 1e-6 >= trend.note.x ? clamp01(0.3 + (x - trend.note.x) / 0.05) : 0;
    trend.note.element.style.opacity = shown >= 1 ? '' : String(shown);
    trend.note.element.style.translate = shown >= 1 ? '' : `${(1 - easeOut(shown)) * -0.4}rem 0`;
  }
}

// The chart at rest: all of it, or (predict, before the reveal) up to the last point shown.
function settle(dom: ChartDom, trend: Trend): void {
  drawTo(dom, trend, reach(trend), { atRest: true });
  for (const element of [trend.start, trend.dot, trend.end]) if (element) { element.style.opacity = ''; element.style.translate = ''; }
}

// ── predict ──
function guessPoints(trend: Trend): XY[] {
  const from = trend.points[trend.from];
  const out: XY[] = [from];
  for (let index = trend.from + 1; index < trend.points.length; index++) {
    const value = trend.guesses.get(index);
    if (value !== undefined) out.push({ x: trend.points[index].x, y: fyOf(trend, value) });
  }
  return out;
}
function drawGuess(dom: ChartDom, trend: Trend): void {
  const points = guessPoints(trend);
  trend.guessPath?.setAttribute('d', points.length > 1 ? monotonePath(points.map((point) => ({ x: point.x * W, y: point.y * H }))) : '');
  dom.root.classList.toggle('has-guess', points.length > 1);
  const label = trend.guessLabel;
  if (label) {
    label.hidden = points.length < 2;
    const tip = points[points.length - 1];
    label.style.left = pct(tip.x);
    label.style.top = pct(tip.y);
    const value = trend.guesses.size ? trend.guesses.get(Math.max(...trend.guesses.keys())) : undefined;
    label.textContent = value === undefined ? dom.labels.predictYours : `${dom.labels.predictYours} · ${dom.format_(value)}`;
  }
  const complete = guessPoints(trend).length === trend.points.length - trend.from;
  if (trend.ask?.button) trend.ask.button.disabled = !complete || trend.revealed;
}
// The slider sets the last year's guess; the years between follow a straight line from the last known one.
function guessFromEnd(trend: Trend, value: number): void {
  const from = trend.points[trend.from], start = trend.values[trend.from];
  for (let index = trend.from + 1; index < trend.points.length; index++) {
    const share = (trend.points[index].x - from.x) / ((trend.points[trend.points.length - 1].x - from.x) || 1);
    trend.guesses.set(index, start + (value - start) * share);
  }
}
function feedbackText(dom: ChartDom, trend: Trend, guess: number, close: boolean): string {
  const actual = trend.values[trend.values.length - 1];
  const text = (close ? trend.predict?.close : trend.predict?.far) ?? (close ? dom.labels.predictClose : dom.labels.predictFar);
  return dom.context.formatLabel(text, { guess: dom.format_(guess), actual: dom.format_(actual) });
}
function showRevealed(dom: ChartDom, trend: Trend, guess: number, close: boolean, withFeedback = true): void {
  trend.revealed = true;
  dom.root.classList.add('is-revealed');
  dom.root.classList.toggle('is-close', close);
  if (trend.ask?.button) { trend.ask.button.hidden = true; trend.ask.button.disabled = true; }
  if (trend.ask?.range) trend.ask.range.disabled = true;
  if (trend.ask?.feedback && withFeedback) trend.ask.feedback.textContent = feedbackText(dom, trend, guess, close);
  if (trend.zone) trend.zone.inert = true;
  drawGuess(dom, trend);
}
function reveal(dom: ChartDom, trend: Trend): void {
  if (trend.revealed || !trend.predict) return;
  const last = trend.points.length - 1;
  const decimals = dom.format.decimals ?? 0;
  const guess = Math.round((trend.guesses.get(last) ?? NaN) * 10 ** decimals) / 10 ** decimals;
  const result = dom.context.courseState.answerPredict(dom.block.id, guess);
  if (!result) return;
  const predict = trend.predict;
  dom.context.recordInteraction({
    id: dom.block.id, type: 'numeric', objective: predict.objective, weight: predict.weight || 1,
    response: String(guess), correctPattern: String(result.actual),
    // Not scored (the default): a moment of engagement, recorded without right or wrong.
    result: predict.scored ? (result.close ? 'correct' : 'wrong') : 'neutral'
  });
  dom.context.trigger('quiz.submitted', { target: dom.block.id, correct: result.close });
  const from = trend.points[trend.from].x;
  showRevealed(dom, trend, guess, result.close, false);
  // The feedback is said once the line has arrived.
  const done = () => { trend.revealing = null; settle(dom, trend); if (trend.ask?.feedback) trend.ask.feedback.textContent = feedbackText(dom, trend, guess, result.close); };
  if (prefersLessMotion() || dom.context.still) { done(); return; }
  // The real line draws over the guess, from the last known year to the end.
  const run = play(REVEAL_SECONDS, easeInOut, (p) => drawTo(dom, trend, from + (1 - from) * p), { delay: 0.1 });
  trend.revealing = run;
  void run.done.then(done);
}

export const trendView: ChartView = {
  // The whole entrance is the line drawing (frame); points are only knobs for the pointer.
  entrance: { frame: 1.6, item: 0.01, stagger: 0 },
  before(dom) {
    const trend = trendOf(dom);
    drawTo(dom, trend, 0);
    for (const element of [trend.start, trend.dot, trend.end]) if (element) element.style.opacity = '0';
  },
  frame(dom, p) {
    const trend = trendOf(dom);
    if (p >= 1) { settle(dom, trend); return; }
    const e = easeInOut(clamp01(p / 0.92));
    drawTo(dom, trend, e * reach(trend));
    const fade = (element: HTMLElement | null, value: number) => { if (element) element.style.opacity = String(clamp01(value)); };
    fade(trend.start, p * 5);
    fade(trend.end, p * 4 - 0.2);
    // The dot is the pen: it draws the line, its value beside it.
    fade(trend.dot, p * 6);
  },
  reveal() {},
  // With a voice: the head goes to each point as the voice names it, then to the end once the voice is done.
  beat(dom, time, beats, ends) {
    const trend = trendOf(dom);
    if (dom.block.props.revealOnBeats === false) { settle(dom, trend); return; }
    const timed = Object.entries(beats)
      .map(([id, at]) => ({ x: trend.points[Number(id.slice(1))]?.x, at }))
      .filter((beat): beat is { x: number; at: number } => beat.x !== undefined)
      .sort((a, b) => a.at - b.at);
    if (!timed.length) { settle(dom, trend); return; }
    timed.push({ x: reach(trend), at: ends });
    const seconds = prefersLessMotion() ? 1e-3 : HEAD_SECONDS;
    let head = 0;
    for (const beat of timed) {
      if (time < beat.at) break;
      const target = Math.min(beat.x, reach(trend));
      head += (target - head) * easeInOut(clamp01((time - beat.at) / seconds));
    }
    if (trend.revealing) return;
    const started = time >= timed[0].at;
    for (const element of [trend.start, trend.dot, trend.end]) if (element) element.style.opacity = started ? '' : '0';
    if (head >= reach(trend) - 1e-6) settle(dom, trend); else drawTo(dom, trend, head);
  },
  enabled(dom, id) {
    const trend = trendOf(dom);
    return trend.revealed || Number(id.slice(1)) <= trend.from;
  },
  // The year nearest the pointer, over the plot (not in the zone where the guess is drawn).
  pick(dom, event) {
    const trend = trendOf(dom);
    const rect = trend.box.getBoundingClientRect();
    if (!rect.width || event.clientY < rect.top - 32 || event.clientY > rect.bottom + 40) return null;
    const x = (event.clientX - rect.left) / rect.width;
    if (!trend.revealed && x > trend.points[trend.from].x + 0.02) return null;
    let best = -1, distance = Infinity;
    trend.points.forEach((point, index) => {
      if (!trend.revealed && index > trend.from) return;
      const d = Math.abs(point.x - x);
      if (d < distance) { distance = d; best = index; }
    });
    return best < 0 ? null : `p${best}`;
  },
  setup(dom) {
    const trend = trendOf(dom);
    if (!trend.predict) return;
    const { zone, ask } = trend;
    const last = trend.points.length - 1;
    const hint = zone?.querySelector<HTMLElement>('.t-trend-hint');
    if (hint && !hint.textContent?.trim()) hint.textContent = dom.labels.predictHint;
    if (ask?.button && !ask.button.textContent?.trim()) ask.button.textContent = dom.labels.predictReveal;
    if (ask?.feedback) { ask.feedback.setAttribute('role', 'status'); ask.feedback.setAttribute('aria-live', 'polite'); }
    if (ask?.range) {
      ask.range.setAttribute('aria-label', dom.context.formatLabel(dom.labels.predictSlider, { x: String(trend.xs[last]) }));
      ask.range.value = String(trend.values[trend.from]);
    }
    const saved = dom.context.courseState.predictState(dom.block as PredictBlock);
    if (saved !== null) {
      guessFromEnd(trend, saved);
      showRevealed(dom, trend, saved, dom.context.courseState.predictClose(dom.block as PredictBlock, saved));
      return;
    }
    const listeners: (() => void)[] = [];
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | null | undefined, type: K, listener: (event: HTMLElementEventMap[K]) => void) => {
      if (!target) return;
      target.addEventListener(type, listener);
      listeners.push(() => target.removeEventListener(type, listener));
    };
    // Drawing: each year takes the pointer's height; a drag fills the years it crosses.
    let drawing = false, lastIndex: number | null = null;
    const put = (event: PointerEvent) => {
      const rect = trend.box.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = (event.clientX - rect.left) / rect.width;
      const fy = clamp01((event.clientY - rect.top) / rect.height);
      let index = trend.from + 1, distance = Infinity;
      for (let candidate = trend.from + 1; candidate <= last; candidate++) {
        const d = Math.abs(trend.points[candidate].x - x);
        if (d < distance) { distance = d; index = candidate; }
      }
      const value = valueOf(trend, fy);
      const fromIndex = lastIndex ?? index;
      for (let k = Math.min(fromIndex, index); k <= Math.max(fromIndex, index); k++) trend.guesses.set(k, value);
      lastIndex = index;
      if (ask?.range && trend.guesses.has(last)) ask.range.value = String(trend.guesses.get(last));
      drawGuess(dom, trend);
    };
    on(zone, 'pointerdown', (event) => { if (trend.revealed) return; drawing = true; lastIndex = null; zone!.setPointerCapture(event.pointerId); put(event); event.preventDefault(); });
    on(zone, 'pointermove', (event) => { if (drawing) put(event); });
    on(zone, 'pointerup', () => { drawing = false; });
    on(zone, 'pointercancel', () => { drawing = false; });
    on(ask?.range, 'input', () => {
      if (trend.revealed || !ask?.range) return;
      guessFromEnd(trend, Number(ask.range.value));
      ask.range.setAttribute('aria-valuetext', dom.format_(Number(ask.range.value)));
      drawGuess(dom, trend);
    });
    on(ask?.button, 'click', () => reveal(dom, trend));
    drawGuess(dom, trend);
    return () => { trend.revealing?.stop(); for (const off of listeners) off(); };
  },
  // Slides reserve the room of the revealed chart: a close guess and a far one (the longer feedback).
  outcomes(dom) {
    const trend = trendOf(dom);
    if (!trend.predict) return [];
    const actual = trend.values[trend.values.length - 1];
    const far = actual + (trend.domain[1] - trend.domain[0]) / 2;
    return [actual, far].map((guess) => () => {
      guessFromEnd(trend, guess);
      showRevealed(dom, trend, guess, guess === actual);
      settle(dom, trend);
    });
  }
};
