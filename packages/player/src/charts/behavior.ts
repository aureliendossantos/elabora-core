// The chart behaviour (D60): moves the markup the core drew (charts/frame.ts names its hooks).
//
// Everything a chart shows is a function of a time: its entrance's own time when it plays by itself
// (the first time it is shown and in view), the screen's timeline when the voice brings its items
// (beats). So a seek back hides what had not come yet, a capture at a time is exact, and the editor's
// canvas shows the chart at the time its timeline shows. Pointing at an item (pointer, tap, arrow
// keys) is separate: CSS transitions, soothing.

import type { ChartBlock, PredictBlock, TriggerType } from '../course-data.ts';
import type { Labels } from '../labels.ts';
import type { Interaction } from '../scorm12.ts';
import type { CourseState, TriggerInfo } from '../course-state.ts';
import { clamp01, createFocus, createTip, formatValue, prefersLessMotion, animationFrameClock } from './kit.ts';
import type { NumberFormat, Tip } from './kit.ts';
import { VIEWS, defaultView } from './views.ts';
import type { ChartDom, ChartView } from './view.ts';

export interface ChartsContext {
  courseState: CourseState;
  labels: Labels;
  language: string;
  formatLabel(label: string, values: Readonly<Record<string, unknown>>): string;
  announce(message: string): void;
  recordInteraction(interaction: Interaction): void;
  trigger(type: TriggerType, info: TriggerInfo): void;
  // The editor's canvas: charts are shown at rest (or at the timeline's time), never replayed.
  still?: boolean;
}

interface Bound {
  wrap: HTMLElement;
  dom: ChartDom;
  view: ChartView;
  // Its own entrance: not started, playing, done.
  entrance: 'waiting' | 'playing' | 'done';
  stop?: () => void;
  observer?: IntersectionObserver;
  inView: boolean;
  // Coming in (its entrance playing, or the voice still bringing its items): pointing is off.
  revealing: boolean;
  focus?: { set(id: string | null): void; readonly current: string | null };
  dispose(): void;
}

