import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Frame, Locator, Page } from 'playwright-core';
import type { Diagnostic } from '@elabora/core/diagnostics/index';
import { probeCachePath } from '@elabora/node/media/probe';
import { readProjectFiles } from '@elabora/node/project-reader';

// No word timing at once in tests: a computer with the word aligner installed would time the test
// tones (docs/decisions.md D27). A test that wants it sets ELABORA_ALIGN=1 for its call.
process.env.ELABORA_ALIGN ??= '0';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Courses' video is H.264 and their sound AAC (docs/architecture/media.md). Chrome, Edge and the app's
// Electron play both; Playwright's own Chromium, the last browser the launcher tries, plays neither.
// A test that plays media asks first and skips with this reason, rather than waiting out its timeout.
export const NO_MEDIA_CODECS = 'this browser cannot play H.264 or AAC (Playwright\'s Chromium has no proprietary codecs: install Google Chrome or Microsoft Edge)';
export const playsMedia = (target: Page | Frame, type = 'video/mp4; codecs="avc1.64001E, mp4a.40.2"'): Promise<boolean> =>
  target.evaluate((mime) => document.createElement('video').canPlayType(mime) !== '', type);
// Whether the player has closed a panel, a menu or a tooltip: its `hidden` attribute, which it sets
// at once. Not whether the element has finished fading out: the fade runs on the page's animation
// clock, which stands still while the browser has no frame to draw (a loaded computer, a page in
// the background), so « not visible yet » says nothing about the player. Read the state, never wait
// out the fade.
export const isClosed = (target: Locator): Promise<boolean> => target.evaluate((element) => Boolean((element as HTMLElement).hidden));

// Waits for an element's own entrance to end before the test acts on it: its animations and
// transitions, which the page ends when it draws frames. Playwright's click does wait for a still
// box, but only for 30 s; on a loaded computer a menu's arrival can take longer than that.
export const settled = (target: Locator): Promise<void> => target.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined))).then(() => undefined));

// Stable baseline: tests that reshape the course must not depend on later sample design edits.
export const EXAMPLE = path.join(ROOT, 'test/fixtures/format-0.1/diagnostic-reseau');
// URL of a source module of the repository, for import() in another process (Windows paths are not
// URLs: D:\\… would be read as a scheme).
export const moduleUrl = (rel: string) => pathToFileURL(path.join(ROOT, rel)).href;

// Fresh copy of a course (by default the example) in a temp folder: tests never modify the examples.
// The copy keeps the files' times, as a course on an author's disk has them: its media are probed
// once per run, the first copy's probe cache seeding the next ones (ELABORA_TEST_PROBES, set by
// test/isolate.ts), instead of ffprobe at every snapshot of every copy.
export function copyExample(source: string = EXAMPLE): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-test-'));
  fs.cpSync(source, dir, { recursive: true, preserveTimestamps: true, filter: (src) => !/[\\/](dist|\.elabora)([\\/]|$)/.test(src.slice(source.length)) });
  seedProbes(source, dir);
  return dir;
}

