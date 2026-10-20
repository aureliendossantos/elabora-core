import { createRenderContext, renderChrome, renderScreen as renderCoreScreen } from '@elabora/core/render/screen';
import type { RenderChrome, RenderContext, RenderedScreen } from '@elabora/core/render/screen';
import type { Project } from '@elabora/core/project/model';
import type { RenderScreenParams, CanvasMoment } from './protocol.ts';
import { screenTimeline, anchorTime } from '@elabora/core/narration/timeline';
import type { Anchor } from '@elabora/format';
import { EngineError } from './errors.ts';

// Rendering screens for the app (docs/architecture/rendering.md, Rendering a screen): one render context per
// language, kept while what every screen shares is unchanged (course.json, plan.json,
// elabora.lock.json, components/, object manifests, the theme, and the files its stylesheets name);
// a screen edited since renders with it. Renders are memoised per screen and view, and dropped when
// the screen file, a file the render lists (assets by hash, object files) or a shared file changes.
// What the player's bars show that depends on every screen (renderChrome: the outline, the items
// that show, « IA et crédits », the languages) is kept apart, per language, and made again after a
// change to any screen or asset (kept when it comes out the same): a render made with other bars is
// made again.

const SHARED = /^(course\.json|plan\.json|elabora\.lock\.json|components\/.+|theme\/.+|objects\/[^/]+\/object\.manifest\.json|translations\/.+)$/;
const MEMO_SIZE = 64;

interface Memo {
  render: RenderedScreen;
  // The bars it was made with.
  chrome: RenderChrome;
  dependencies: Dependencies;
}

// What a render reads besides what every screen shares.
export interface Dependencies {
  files: Set<string>; // the screen file and the files the render lists
  folders: string[]; // objects/<id>/ of the free objects it places (object.js is bundled from the whole folder)
}

export class Renderer {
  #contexts = new Map<string, RenderContext>();
  #designFiles = new Set<string>();
  #memo = new Map<string, Memo>();
  #chrome = new Map<string, RenderChrome>();
  #chromeBefore = new Map<string, RenderChrome>();

  render(project: Project, params: RenderScreenParams): RenderedScreen {
    if (!project.course) throw new EngineError('refused', 'The project has no course.json to render.');
    if (!project.screens.has(params.screen)) throw new EngineError('not-found', `No screen "${params.screen}"`);
    const key = JSON.stringify([params.screen, params.state ?? 'initial', params.step ?? null, params.layer ?? null, params.language ?? null]);
    // A moment changes the view only: the render of the screen is the same.
    const at = params.at ? momentTime(project, params.screen, params.at, params.language) : null;
    // So does ghost (the steps after the first faded).
    const viewOf = (render: RenderedScreen): RenderedScreen => (at || params.ghost ? { ...render, view: { ...render.view, ...(at ? { at } : {}), ...(params.ghost ? { ghost: true } : {}) } } : render);
    // A render made with the bars as they were is made again (their files may differ too).
    const chrome = this.chrome(project, params.language);
    const known = this.#memo.get(key);
    if (known && known.chrome === chrome) return viewOf(known.render);
    if (known) this.#memo.delete(key);
    const render = renderCoreScreen(project, params.screen, { state: params.state, step: params.step, layer: params.layer, language: params.language, chrome }, this.#context(project, params.language));
    if (this.#memo.size >= MEMO_SIZE) this.#memo.delete(this.#memo.keys().next().value as string);
    this.#memo.set(key, { render, chrome, dependencies: dependenciesOf(render) });
    return viewOf(render);
  }

  // The bars' part that depends on every screen, in a language (kept until a screen changes; made
  // again the same, the one before is kept, and so are the renders that carry it).
  chrome(project: Project, language?: string | null): RenderChrome {
    const key = language ?? '';
    let chrome = this.#chrome.get(key);
    if (!chrome) {
      chrome = renderChrome(project, { language: language ?? undefined }, this.#context(project, language ?? undefined));
      const before = this.#chromeBefore.get(key);
      if (before && JSON.stringify(before) === JSON.stringify(chrome)) chrome = before;
      this.#chromeBefore.delete(key);
      this.#chrome.set(key, chrome);
    }
    return chrome;
  }

  // Forgets what changed paths affect. Returns whether what every screen shares changed.
  invalidate(paths: readonly string[]): boolean {
    if (!paths.length) return false;
    if (paths.some((path) => SHARED.test(path) || this.#designFiles.has(path))) {
      this.#contexts.clear();
      this.#designFiles.clear();
      this.#memo.clear();
      this.#chrome.clear();
      this.#chromeBefore.clear();
      return true;
    }
    // A screen's title, narration or media change what the bars show; an asset, whether the logo shows.
    if (paths.some((path) => path.startsWith('screens/') || path.startsWith('assets/'))) {
      for (const [key, chrome] of this.#chrome) this.#chromeBefore.set(key, chrome);
      this.#chrome.clear();
    }
    for (const [key, memo] of this.#memo) if (affects(memo.dependencies, paths)) this.#memo.delete(key);
    return false;
  }

  #context(project: Project, language: string | undefined): RenderContext {
    const key = language ?? '';
    let context = this.#contexts.get(key);
    if (!context) {
      // The canvas is the app's: the texts the author can point at are marked.
      context = createRenderContext(project, { language, fields: true });
      this.#contexts.set(key, context);
      for (const file of context.designFiles) this.#designFiles.add(file.path);
    }
    return context;
  }
}

// The time of a moment on a screen's timeline (an anchor resolved in the language shown; a word the
// line does not say falls at the line's start).
export function momentTime(project: Project, screen: string, moment: CanvasMoment, language?: string | null): { time: number } {
  if ('time' in moment && typeof moment.time === 'number') return { time: Math.max(0, moment.time) };
  const timeline = screenTimeline(project, screen, { language: language ?? undefined });
  if (!timeline) throw new EngineError('refused', `Screen "${screen}" has no timeline (no narration, no timed block).`);
  return { time: anchorTime(timeline, moment as Anchor).time };
}

export function dependenciesOf(render: RenderedScreen): Dependencies {
  const files = new Set([`screens/${render.screen}.json`, ...render.files.map((file) => file.path)]);
  const folders = render.files.filter((file) => file.kind === 'object-code').map((file) => file.path.slice(0, file.path.lastIndexOf('/') + 1));
  return { files, folders };
}

export function affects(dependencies: Dependencies, paths: readonly string[]): boolean {
  return paths.some((path) => dependencies.files.has(path) || dependencies.folders.some((folder) => path.startsWith(folder)));
}