export function createCharts(context: ChartsContext) {
  const bound = new Set<Bound>();
  let timelineTime: number | null = null;

  const shownNow = (wrap: HTMLElement) => wrap.isConnected && !wrap.closest('[data-t-pending], [data-t-concealed], [data-t-timed], [inert], [hidden]');
  const hasBeats = (dom: ChartDom) => !!dom.block.props.beats && Object.keys(dom.block.props.beats).length > 0;
  // A chart follows the voice when it has beats and the screen's timeline runs (null: no timeline).
  const follows = (dom: ChartDom) => hasBeats(dom) && timelineTime !== null;

  // The entrance at its own time t (seconds since it started): the frame, then the items in reading
  // order, then the focus pull. Infinity: the chart at rest.
  const slotOf = (item: Bound, id: string, index: number) => item.view.slot?.(item.dom, id, index) ?? index;
  // When the entrance is over (seconds).
  function entranceEnd(item: Bound): number {
    const timing = item.view.entrance ?? defaultView.entrance!;
    const last = Math.max(0, ...item.dom.order.map((id, index) => slotOf(item, id, index)));
    return Math.max(timing.frame ?? 0, (timing.frame ?? 0) * 0.5 + last * timing.stagger + timing.item);
  }
  function entranceAt(item: Bound, t: number) {
    const { view, dom } = item;
    const timing = view.entrance ?? defaultView.entrance!;
    view.frame?.(dom, timing.frame ? clamp01(t / timing.frame) : 1);
    const start = (timing.frame ?? 0) * 0.5;
    dom.order.forEach((id, index) => view.reveal(dom, id, clamp01((t - start - slotOf(item, id, index) * timing.stagger) / timing.item)));
    // Written frame by frame: no CSS transition may lag behind (charts.css).
    dom.root.classList.toggle('is-entering', t < entranceEnd(item));
    revealing(item, t < entranceEnd(item));
    pull(dom, t >= entranceEnd(item) + 0.05);
  }
  // While a chart comes in, what is pointed at lets go and pointing waits (kit.ts createFocus active).
  function revealing(item: Bound, on: boolean) {
    item.revealing = on;
    if (on && item.focus?.current != null) item.focus.set(null);
  }
  // At the screen's time: each item from its beat (or from the start), the spotlight on the one the
  // voice talks about, then the focus pull when it is done.
  function beatsAt(item: Bound, time: number) {
    const { view, dom } = item;
    const props = dom.block.props;
    const beats = props.beats ?? {};
    const timing = view.entrance ?? defaultView.entrance!;
    const reveal = props.revealOnBeats !== false;
    const first = Math.min(...Object.values(beats));
    // Less motion asked: each item is there at its moment, without growing.
    const duration = prefersLessMotion() ? 1e-3 : timing.item;
    view.frame?.(dom, 1);
    let moving = false;
    for (const id of dom.order) {
      const at = beats[id];
      const p = !reveal ? 1 : at === undefined ? (time >= first ? 1 : 0) : clamp01((time - at) / duration);
      if (p > 0 && p < 1) moving = true;
      view.reveal(dom, id, p);
    }
    dom.root.classList.toggle('is-entering', moving);
    const ends = props.beatsEnd ?? Math.max(...Object.values(beats)) + timing.item + 1.5;
    let spoken: string | null = null;
    revealing(item, time < ends);
    if (time < ends) for (const [id, at] of Object.entries(beats)) if (at <= time + 1e-3 && (spoken === null || at >= beats[spoken])) spoken = id;
    spotlight(item, spoken);
    view.beat?.(dom, time, beats, ends);
    pull(dom, time >= ends);
  }
  function pull(dom: ChartDom, on: boolean) {
    if (!dom.block.props.highlight && !dom.root.querySelector('.is-hl')) return;
    dom.root.classList.toggle('is-pulled', on);
  }
  // Signalling: what the voice talks about stands, the rest steps back as on hover.
  function spotlight(item: Bound, id: string | null) {
    const { dom } = item;
    if (dom.spoken === id) return;
    dom.spoken = id;
    dom.root.classList.toggle('is-spotlit', id !== null);
    for (const element of dom.root.querySelectorAll<HTMLElement>('[data-t-item]')) element.classList.toggle('is-spoken', element.dataset.tItem === id);
    item.view.spot?.(dom, id);
  }

  function start(item: Bound) {
    if (item.entrance !== 'waiting' || follows(item.dom)) return;
    if (context.still || prefersLessMotion()) { finish(item); return; }
    if (!shownNow(item.wrap) || !item.inView) return;
    item.entrance = 'playing';
    item.view.before?.(item.dom);
    item.stop = animationFrameClock.frame((t) => {
      entranceAt(item, t);
      if (t > entranceEnd(item) + 0.2) { item.stop?.(); finish(item); }
    });
  }
  function finish(item: Bound) {
    item.stop?.();
    item.entrance = 'done';
    entranceAt(item, Infinity);
    item.view.after?.(item.dom);
  }

  function bind(wrap: HTMLElement, block: ChartBlock | PredictBlock, dry: boolean): (() => void)[] | undefined {
    const root = wrap.querySelector<HTMLElement>('.t-chart');
    if (!root) return undefined;
    const view = VIEWS[block.props.chart] ?? defaultView;
    const dom = chartDom(root, block, context);
    // Dry run (slides reserve the room of the answered state): the outcomes of a predict.
    if (dry) return view.outcomes?.(dom) ?? undefined;
    const item: Bound = { wrap, dom, view, entrance: 'waiting', inView: false, revealing: false, dispose: () => {} };
    root.tabIndex = 0;
    const focus = createFocus(root, {
      axis: (root.dataset.tAxis as 'x' | 'y' | 'xy' | 'none') ?? 'y',
      items: dom.items,
      pick: view.pick ? (event) => view.pick!(dom, event) : undefined,
      enabled: view.enabled ? (id) => view.enabled!(dom, id) : undefined,
      active: () => !item.revealing,
      live: dom.live,
      say: (id) => dom.items.first(id)?.dataset.tSay ?? id,
      on: (id) => {
        for (const element of root.querySelectorAll<HTMLElement>('[data-t-item]')) element.classList.toggle('is-pointed', element.dataset.tItem === id);
        const first = dom.items.first(id);
        const tip = first?.dataset.tTip;
        const at = dom.items.elements(id).flatMap((element) => [...element.querySelectorAll<HTMLElement>('[data-t-tip-at]'), ...(element.matches('[data-t-tip-at]') ? [element] : [])])[0] ?? first;
        if (tip && at) dom.tip.show(at, tip); else dom.tip.hide();
        view.focus?.(dom, id);
      },
      off: () => {
        for (const element of root.querySelectorAll<HTMLElement>('.is-pointed')) element.classList.remove('is-pointed');
        dom.tip.hide();
        view.focus?.(dom, null);
      }
    });
    item.focus = focus;
    const cleanup = view.setup?.(dom);
    item.observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
      for (const entry of entries) { item.inView = entry.isIntersecting; if (item.inView) start(item); }
    }, { threshold: 0.3 }) : undefined;
    if (item.observer) item.observer.observe(root); else item.inView = true;
    item.dispose = () => { item.stop?.(); item.observer?.disconnect(); focus.dispose(); dom.tip.dispose(); cleanup?.(); };
    bound.add(item);
    // Until the screen says whether its timeline runs, a chart with beats waits hidden (time 0).
    if (hasBeats(dom)) beatsAt(item, timelineTime ?? 0);
    // Shown at rest at once: in the canvas, and when less motion is asked (nothing would play in view).
    else if (context.still || prefersLessMotion()) finish(item);
    else { view.before?.(dom); entranceAt(item, 0); }
    return undefined;
  }

  // Forgets charts no longer in the page.
  const sweep = () => { for (const item of bound) if (!item.wrap.isConnected) { item.dispose(); bound.delete(item); } };

  return {
    bind,
    // Blocks came into view (a step revealed, a timed block shown, an event showed one).
    noteShown() { sweep(); for (const item of bound) start(item); },
    // The screen's timeline is at time (seconds): charts with beats follow it. null: the screen has
    // no timeline, and they play their entrance like the others.
    at(time: number | null) {
      timelineTime = time;
      sweep();
      for (const item of bound) {
        if (!hasBeats(item.dom)) continue;
        if (time !== null) beatsAt(item, time);
        else if (item.entrance === 'waiting') {
          if (context.still || prefersLessMotion()) finish(item);
          else { item.dom.root.classList.remove('is-spotlit'); item.view.before?.(item.dom); entranceAt(item, 0); start(item); }
        }
      }
    }
  };
}

// What every view gets: the chart's elements, its items in reading order, its format and language.
function chartDom(root: HTMLElement, block: ChartBlock | PredictBlock, context: ChartsContext): ChartDom {
  const byId = new Map<string, HTMLElement[]>();
  for (const element of root.querySelectorAll<HTMLElement>('[data-t-item]')) {
    const id = element.dataset.tItem ?? '';
    byId.set(id, [...(byId.get(id) ?? []), element]);
  }
  const order = [...byId.keys()];
  const live = document.createElement('p');
  live.className = 't-sr-only';
  live.setAttribute('aria-live', 'polite');
  root.append(live);
  const body = root.querySelector<HTMLElement>('.t-chart-body') ?? root;
  const format: NumberFormat = block.props.format ?? {};
  return {
    root, body, block, order, live, language: context.language, format, spoken: null, labels: context.labels, context,
    items: { ids: order, elements: (id) => byId.get(id) ?? [], first: (id) => byId.get(id)?.[0] },
    tip: createTip(body) as Tip,
    format_: (value: number) => formatValue(value, format, context.language)
  };
}
