// Measures the editor canvas on a large course (scripts/make-large-course.ts):
//   node test/bench/canvas.ts /tmp/elabora-large-render [--edits 5] [--screens 20]
// - renderScreen, warm, for every screen (fresh context), and for a screen edited since the context
//   was made (the engine's case while an author types);
// - the payload a page gets per screen (with the design styles, and without once it has them);
// - in Chrome, from the push of an edited screen to its text in the page, and the canvas's own time.
import path from 'node:path';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { startCanvasHost } from '@elabora/node/canvas/host';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { loadProject, screenBlocks, screenOrder } from '@elabora/core/project/load';
import { createProjectFiles, textFile } from '@elabora/core/project/files';
import type { Project, Screen } from '@elabora/core/project/model';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import type { RenderedScreen } from '@elabora/core/render/screen';
import type { CanvasApi } from '@elabora/player/canvas';

type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: CanvasApi; seen?: Promise<number> };

const args = process.argv.slice(2);
const dir = path.resolve(args[0] || '/tmp/elabora-large-render');
const option = (name: string, fallback: number) => { const index = args.indexOf(`--${name}`); return index >= 0 ? Number(args[index + 1]) : fallback; };
const edits = option('edits', 5);
const browserScreens = option('screens', 20);

const now = () => performance.now();
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const summary = (values: number[], unit = 'ms', digits = 2) => `median ${median(values).toFixed(digits)} ${unit}, max ${Math.max(...values).toFixed(digits)} ${unit} (n=${values.length})`;

// The first text of a screen with words to change, and the screen with it changed.
function editable(screen: Screen): { id: string; key: 'markdown' | 'text' } | null {
  for (const { block } of screenBlocks(screen)) for (const key of ['markdown', 'text'] as const) if (typeof block.props?.[key] === 'string') return { id: block.id, key };
  return null;
}
function edited(project: Project, id: string, change: (screen: Screen) => void): Project {
  const file = `screens/${id}.json`;
  const screen = structuredClone(project.screens.get(id)!.data);
  change(screen);
  return loadProject(createProjectFiles([...project.files].map(([name, content]) => [name, name === file ? textFile(`${JSON.stringify(screen, null, 2)}\n`) : content] as const)), { root: project.root });
}

let begin = now();
const project = loadProjectFromDir(dir);
console.log(`${dir}: ${project.screens.size} screens, loaded in ${(now() - begin).toFixed(1)} ms`);
begin = now();
const context = createRenderContext(project);
console.log(`createRenderContext: ${(now() - begin).toFixed(1)} ms (cold)`);
const ids = screenOrder(project).map((entry) => entry.id);

// Warm: a first pass, then five; per screen, the median of the five.
for (const id of ids) renderScreen(project, id, {}, context);
const times = new Map<string, number[]>(ids.map((id) => [id, []]));
for (let round = 0; round < 5; round++) for (const id of ids) { const start = now(); renderScreen(project, id, {}, context); times.get(id)!.push(now() - start); }
console.log(`renderScreen, warm, per screen: ${summary([...times.values()].map(median), 'ms', 3)}`);
begin = now();
createRenderContext(project);
console.log(`createRenderContext: ${(now() - begin).toFixed(1)} ms (warm)`);

// A screen edited since the context was made: loading the edited snapshot, then rendering it.
const loads: number[] = [];
const renders: number[] = [];
for (const id of ids) {
  const target = editable(project.screens.get(id)!.data);
  if (!target) continue;
  let start = now();
  const changed = edited(project, id, (screen) => { const block = [...screenBlocks(screen)].find(({ block: candidate }) => candidate.id === target.id)!.block; block.props[target.key] = `${String(block.props[target.key])} (edited)`; });
  loads.push(now() - start);
  start = now();
  renderScreen(changed, id, {}, context);
  renders.push(now() - start);
}
console.log(`edited screen: loadProject ${summary(loads)}; renderScreen with the shared context ${summary(renders, 'ms', 3)}`);

// What a page receives (the host leaves files out, and styles once the page has them).
const message = (render: RenderedScreen, styles: boolean) => JSON.stringify({ type: 'elabora/render', id: 1, render: { screen: render.screen, course: render.course, view: render.view, ...(styles ? { styles: render.styles } : {}) } });
const sizes = ids.map((id) => renderScreen(project, id, {}, context));
console.log(`payload per screen with styles: ${summary(sizes.map((render) => Buffer.byteLength(message(render, true)) / 1024), 'KB', 1)}`);
console.log(`payload per screen without styles: ${summary(sizes.map((render) => Buffer.byteLength(message(render, false)) / 1024), 'KB', 1)}`);
console.log(`styles: ${(Buffer.byteLength(JSON.stringify(sizes[0].styles)) / 1024).toFixed(1)} KB, ${sizes[0].styles.sheets.length} sheets`);

// Chrome: push to text in the page, for edits of screens spread over the course.
const host = await startCanvasHost({ root: dir });
const browser = await launchBrowser('chromium');
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
  await page.goto(host.url);
  await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas);
  const pushToDom: number[] = [];
  const apply: number[] = [];
  const switches: number[] = [];
  let id = 0;
  const step = Math.max(1, Math.floor(ids.length / browserScreens));
  for (let index = 0; index < ids.length; index += step) {
    const screen = ids[index];
    const target = editable(project.screens.get(screen)!.data);
    if (!target) continue;
    let start = performance.timeOrigin + now();
    host.push(renderScreen(project, screen, {}, context), { id: ++id });
    await page.waitForFunction((wanted) => (window as CanvasWindow).__elaboraCanvas.layout().id === wanted, id);
    switches.push(await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout().applyMs));
    if (process.env.VERBOSE) console.log(screen, switches.at(-1));
    let current = project;
    for (let edit = 1; edit <= edits; edit++) {
      const mark = `(edit ${edit})`;
      current = edited(current, screen, (data) => { const block = [...screenBlocks(data)].find(({ block: candidate }) => candidate.id === target.id)!.block; block.props[target.key] = `${String(block.props[target.key]).replace(/ \(edit \d+\)$/, '')} ${mark}`; });
      await page.evaluate(({ block, mark }) => {
        (window as CanvasWindow).seen = new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            if (!document.querySelector(`[data-block="${block}"]`)?.textContent?.includes(mark)) return;
            observer.disconnect();
            resolve(performance.timeOrigin + performance.now());
          });
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        });
      }, { block: target.id, mark });
      start = performance.timeOrigin + now();
      host.push(renderScreen(current, screen, {}, context), { id: ++id });
      const at = await page.evaluate(() => (window as CanvasWindow).seen!);
      pushToDom.push(at - start);
      await page.waitForFunction((wanted) => (window as CanvasWindow).__elaboraCanvas.layout().id === wanted, id);
      apply.push(await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout().applyMs));
    }
  }
  console.log(`Chrome, edit pushed to text in the page (renderScreen, SSE, parse, update): ${summary(pushToDom, 'ms', 1)}`);
  console.log(`Chrome, canvas update of an edited screen (receipt to DOM updated): ${summary(apply)}`);
  console.log(`Chrome, canvas showing another screen: ${summary(switches)}`);
} finally {
  await browser.close();
  await host.close();
}