// The seed is made on a copy of its own, so that the copy a test gets has had no snapshot read and
// none of the core's memos (its data folder, for one) set before the test sets its environment.
function seedProbes(source: string, dir: string): void {
  const seeds = process.env.ELABORA_TEST_PROBES;
  if (!seeds || process.env.ELABORA_DATA_DIR) return;
  const seed = path.join(seeds, `${path.relative(ROOT, source).replace(/[\\/]/g, '~')}.json`);
  if (!fs.existsSync(seed)) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-test-probes-'));
    try {
      fs.cpSync(source, scratch, { recursive: true, preserveTimestamps: true, filter: (src) => !/[\\/](dist|\.elabora)([\\/]|$)/.test(src.slice(source.length)) });
      readProjectFiles(scratch);
      const cache = probeCachePath(scratch);
      if (!fs.existsSync(cache)) return;
      fs.mkdirSync(seeds, { recursive: true });
      const temporary = `${seed}.${process.pid}.tmp`;
      fs.copyFileSync(cache, temporary);
      fs.renameSync(temporary, seed);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  // Where probeCachePath puts it when ELABORA_DATA_DIR is not set: the project's .elabora/.
  const cache = path.join(dir, '.elabora', 'media', 'probe-cache.json');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.copyFileSync(seed, cache);
}

// A JSON file of a fixture. Tests reshape fixtures freely (invalid ones included), so the value
// is deliberately untyped.
export const readJSON = (dir: string, rel: string): any => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
export const writeJSON = (dir: string, rel: string, value: unknown): void => fs.writeFileSync(path.join(dir, rel), JSON.stringify(value, null, 2) + '\n');
export const codes = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.filter((d) => !d.waived).map((d) => d.code);

// Writes a file of a fixture, with its folders: text as is, anything else as JSON.
export function writeFixture(dir: string, rel: string, content: unknown): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

// Two course components with controls (named buttons from a list, tabs) for click and visited cases.
export function addExplorer(dir: string): void {
  const items = (extra = {}) => ({ type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id: { type: 'string' }, label: { type: 'string', 'x-translatable': true }, ...extra } } });
  writeFixture(dir, 'components/markers/component.json', { id: 'markers', title: 'Markers', version: '1.0.0', category: 'interaction', props: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: items() } } });
  writeFixture(dir, 'components/markers/template.html', '<ul class="mk"><li data-each="items"><button data-t-click="{{id}}">{{label}}</button></li></ul>');
  writeFixture(dir, 'components/facets/component.json', { id: 'facets', title: 'Facets', version: '1.0.0', category: 'interaction', props: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: items({ body: { type: 'string', 'x-translatable': true } }) } } });
  writeFixture(dir, 'components/facets/template.html', '<div data-t-tabs><div class="fc-tabs"><button data-each="items" data-t-tab="{{id}}">{{label}}</button></div><div data-each="items" data-t-panel="{{id}}"><p>{{body}}</p></div></div>');
}

