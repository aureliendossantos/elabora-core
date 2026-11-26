import { commandContext } from '@elabora/core/commands/context';
import { addBlock, type AddBlockArgs } from '@elabora/core/commands/blocks';
import { updateScreen } from '@elabora/core/commands/screens';
import type { ProjectFiles } from '@elabora/core/project/files';
import { loadProject } from '@elabora/core/project/load';
import type { Project } from '@elabora/core/project/model';
import { createRenderContext, renderChrome, renderScreen, screenRenderOf, type RenderedScreen } from '@elabora/core/render/screen';
import { sha256 } from '@elabora/core/util/sha256';
import type { BlockPreviewArgs, MomentAt, SceneRender } from '@elabora/player/thumbs-protocol';
import { EngineError } from './errors.ts';
import type { Renderer } from './render.ts';

// The renders of the editor's miniatures (D130, D133): a screen, a screen at a moment, a screen with a
// block it does not have yet (or a layout, a backdrop, a style), a screen to measure. Each is given
// back frozen at its view (thumbs-protocol.ts, SceneRender), with the course's reference size and a
// version that changes when the miniature's pixels would; the files it names are declared to the
// host first (a browser's relay serves the canvas only what renders named). The twins of the desktop's
// pushes to its hidden pages, which keep their own way.

export interface ThumbsHost {
  project(): Project;
  files(): ProjectFiles;
  root?: string;
  renderer: Renderer;
  // The files a render names, which the canvas host may serve from now on.
  named(render: RenderedScreen): void;
  assertOpen(): void;
}

export class SessionThumbs {
  readonly #host: ThumbsHost;
  #renders = 0;

  constructor(host: ThumbsHost) {
    this.#host = host;
  }

  // A screen, in the module's language or in another.
  thumbRender({ screen, language }: { screen: string; language?: string | null }): SceneRender {
    this.#host.assertOpen();
    return this.#scene('thumb', this.#host.renderer.render(this.#host.project(), { screen, ...(language ? { language } : {}) }));
  }

  // The screen at a moment of its timeline: a time (its timed blocks where their effects are then, D28),
  // or as it is when a line starts or ends.
  momentRender({ screen, at }: { screen: string; at: MomentAt }): SceneRender {
    this.#host.assertOpen();
    const base = this.#host.renderer.render(this.#host.project(), { screen, step: at.step, ...(typeof at.time === 'number' ? { at: { time: at.time } } : {}) });
    const render = typeof at.time === 'number' ? base : { ...base, view: { ...base.view, step: at.step, at: at.line ? { line: at.line, edge: at.edge ?? 'start' } : null } };
    return this.#scene('moment', render);
  }

  // « Ajouter un bloc » (Lin 34): the screen as add_block would leave it, made from the files in memory
  // (nothing is written); or with a screen layout, a backdrop variant or a screen style (the page from
  // its top: block '').
  blockPreviewRender({ args }: { args: BlockPreviewArgs }): SceneRender & { block: string; slides: boolean } {
    this.#host.assertOpen();
    const project = this.#host.project();
    if (!project.screens.has(args.screen)) throw new EngineError('not-found', `No screen "${args.screen}"`);
    const { layout, backdrop, screenStyle, ...added } = args;
    const context = commandContext(this.#host.files(), this.#host.root ? { root: this.#host.root } : {});
    const slides = isSlides(project);
    if (layout || backdrop !== undefined || screenStyle) {
      const output = updateScreen(context, {
        id: args.screen, ...(layout ? { layout: layout.layout, layoutProps: layout.layoutProps ?? null } : {}), ...(backdrop !== undefined ? { backdrop } : {}), ...(screenStyle ? { style: screenStyle } : {})
      });
      const scene = this.#scene('block', this.#preview(project, output.files!, args.screen), ':layout');
      return { ...scene, block: '', slides };
    }
    const output = addBlock(context, added as AddBlockArgs);
    const scene = this.#scene('block', this.#preview(project, output.files!, args.screen, args.layer ?? undefined), `:${output.result.block}`);
    return { ...scene, block: output.result.block, slides };
  }

  // The screen as learners see it, its texts marked (fields), to be measured by the canvas.
  measureRender({ screen, language }: { screen: string; language: string | null }): SceneRender {
    this.#host.assertOpen();
    return this.#scene('measure', this.#host.renderer.render(this.#host.project(), { screen, ...(language ? { language } : {}) }), '', true);
  }

  // A preview: the project with the change, rendered with what every screen shares as it is now.
  #preview(project: Project, files: ProjectFiles, screen: string, layer?: string): RenderedScreen {
    const context = createRenderContext(project);
    const chrome = renderChrome(project, {}, context);
    return renderScreen(loadProject(files, this.#host.root ? { root: this.#host.root } : {}), screen, { ...(layer ? { layer } : {}), chrome }, context);
  }

  #scene(kind: string, render: RenderedScreen, suffix = '', bars = false): SceneRender {
    this.#host.named(render);
    const size = referenceSize(this.#host.project());
    return { id: `${kind}-${++this.#renders}`, render: screenRenderOf(render), ...size, version: `${versionOf(render, size, bars)}${suffix}` };
  }
}

const isSlides = (project: Project): boolean => project.course?.presentation?.mode === 'slides';

// Slides at the course's reference window; a scrolling course as a laptop shows its top.
export function referenceSize(project: Project): { width: number; height: number } {
  if (!isSlides(project)) return { width: 1280, height: 720 };
  const reference = /^(\d+)x(\d+)$/.exec(project.course?.presentation?.fit?.reference ?? '');
  return reference ? { width: Number(reference[1]), height: Number(reference[2]) } : { width: 1600, height: 900 };
}

// What a miniature shows: the render (its files by hash, its stylesheets by theirs) at its size. The
// player's code is the page's own, the same for every render a page draws. A miniature has no bars:
// of the course's outline it shows only where the screen is (a backdrop's rank, its section), not the
// titles, so that a screen renamed does not draw every miniature again; the measure has the bars.
const versionOf = (render: RenderedScreen, size: { width: number; height: number }, bars: boolean): string => {
  const outline = render.outline && !bars ? render.outline.sections.map((section) => [section.id, section.screens.map((screen) => screen.id)]) : render.outline;
  return sha256(JSON.stringify([size, { ...render, styles: render.styles.hash, outline }])).slice(0, 32);
};
