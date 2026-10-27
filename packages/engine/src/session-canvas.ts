import type { Project } from '@elabora/core/project/model';
import type { RenderedScreen } from '@elabora/core/render/screen';
import { startCanvasHost } from '@elabora/node/canvas/host';
import type { CanvasHost } from '@elabora/node/canvas/host';
import { Renderer, affects, dependenciesOf, momentTime } from './render.ts';
import type { Dependencies } from './render.ts';
import { EngineError } from './errors.ts';
import type { CanvasInfo, CanvasView, RenderScreenParams } from './protocol.ts';

// The canvas of the session: the renderer (its memoised renders serve renderScreen too) and the host
// whose pages show one screen, sent again after each change that affects it.
export class SessionCanvas {
  readonly #renderer = new Renderer();
  // chrome: what the bars showed in the last render pushed (the outline, the items that show…).
  #canvas: { host: CanvasHost; view: CanvasView; shown: Dependencies | null; views: number; chrome: string | null } | null = null;
  readonly #root: string;
  readonly #project: () => Project;
  readonly #reportError: (error: unknown, context: string) => void;

  constructor({ root, project, reportError }: { root: string; project: () => Project; reportError: (error: unknown, context: string) => void }) {
    this.#root = root;
    this.#project = project;
    this.#reportError = reportError;
  }

  render(params: RenderScreenParams): RenderedScreen { return this.#renderer.render(this.#project(), params); }
  // Starts the canvas host of the project (once): the app shows its page in a frame.
  async open(options: { port?: number; debug?: boolean } = {}): Promise<CanvasInfo> {
    if (!this.#canvas) {
      const host = await startCanvasHost({ root: this.#root, port: options.port, debug: options.debug });
      this.#canvas = { host, view: { screen: null, state: 'initial', step: null, layer: null, language: null }, shown: null, views: 0, chrome: null };
    }
    const { host, view } = this.#canvas;
    return { url: host.url, base: host.base, token: host.token, view: { ...view } };
  }

  // Another screen or language: a new render; the state, step or layer of the screen shown: a view
  // change, the page keeps its nodes.
  async view(change: Partial<CanvasView>): Promise<{ id: string; pages: number; view: CanvasView }> {
    const canvas = this.#canvas;
    if (!canvas) throw new EngineError('not-available', 'No canvas: open it first (openCanvas)');
    const before = canvas.view;
    const view: CanvasView = { ...before, ...change };
    const id = `view-${++canvas.views}`;
    canvas.view = view;
    if (view.screen === null) return { id, pages: canvas.host.pages, view: { ...view } };
    if (!canvas.shown || view.screen !== before.screen || view.language !== before.language) {
      try {
        this.#pushCanvas(id, true);
      } catch (error) {
        canvas.view = before; // an unknown screen: the canvas keeps showing what it showed
        throw error;
      }
      return { id, pages: canvas.host.pages, view: { ...view } };
    }
    // A moment is sent when there is one, or to clear the one shown.
    const at = view.at ? momentTime(this.#project(), view.screen, view.at, view.language, view.layer) : null;
    const pages = canvas.host.view({ state: view.state, step: view.step, layer: view.layer, ...(at || before.at ? { at } : {}), ...(view.ghost !== undefined || before.ghost !== undefined ? { ghost: !!view.ghost } : {}), ...(view.dialogue !== undefined || before.dialogue !== undefined ? { dialogue: view.dialogue ?? null } : {}) }, { id });
    return { id, pages, view: { ...view } };
  }

  async close(): Promise<{ closed: boolean }> {
    const canvas = this.#canvas;
    this.#canvas = null;
    if (canvas) await canvas.host.close();
    return { closed: canvas !== null };
  }

  // Renders the screen shown and sends it to the canvas pages. thrown: errors go to the caller (a
  // request) rather than to an error event (a change).
  #pushCanvas(id: string | number, thrown = false): void {
    const canvas = this.#canvas;
    if (!canvas?.view.screen) return;
    let render: RenderedScreen;
    try {
      const { screen, state, step, layer, language, at, ghost, dialogue } = canvas.view;
      render = this.#renderer.render(this.#project(), { screen: screen as string, state, step: step ?? undefined, layer: layer ?? undefined, language: language ?? undefined, ...(at ? { at } : {}), ...(ghost ? { ghost } : {}), ...(dialogue ? { dialogue } : {}) });
    } catch (error) {
      if (thrown) throw error;
      this.#reportError(error, 'rendering the screen shown on the canvas');
      return;
    }
    canvas.shown = dependenciesOf(render);
    canvas.chrome = chromeKey({ outline: render.outline, player: render.course.player, about: render.course.about, languages: render.course.languages });
    canvas.host.push(render, { id });
  }

  // After a change: renders it affects are forgotten, and the screen shown is sent again when it is
  // one of them, with the change's sequence number as render id.
  changed(changed: string[], seq: number): void {
    if (!changed.length) return;
    const shared = this.#renderer.invalidate(changed);
    const canvas = this.#canvas;
    if (!canvas?.view.screen || !canvas.shown) return;
    if (shared || affects(canvas.shown, changed)) { this.#pushCanvas(seq); return; }
    // Another screen changed what the bars show (a title in the outline, a narration that brings the
    // controls, a generated voice): the screen shown is sent again with them.
    if (!changed.some((path) => path.startsWith('screens/') || path.startsWith('assets/'))) return;
    let now: string;
    try {
      const chrome = this.#renderer.chrome(this.#project(), canvas.view.language);
      now = chromeKey(chrome);
    } catch { return; }
    if (now !== canvas.chrome) this.#pushCanvas(seq);
  }
}

// What the bars show that depends on every screen, as compared between renders.

const chromeKey = ({ outline, player, about, languages }: { outline?: unknown; player?: unknown; about?: { ai?: unknown; credits?: unknown }; languages?: unknown }): string =>
  JSON.stringify({ outline, player, about: about && (about.ai || about.credits) ? about : null, languages: languages ?? null });