// The cascade layers on one element (docs/design.md): a callout of a course component, styled by
// the player (.t-callout, elabora.base), its component stylesheet (elabora.components) and the course
// stylesheet (elabora.theme). Placed on the first screen of the example ("accueil"). Expected:
// padding-left from the component (it beats the player at the same specificity),
// background-color from the theme (it beats the component at the same specificity), color from
// the theme (it beats a more specific component rule).
export const LAYER_PROBE = { screen: 'accueil', component: 'rgb(170, 0, 0)', theme: 'rgb(0, 0, 170)', width: '9px' };
export function addLayerProbe(dir: string): void {
  writeFixture(dir, 'components/layer-probe/component.json', {
    id: 'layer-probe', title: 'Layer probe', version: '1.0.0', category: 'content',
    props: { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string', 'x-translatable': true } } },
    fallback: [{ type: 'text', props: { markdown: '{{label}}' } }]
  });
  writeFixture(dir, 'components/layer-probe/template.html', '<div class="t-callout lp-probe">{{label}}</div>');
  writeFixture(dir, 'components/layer-probe/component.css', `.lp-probe { padding-left: ${LAYER_PROBE.width}; background-color: ${LAYER_PROBE.component}; }\n.t-block--layer-probe .t-callout.lp-probe { color: ${LAYER_PROBE.component}; }\n`);
  writeFixture(dir, 'theme/theme.css', `.lp-probe { background-color: ${LAYER_PROBE.theme}; color: ${LAYER_PROBE.theme}; }\n`);
  const course = readJSON(dir, 'course.json');
  course.theme.stylesheet = 'theme/theme.css';
  writeJSON(dir, 'course.json', course);
  const screen = readJSON(dir, `screens/${LAYER_PROBE.screen}.json`);
  screen.blocks.push({ id: 'accueil-probe', type: 'layer-probe', props: { label: 'Sonde' } });
  writeJSON(dir, `screens/${LAYER_PROBE.screen}.json`, screen);
}

// A free object that reports where its frame is in the window (host.onView), at the end of the
// screen "chemin" after enough text to be below the window: { visible, entry, seen } in its state.
export const VIEW_PROBE = { screen: 'chemin', block: 'chemin-view-probe' };
export function addViewProbe(dir: string): void {
  writeFixture(dir, 'objects/view-probe/object.manifest.json', {
    manifestVersion: '0.1', id: 'view-probe', version: '1.0.0', title: 'Sonde de vue',
    planRefs: { objectives: ['OBJ-1'], items: ['ITEM-2'] }, pedagogicalRole: 'visualisation',
    props: { type: 'object', properties: {} },
    language: 'fr', strings: { label: { text: 'Sonde', description: 'Nom du bouton' } },
    state: { type: 'object', properties: { visible: { type: 'boolean' }, entry: { type: 'number' }, seen: { type: 'integer' } } },
    events: [], budgets: {},
    a11y: { description: 'Une sonde.', keyboard: 'Tab atteint son bouton.', motion: { pausable: true, respectsReducedMotion: true } },
    sandbox: { network: 'none' }
  });
  writeFixture(dir, 'objects/view-probe/object.js', [
    'export function mount(container, ctx) {',
    '  let view = ctx.view;',
    '  let seen = 0;',
    "  const button = document.createElement('button');",
    "  button.type = 'button';",
    "  button.setAttribute('aria-label', ctx.t('label'));",
    '  container.appendChild(button);',
    '  const off = ctx.host.onView((next) => { view = next; seen++; });',
    '  return { getState: () => ({ visible: view.visible, entry: view.entry, seen }), setState() {}, dispose() { off(); } };',
    '}',
    ''
  ].join('\n'));
  writeFixture(dir, 'objects/view-probe/object.notes.md', 'Sonde des tests : où est son cadre dans la fenêtre.\n');
  writeFixture(dir, 'objects/view-probe/object.tests.json', { tests: [{
    name: 'follows the view', view: { visible: false, ratio: 0, progress: 0, entry: 0, exit: 0 },
    steps: [
      { action: 'expect-state', state: { visible: false, entry: 0, seen: 0 } },
      { action: 'set-view', view: { visible: true, ratio: 0.5, entry: 0.5 } },
      { action: 'expect-state', state: { visible: true, entry: 0.5, seen: 1 } }
    ]
  }] });
  const screen = readJSON(dir, `screens/${VIEW_PROBE.screen}.json`);
  for (let n = 1; n <= 6; n++) screen.blocks.push({ id: `chemin-filler-${n}`, type: 'text', props: { markdown: 'Le paquet traverse le réseau. '.repeat(14) } });
  screen.blocks.push({ id: VIEW_PROBE.block, type: 'free-object', props: { object: 'view-probe', title: 'Sonde', aspectRatio: '16:9', textAlternative: 'Une sonde sans contenu.' } });
  writeJSON(dir, `screens/${VIEW_PROBE.screen}.json`, screen);
}

// A free object with a list prop (devices with a label) and a material colour, placed on the screen
// "chemin" with a list of its own and a button whose click event gives it another list: its state
// reads what it was given ({ devices, labels, tint }).
export const LIST_PROBE = { screen: 'chemin', block: 'chemin-list-probe', button: 'chemin-list-next' };
export function addListProbe(dir: string): void {
  writeFixture(dir, 'objects/list-probe/object.manifest.json', {
    manifestVersion: '0.1', id: 'list-probe', version: '1.0.0', title: 'Sonde de liste',
    planRefs: { objectives: ['OBJ-1'], items: ['ITEM-2'] }, pedagogicalRole: 'visualisation',
    props: { type: 'object', properties: {
      stops: {
        type: 'array', title: 'Étapes', description: 'Équipements traversés', 'x-group': 'Contenu', 'x-control': 'list', minItems: 1, maxItems: 4,
        items: { type: 'object', title: 'Étape', required: ['device'], properties: {
          device: { type: 'string', title: 'Équipement', enum: ['routeur', 'parefeu', 'serveur'], 'x-control': 'select' },
          label: { type: 'string', title: 'Nom', maxLength: 30, default: 'Étape', 'x-control': 'text', 'x-translatable': true }
        } },
        default: [{ device: 'routeur', label: 'Routeur' }]
      },
      tint: { type: 'string', format: 'color', title: 'Laiton', default: '#C79A45', description: 'Laiton des instruments', 'x-group': 'Matériaux', 'x-control': 'color' }
    } },
    language: 'fr', strings: { label: { text: 'Sonde', description: 'Nom du bouton' } },
    state: { type: 'object', properties: { devices: { type: 'string' }, labels: { type: 'string' }, tint: { type: 'string' } } },
    events: [], budgets: {},
    a11y: { description: 'Une sonde.', keyboard: 'Tab atteint son bouton.', motion: { pausable: true, respectsReducedMotion: true } },
    sandbox: { network: 'none' }
  });
  writeFixture(dir, 'objects/list-probe/object.js', [
    'export function mount(container, ctx) {',
    '  let props = { ...ctx.props };',
    "  const button = document.createElement('button');",
    "  button.type = 'button';",
    "  button.setAttribute('aria-label', ctx.t('label'));",
    '  container.appendChild(button);',
    "  const state = () => ({ devices: props.stops.map((stop) => stop.device).join(','), labels: props.stops.map((stop) => stop.label).join(','), tint: props.tint });",
    '  return { update(next) { props = { ...props, ...next }; }, getState: state, setState() {}, dispose() { button.remove(); } };',
    '}',
    ''
  ].join('\n'));
  writeFixture(dir, 'objects/list-probe/object.notes.md', 'Sonde des tests : une liste et une couleur de matériau.\n');
  writeFixture(dir, 'objects/list-probe/object.tests.json', { tests: [{
    name: 'takes a list', props: { stops: [{ device: 'routeur', label: 'A' }, { device: 'parefeu', label: 'B' }] },
    steps: [
      { action: 'expect-state', state: { devices: 'routeur,parefeu', labels: 'A,B', tint: '#C79A45' } },
      { action: 'set-props', props: { stops: [{ device: 'serveur', label: 'C' }], tint: '#8C8F94' } },
      { action: 'expect-state', state: { devices: 'serveur', labels: 'C', tint: '#8C8F94' } }
    ]
  }] });
  const screen = readJSON(dir, `screens/${LIST_PROBE.screen}.json`);
  screen.blocks.push(
    { id: LIST_PROBE.block, type: 'free-object', props: { object: 'list-probe', title: 'Sonde', aspectRatio: '16:9', textAlternative: 'Une sonde sans contenu.', props: { stops: [{ device: 'parefeu', label: 'Pare-feu' }, { device: 'serveur', label: 'Serveur' }] } } },
    { id: LIST_PROBE.button, type: 'button', props: { label: 'Changer le parcours' } }
  );
  screen.events = [...(screen.events || []), { id: 'chemin-list-change', on: { type: 'click', target: LIST_PROBE.button }, do: [{ type: 'set-object-props', block: LIST_PROBE.block, props: { stops: [{ device: 'routeur', label: 'Routeur' }] } }] }];
  writeJSON(dir, `screens/${LIST_PROBE.screen}.json`, screen);
}

// A free object whose events come late or on their way. Enter: "answered" arrives after a round
// trip to the host (its asset) and a pause of 300 ms, as from a loaded machine. set-props: "updated"
// at once, in answer to a notification (no reply: the event is on its way when the step ends).
// Its first test passes; its second must fail (the "updated" event is there).
export function addLateProbe(dir: string): void {
  writeFixture(dir, 'objects/late-probe/object.manifest.json', {
    manifestVersion: '0.1', id: 'late-probe', version: '1.0.0', title: 'Sonde lente',
    planRefs: { objectives: ['OBJ-1'], items: ['ITEM-2'] }, pedagogicalRole: 'visualisation',
    props: { type: 'object', properties: {} },
    language: 'fr', strings: { label: { text: 'Sonde', description: 'Nom du bouton' } },
    state: { type: 'object', properties: { answers: { type: 'integer' } } },
    events: [
      { name: 'answered', description: 'La réponse, après un aller-retour.', payload: { type: 'object', properties: { n: { type: 'integer' } } } },
      { name: 'updated', description: 'Les réglages ont changé.' }
    ],
    assets: [{ id: 'note', file: 'note.json', type: 'json' }],
    budgets: {},
    a11y: { description: 'Une sonde.', keyboard: 'Tab atteint son bouton.', motion: { pausable: true, respectsReducedMotion: true } },
    sandbox: { network: 'none' }
  });
  writeFixture(dir, 'objects/late-probe/note.json', { note: 'sonde' });
  writeFixture(dir, 'objects/late-probe/object.js', [
    'export function mount(container, ctx) {',
    '  let answers = 0;',
    "  const button = document.createElement('button');",
    "  button.type = 'button';",
    "  button.setAttribute('aria-label', ctx.t('label'));",
    '  container.appendChild(button);',
    '  const onKey = (event) => {',
    "    if (event.key !== 'Enter') return;",
    '    const n = ++answers;',
    "    ctx.host.asset('note').then(() => setTimeout(() => ctx.host.emit('answered', { n }), 300));",
    '  };',
    "  document.addEventListener('keydown', onKey);",
    "  return { update() { ctx.host.emit('updated', {}); }, getState: () => ({ answers }), setState() {}, dispose() { document.removeEventListener('keydown', onKey); } };",
    '}',
    ''
  ].join('\n'));
  writeFixture(dir, 'objects/late-probe/object.notes.md', 'Sonde des tests : des événements en retard ou en chemin.\n');
  writeFixture(dir, 'objects/late-probe/object.tests.json', { tests: [
    { name: 'waits for a late answer', steps: [
      { action: 'key', key: 'Enter' },
      { action: 'expect-event', name: 'answered', payload: { n: 1 } },
      { action: 'expect-no-event', name: 'answered' },
      { action: 'set-props', props: {} },
      { action: 'expect-event', name: 'updated' },
      { action: 'expect-state', state: { answers: 1 } }
    ] },
    { name: 'sees an event on its way', steps: [
      { action: 'set-props', props: {} },
      { action: 'expect-no-event', name: 'updated' }
    ] }
  ] });
}

// In the page: the player's debug handle (window.__elabora), as tests drive it. Page code reads it
// through PlayerWindow, which adds to whatever the program declares for window.
export interface PlayerHandle {
  course: { id: string };
  engine: { screens: { id: string; key: string; narration?: { lines: { id: string; start: number; end: number; words?: [string, number, number][] }[] } }[]; st: { visited: Set<string>; completed: Set<string> }; screenComplete(screen: unknown): boolean; getVar(id: string): unknown; visit(screen: unknown): void; markComplete(screen: unknown): boolean };
  readonly screen: string | undefined;
  step: { revealed: number; steps: number[] };
  go(id: string | number): void;
  openLayer(id: string): void;
  rooms(blockId: string): number[] | null;
  feedbackRooms(): { block: string; full: number; compact: number }[];
  state(): { screen?: string; status: string; suspendData: string };
  objectHost(blockId: string): { getState(): Promise<unknown> } | undefined;
  revealAll(): void;
  ready(): Promise<unknown>;
  reveal(step: number): void;
  timeline: {
    state(): { time: number; reached: number; duration: number; playing: boolean; step: number; refused: boolean; captions: boolean; rate: number; muted: boolean; line: string | null; word: string | null; caption: string | null; dragging: boolean } | null;
    play(): void;
    pause(): void;
    seek(time: number): void;
    advance(seconds: number): void;
    at(line: string, options?: { edge?: 'start' | 'end'; captions?: boolean }): boolean;
    atTime(time: number, options?: { captions?: boolean }): boolean;
    hiddenByTiming(): string[];
    toEnd(): Promise<unknown>;
    // The timelines of open layers (D62).
    layers(): string[];
    layer(id: string): Omit<PlayerHandle['timeline'], 'toEnd' | 'layers' | 'layer'> | null;
  };
}
export type PlayerWindow = Window & typeof globalThis & { __elabora: PlayerHandle };

// A free object that draws on a WebGL 2 canvas only when its colour changes: props.before until
// frame props.switchAt, props.after from then on ('red' or 'green'). Enter reads the pixel at the
// centre of its canvas (readPixels): { frame, read } in its state. For the frames object tests run
// dry: what a skipped draw would have left is shown or read here.
export function addDrawProbe(dir: string, tests: unknown[], { before = 'red', after = 'green', switchAt = 10 } = {}): void {
  const colour = { type: 'string', enum: ['red', 'green'], 'x-control': 'select' };
  writeFixture(dir, 'objects/draw-probe/object.manifest.json', {
    manifestVersion: '0.1', id: 'draw-probe', version: '1.0.0', title: 'Sonde de dessin',
    planRefs: { objectives: ['OBJ-1'], items: ['ITEM-2'] }, pedagogicalRole: 'visualisation',
    props: { type: 'object', properties: {
      before: { ...colour, title: 'Avant', default: before },
      after: { ...colour, title: 'Après', default: after },
      switchAt: { type: 'integer', title: 'Image du changement', minimum: 1, maximum: 1000, default: switchAt, 'x-control': 'slider' }
    } },
    language: 'fr', strings: { label: { text: 'Sonde', description: 'Nom du bouton' } },
    state: { type: 'object', properties: { frame: { type: 'integer' }, read: { type: ['string', 'null'] } } },
    events: [], budgets: {},
    a11y: { description: 'Une sonde.', keyboard: 'Tab atteint son bouton.', motion: { pausable: true, respectsReducedMotion: true } },
    sandbox: { network: 'none' }
  });
  writeFixture(dir, 'objects/draw-probe/object.js', [
    'export function mount(container, ctx) {',
    "  const canvas = document.createElement('canvas');",
    '  canvas.width = 64;',
    '  canvas.height = 64;',
    "  canvas.style.cssText = 'width: 100%; height: 100%; display: block';",
    '  container.appendChild(canvas);',
    "  const button = document.createElement('button');",
    "  button.type = 'button';",
    "  button.setAttribute('aria-label', ctx.t('label'));",
    '  container.appendChild(button);',
    "  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });",
    '  ctx.host.registerRenderer({ domElement: canvas, getContext: () => gl });',
    '  let frame = 0;',
    '  let drawn = null;',
    '  let read = null;',
    '  const off = ctx.host.onFrame(() => {',
    '    frame++;',
    '    const wanted = frame < ctx.props.switchAt ? ctx.props.before : ctx.props.after;',
    '    if (wanted === drawn) return;',
    '    drawn = wanted;',
    "    if (wanted === 'green') gl.clearColor(0, 1, 0, 1); else gl.clearColor(1, 0, 0, 1);",
    '    gl.clear(gl.COLOR_BUFFER_BIT);',
    '  });',
    '  const onKey = (event) => {',
    "    if (event.key !== 'Enter') return;",
    '    const pixel = new Uint8Array(4);',
    '    gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);',
    "    read = pixel[1] > 128 ? 'green' : pixel[0] > 128 ? 'red' : 'none';",
    '  };',
    "  document.addEventListener('keydown', onKey);",
    "  return { getState: () => ({ frame, read }), setState() {}, update() {}, dispose() { off(); document.removeEventListener('keydown', onKey); } };",
    '}',
    ''
  ].join('\n'));
  writeFixture(dir, 'objects/draw-probe/object.notes.md', 'Sonde des tests : ce que les images sautées auraient dessiné.\n');
  writeFixture(dir, 'objects/draw-probe/object.tests.json', { tests });
}
