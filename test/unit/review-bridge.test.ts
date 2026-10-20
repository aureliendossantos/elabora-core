import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  REVIEW_PROTOCOL, SAID_MAX, SIZE_RULES, acceptsFrom, anchorFor, blockAt, goTarget, normalizeWord, otherVersion, readPageMessage, reviewOrigin, reviewPeer, saidAround, textScale, widestColumn, wordAt, wordTime
} from '@elabora/player/review-protocol';
import type { LocationMessage, ReviewBlock } from '@elabora/player/review-protocol';
import { build, WEB_REVIEW_DEFAULTS } from '@elabora/node/build';
import { readZip } from '@elabora/node/zip';
import { createMcpServer } from '@elabora/cli/mcp';
import { openProject } from '@elabora/engine';
import type { BuildView, ResponseMessage } from '@elabora/engine';
import { ROOT, copyExample, codes } from '../helpers.ts';

// The review bridge (docs/review-bridge.md, docs/decisions.md D42): the protocol elabora-review/1 (its
// messages, the origins it takes, the anchor), the text sizes it reports, and the review build
// (elabora/review.js in review builds only; every other build unchanged), through the build, the
// CLI, the MCP server and the engine. The bridge itself runs in Chrome: test/e2e/review.test.ts.

const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = (prefix: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temporary.push(dir); return dir; };
const course = () => { const dir = copyExample(); temporary.push(dir); return dir; };
const REVUE = 'https://revue.elabora.studio';

test('review origins: an https origin, or http on this computer; never a path, a wildcard or credentials', () => {
  for (const [value, origin] of [
    [REVUE, REVUE], [`${REVUE}/`, REVUE], ['https://REVUE.elabora.studio', REVUE], ['https://revue.elabora.studio:8443', 'https://revue.elabora.studio:8443'],
    ['http://localhost:5173', 'http://localhost:5173'], ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'], ['http://[::1]:3000', 'http://[::1]:3000'], ['http://revue.localhost:3000', 'http://revue.localhost:3000']
  ] as const) assert.equal(reviewOrigin(value), origin, value);
  for (const value of ['revue.elabora.studio', 'http://revue.elabora.studio', `${REVUE}/revue`, `${REVUE}/?a=1`, `${REVUE}#x`, 'https://user:pw@revue.elabora.studio', 'https://*.elabora.studio', '*', 'ftp://localhost', 'https://revue.elabora.studio /', 'null', ''])
    assert.equal(reviewOrigin(value), null, value);
});

test('origin filtering: only the embedder, only a named origin, only the page once it spoke', () => {
  const origins = [REVUE, 'http://localhost:5173'];
  assert.deepEqual(reviewPeer(origins, REVUE), { peer: REVUE, silent: false }, 'the browser names the embedder: posts go to it only');
  assert.deepEqual(reviewPeer(origins, 'https://evil.example'), { peer: null, silent: true }, 'an embedder not named gets nothing');
  assert.deepEqual(reviewPeer(origins, undefined), { peer: null, silent: false }, 'no ancestorOrigins (Firefox): every named origin until one speaks');
  assert.equal(acceptsFrom(origins, null, { origin: REVUE, fromParent: true }), true);
  assert.equal(acceptsFrom(origins, null, { origin: 'http://localhost:5173', fromParent: true }), true);
  assert.equal(acceptsFrom(origins, null, { origin: 'https://evil.example', fromParent: true }), false, 'another origin');
  assert.equal(acceptsFrom(origins, null, { origin: REVUE, fromParent: false }), false, 'another window (a free object, a popup)');
  assert.equal(acceptsFrom(origins, REVUE, { origin: 'http://localhost:5173', fromParent: true }), false, 'once the page spoke, only its origin');
  assert.equal(acceptsFrom(origins, REVUE, { origin: 'null', fromParent: true }), false, 'an opaque origin');
});

test('page messages: read and checked, another version recognised, anything else ignored', () => {
  const p = REVIEW_PROTOCOL;
  assert.equal(p, 'elabora-review/1');
  assert.deepEqual(readPageMessage({ protocol: p, type: 'hello' }), { type: 'hello' });
  assert.deepEqual(readPageMessage({ protocol: p, type: 'pause', id: 3 }), { type: 'pause', id: 3 });
  assert.deepEqual(readPageMessage({ protocol: p, type: 'resume', id: 'r' }), { type: 'resume', id: 'r' });
  assert.deepEqual(readPageMessage({ protocol: p, type: 'layout', inset: { right: 352 } }), { type: 'layout', inset: { right: 352 } });
  assert.deepEqual(readPageMessage({ protocol: p, type: 'layout', inset: { right: -4 } }), { type: 'layout', inset: { right: 0 } });
  assert.deepEqual(readPageMessage({ protocol: p, type: 'measure', id: 1, frame: { width: 1150, height: 789 } }), { type: 'measure', id: 1, frame: { width: 1150, height: 789 } });
  assert.deepEqual(readPageMessage({ protocol: p, type: 'scroll', by: { x: 0, y: 120 }, at: { x: 400, y: 300 } }), { type: 'scroll', by: { x: 0, y: 120 }, at: { x: 400, y: 300 } });
  assert.deepEqual(readPageMessage({ protocol: p, type: 'go', id: 'g', anchor: { version: '1.0.0', language: 'fr', screen: 'k3', block: 'b1', step: 2, layer: 'l', time: 4.2, line: 'l2', word: 'imprimante', occurrence: 2, point: { x: 0.5, y: 0.5 }, frame: { width: 1600, height: 744 } } }),
    { type: 'go', id: 'g', highlight: true, anchor: { screen: 'k3', block: 'b1', step: 2, layer: 'l', time: 4.2, line: 'l2', word: 'imprimante', occurrence: 2 } }, 'a whole comment anchor is a go target');
  assert.deepEqual(readPageMessage({ protocol: p, type: 'go', anchor: { screen: 'k3' }, highlight: false }), { type: 'go', highlight: false, anchor: { screen: 'k3' } });
  for (const data of [null, 'hello', [], { type: 'hello' }, { protocol: 'elabora-review/2', type: 'hello' }, { protocol: p, type: 'eval', code: '1' }, { protocol: p, type: 'go', anchor: { block: 'b1' } },
    { protocol: p, type: 'layout', inset: { right: '10px' } }, { protocol: p, type: 'measure', frame: { width: 0, height: 700 } }, { protocol: p, type: 'scroll', by: { x: Infinity, y: 0 } }])
    assert.equal(readPageMessage(data), null, JSON.stringify(data));
  assert.equal(otherVersion({ protocol: 'elabora-review/2', type: 'hello' }), true);
  assert.equal(otherVersion({ protocol: p, type: 'hello' }), false);
  assert.equal(otherVersion({ type: 'elabora/render' }), false, 'the canvas protocol is not this one');
  // Fields of the wrong kind are left out of a go target, not guessed.
  assert.deepEqual(goTarget({ screen: 'k3', step: 0, time: -1, occurrence: 1, word: ' ', layer: 4 }), { screen: 'k3' });
});

test('text sizes follow the frame as player.css says; the widest column is the cap or the room left', () => {
  // The rules are the media queries of player.css that size html.
  const css = fs.readFileSync(path.join(ROOT, 'packages/player/src/player.css'), 'utf8');
  const queries = [...css.matchAll(/@media ([^{]+)\{ html \{ font-size: ([\d.]+)%; \} \}/g)].map(([, query, percent]) => ({ query: query.trim(), scale: Number(percent) / 100 }));
  const written = SIZE_RULES.map((rule) => ({
    query: [`(max-width: ${rule.maxWidth}px)`, ...(rule.maxHeight !== undefined ? [`(max-height: ${rule.maxHeight}px)`] : []), ...(rule.portraitMaxWidth !== undefined ? [`(orientation: portrait) and (max-width: ${rule.portraitMaxWidth}px)`] : [])].join(', '),
    scale: rule.scale
  }));
  assert.deepEqual(queries, written);
  // The sizes measured in the real player for the docking rule: 16 px above 1500 × 840,
  // 15 above 1360 × 760, 14 below; a phone 15.
  const px = (width: number, height: number) => 16 * textScale({ width, height });
  assert.deepEqual([px(1600, 900), px(1600, 790), px(1600, 744), px(1470, 789), px(1150, 789), px(1536, 684), px(1280, 674), px(375, 812), px(1024, 1366)], [16, 15, 14, 15, 14, 14, 14, 15, 15]);
  // 68.75 rem at 14 px: 962.5 px, the 963 px measured; the room left wins in a narrow frame.
  const rules = { baseFontSize: 16, capRem: 68.75, paddingRem: 1.25 };
  assert.deepEqual(widestColumn({ width: 1600, height: 744 }, rules), { fontSize: 14, widest: 962.5 });
  assert.deepEqual(widestColumn({ width: 1470, height: 789 }, rules), { fontSize: 15, widest: 1031.25 });
  assert.deepEqual(widestColumn({ width: 1150, height: 789 }, rules), { fontSize: 14, widest: 962.5 });
  assert.deepEqual(widestColumn({ width: 900, height: 700 }, { ...rules, scrollbar: 15 }), { fontSize: 14, widest: 850 });
  // The docking rule the page applies: dock when neither the text size nor the widest column change.
  const docks = (frame: { width: number; height: number }, panel: number) => {
    const full = widestColumn(frame, rules);
    const docked = widestColumn({ width: frame.width - panel, height: frame.height }, rules);
    return full.fontSize === docked.fontSize && full.widest === docked.widest;
  };
  assert.deepEqual([docks({ width: 1600, height: 744 }, 320), docks({ width: 1470, height: 789 }, 320), docks({ width: 1536, height: 684 }, 320), docks({ width: 1280, height: 674 }, 320)], [true, false, true, false]);
});

const block = (id: string, rect: [number, number, number, number], extra: Partial<ReviewBlock> = {}): ReviewBlock => ({
  id, type: 'text', kind: 'text', name: 'Texte', label: null, order: 1, rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }, layer: null, parent: null, hidden: false, ...extra
});

test('pointing and anchors: the innermost visible block, a layer before the screen, the point in its box', () => {
  const blocks = [
    block('carte', [100, 100, 800, 400], { order: 1, type: 'card', kind: 'component' }),
    block('titre', [120, 120, 300, 40], { order: 2, parent: 'carte', kind: 'heading' }),
    block('plus-tard', [120, 200, 300, 40], { order: 3, parent: 'carte', hidden: true }),
    block('objet', [100, 600, 800, 300], { order: 4, type: 'free-object', kind: 'free-object', object: true })
  ];
  assert.equal(blockAt(blocks, { x: 200, y: 130 })?.id, 'titre', 'the block in the slot before its component');
  assert.equal(blockAt(blocks, { x: 200, y: 210 })?.id, 'carte', 'a hidden block takes no point');
  assert.equal(blockAt(blocks, { x: 500, y: 700 })?.id, 'objet', 'a free object is one block');
  assert.equal(blockAt(blocks, { x: 50, y: 50 }), null);
  const layered = [...blocks, block('rappel', [400, 300, 400, 200], { order: 5, layer: 'rappel-regle' })];
  assert.equal(blockAt(layered, { x: 500, y: 350 })?.id, 'rappel', 'an open layer takes the point');

  const ready = { course: { id: 'diagnostic-reseau', version: '1.2.0', title: 'x' }, language: 'fr' };
  const location: Omit<LocationMessage, 'protocol' | 'type'> = { screen: 'k2', index: 1, step: 2, steps: [1, 2], layer: null, time: 4.21234, duration: 9, playing: false, line: 'l2', word: 'imprimante', occurrence: 2, held: true };
  const frame = { width: 1600.4, height: 744 };
  const titre = blockAt(blocks, { x: 270, y: 130 });
  assert.deepEqual(JSON.stringify(anchorFor(ready, location, frame, { block: titre, point: { x: 270, y: 130 } })),
    JSON.stringify({ version: '1.2.0', language: 'fr', screen: 'k2', block: 'titre', step: 2, time: 4.212, line: 'l2', word: 'imprimante', occurrence: 2, point: { x: 0.5, y: 0.25 }, frame: { width: 1600, height: 744 } }),
    'the contract\'s fields, in its order');
  assert.deepEqual(anchorFor(ready, { screen: 'k1', index: 0, step: 1, steps: [1], layer: 'rappel-regle', held: false }, { width: 400, height: 200 }, { block: null, point: { x: 100, y: 150 } }),
    { version: '1.2.0', language: 'fr', screen: 'k1', step: 1, layer: 'rappel-regle', point: { x: 0.25, y: 0.75 }, frame: { width: 400, height: 200 } }, 'the whole screen: the point in the frame');
  assert.deepEqual(anchorFor(ready, { screen: 'k1', index: 0, step: 1, steps: [1], layer: null, held: false }, { width: 400, height: 200 }),
    { version: '1.2.0', language: 'fr', screen: 'k1', step: 1, frame: { width: 400, height: 200 } }, 'nothing pointed: no point');

  // The line's text and speaker, after the word and before the point.
  const spoken = { ...location, said: "  Ni l'imprimante,\n ni le partage de fichiers ne marchent.", speaker: 'Marc' };
  assert.deepEqual(Object.keys(anchorFor(ready, spoken, frame, { block: titre, point: { x: 270, y: 130 } })),
    ['version', 'language', 'screen', 'block', 'step', 'time', 'line', 'word', 'occurrence', 'said', 'speaker', 'point', 'frame']);
  assert.deepEqual([anchorFor(ready, spoken, frame).said, anchorFor(ready, spoken, frame).speaker], ["Ni l'imprimante, ni le partage de fichiers ne marchent.", 'Marc']);
  const { line: _line, ...unspoken } = spoken;
  assert.equal(anchorFor(ready, unspoken, frame).said, undefined, 'no line, no text');
});

test('the line said: kept whole up to its limit, else cut around the word at spaces', () => {
  assert.equal(saidAround('Bonjour, voici le ticket de Marc.'), 'Bonjour, voici le ticket de Marc.');
  const long = `${'Au début, '.repeat(30)}l'imprimante ne répond plus${', puis plus rien'.repeat(30)}.`;
  const cut = saidAround(long, "l'imprimante");
  assert.ok(cut.length <= SAID_MAX, String(cut.length));
  assert.ok(cut.startsWith('…') && cut.endsWith('…'), cut);
  assert.match(cut, /l'imprimante ne répond plus/);
  assert.doesNotMatch(cut, /^…\S*[a-z]Au|,…$/, 'cut at spaces');
  const twice = `${'un mot '.repeat(10)}${'x '.repeat(200)}mot final`;
  assert.match(saidAround(twice, 'mot', 11), /mot final…?$/, 'the occurrence named');
  assert.ok(saidAround(long).startsWith('Au début'), 'no word: the start');
});

test('words: the word said at a time with its occurrence, and when a word is said', () => {
  const words: [string, number, number][] = [['Ni', 2, 2.2], ["l'", 2.3, 2.4], ['imprimante', 2.4, 2.9], ['ni', 3, 3.2], ['le', 3.3, 3.4], ['Partage', 3.5, 4]];
  assert.equal(wordAt(words, 1), null);
  assert.deepEqual(wordAt(words, 2.5), { index: 2, word: 'imprimante', occurrence: 1 });
  assert.deepEqual(wordAt(words, 3.1), { index: 3, word: 'ni', occurrence: 2 }, 'Ni and ni are the same word');
  assert.equal(wordTime(words, 'imprimante'), 2.4);
  assert.equal(wordTime(words, 'ni', 2), 3);
  assert.equal(wordTime(words, 'partage'), 3.5);
  assert.equal(wordTime(words, 'ni le'), 3, 'a few words: the first one');
  assert.equal(wordTime(words, 'serveur'), null);
  assert.equal(wordTime(words, 'ni', 3), null);
  assert.equal(normalizeWord('L’Imprimante'), "l'imprimante");
});

const fileText = (files: Map<string, Buffer>, name: string) => files.get(name)?.toString() ?? '';
const courseData = (files: Map<string, Buffer>) => JSON.parse(fileText(files, 'elabora/course.js').replace(/^window\.ELABORA_COURSE = /, '').replace(/;\n$/, ''));

test('review build: elabora/review.js and its script, the origins and languages in the course data; every other build unchanged, byte for byte', async () => {
  const dir = course();
  fs.mkdirSync(path.join(dir, 'translations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'translations/en.xlf'), '<?xml version="1.0"?><xliff version="2.0" srcLang="fr" trgLang="en"></xliff>\n');
  const review = { origins: ['http://localhost:5173', `${REVUE}/`, REVUE] };
  const [a, b] = [await build(dir, { target: 'web', web: { review }, out: tmp('elabora-r1-') }), await build(dir, { target: 'web', web: { review }, out: tmp('elabora-r2-') })];
  assert.ok(a.ok && b.ok && a.zipPath, JSON.stringify(a.diagnostics.filter((d) => d.severity === 'error')));
  assert.equal(a.report.package.sha256, b.report.package.sha256, 'deterministic');
  const reviewed = readZip(fs.readFileSync(a.zipPath)).files;
  assert.match(fileText(reviewed, 'elabora/review.js'), /^\/\* Elabora review bridge .+ — Apache-2\.0 \*\/\n/);
  assert.match(fileText(reviewed, 'index.html'), /<script src="elabora\/player\.js"><\/script>\n<script src="elabora\/review\.js"><\/script>\n<\/body>/);
  assert.match(fileText(reviewed, 'index.html'), /<meta name="robots" content="noindex">/, 'a review link stays out of search engines');
  // The review's defaults, the origins sorted and each once, the course's languages.
  assert.deepEqual(courseData(reviewed).delivery, { target: 'web', progress: 'none', navigation: 'free', review: { origins: ['http://localhost:5173', REVUE], languages: ['fr', 'en'] } });
  assert.deepEqual(a.report.web, { ...WEB_REVIEW_DEFAULTS, url: null, image: null, review: { origins: ['http://localhost:5173', REVUE] } });
  assert.match(fs.readFileSync(a.reportPath.replace('.report.json', '.proof.md'), 'utf8'), /Revue : pont elabora-review\/1 avec les pages de `http:\/\/localhost:5173`, `https:\/\/revue\.elabora\.studio`/);
  // The bridge keeps to the rules of the player: no unload, no network, no eval.
  const bridge = fileText(reviewed, 'elabora/review.js');
  assert.doesNotMatch(bridge, /unload|XMLHttpRequest|fetch\(|WebSocket|EventSource|sendBeacon|eval\(|new Function/);
  assert.doesNotMatch(bridge, /postMessage\([^)]*["']\*["']/, 'never posts to any origin');

  // The same settings without review: no bridge, and the player's files are the review build's.
  const plain = await build(dir, { target: 'web', web: { progress: 'none', navigation: 'free', noindex: true }, out: tmp('elabora-r3-') });
  assert.ok(plain.ok && plain.zipPath);
  const files = readZip(fs.readFileSync(plain.zipPath)).files;
  assert.equal(files.has('elabora/review.js'), false);
  assert.doesNotMatch(fileText(files, 'index.html'), /review/);
  assert.doesNotMatch(fileText(files, 'elabora/course.js'), /"review"/);
  assert.equal(plain.report.web?.review, undefined);
  for (const name of files.keys()) if (name.startsWith('elabora/') && name !== 'elabora/course.js') assert.ok(files.get(name)?.equals(reviewed.get(name) as Buffer), name);
  assert.deepEqual([...reviewed.keys()].filter((name) => !files.has(name)), ['elabora/review.js']);
  assert.doesNotMatch(fileText(files, 'elabora/player.js'), /elabora-review/, 'the player knows nothing of the bridge');
  // Explicit settings win over the review's defaults.
  const kept = await build(dir, { target: 'web', web: { review, progress: 'local', navigation: 'authored', noindex: false }, out: tmp('elabora-r4-') });
  assert.ok(kept.ok);
  assert.deepEqual({ ...kept.report.web, review: undefined }, { progress: 'local', navigation: 'authored', noindex: false, url: null, image: null, review: undefined });
});

test('review build: an origin that is not one stops it; review settings outside the web target are refused', async () => {
  const dir = course();
  const out = tmp('elabora-r5-');
  for (const origins of [['revue.elabora.studio'], [`${REVUE}/revue`], ['http://revue.elabora.studio'], ['*'], []]) {
    const result = await build(dir, { target: 'web', web: { review: { origins } }, out });
    assert.equal(result.ok, false, JSON.stringify(origins));
    assert.deepEqual(codes(result.diagnostics).filter((code) => code.startsWith('E_WEB')), ['E_WEB_REVIEW_ORIGIN'], JSON.stringify(origins));
  }
  await assert.rejects(build(dir, { web: { review: { origins: [REVUE] } } }), /for the web target/);
  await assert.rejects(build(dir, { target: 'web', web: { review: { origins: REVUE } as unknown as { origins: string[] } } }), /web review is \{ origins: string\[\] \}/);
});

function elabora(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { cwd: ROOT, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

test('elabora build --review-origin, repeatable; MCP elabora_build web.review; the engine build request', async () => {
  const dir = course();
  const refused = await elabora(['build', dir, '--review-origin', REVUE]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--review-origin: for --target web only/);
  const bad = await elabora(['build', dir, '--target', 'web', '--review-origin', 'revue.elabora.studio', '--out', tmp('elabora-r6-')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /E_WEB_REVIEW_ORIGIN/);
  const made = await elabora(['build', dir, '--target', 'web', '--review-origin', REVUE, '--review-origin', 'http://localhost:5173', '--out', tmp('elabora-r7-'), '--json']);
  assert.equal(made.status, 0, made.stderr);
  const printed = JSON.parse(made.stdout);
  assert.deepEqual(printed.web, { progress: 'none', navigation: 'free', noindex: true, url: null, image: null, review: { origins: ['http://localhost:5173', REVUE] } });
  assert.ok(fs.existsSync(path.join(printed.dir, 'elabora/review.js')));
  const local = await elabora(['build', dir, '--target', 'web', '--review-origin', REVUE, '--progress', 'local', '--out', tmp('elabora-r8-'), '--json']);
  assert.equal(JSON.parse(local.stdout).web.progress, 'local', 'a flag given wins over the review\'s default');

  const server = createMcpServer(dir);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  const result = await client.callTool({ name: 'elabora_build', arguments: { target: 'web', web: { review: { origins: [REVUE] } } } });
  const body = JSON.parse((result.content as { type: 'text'; text: string }[])[0].text);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.deepEqual(body.web.review, { origins: [REVUE] });
  assert.ok(fs.existsSync(path.join(body.dir, 'elabora/review.js')));
  await client.close();

  const session = await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 });
  try {
    const response = await session.handle({ kind: 'request', id: 'r1', type: 'build', params: { target: 'web', web: { review: { origins: [REVUE, 'http://localhost:5173'] } } } }) as ResponseMessage;
    assert.equal(response.ok, true, JSON.stringify(response));
    const view = (response.ok ? response.result : null) as BuildView;
    assert.ok(view.ok && view.dir && fs.existsSync(path.join(view.dir, 'elabora/review.js')));
    for (const web of [{ review: REVUE }, { review: { origins: REVUE } }, { review: { origins: [1] } }, { review: { origins: [REVUE], comments: true } }]) {
      const answer = await session.handle({ kind: 'request', id: 'r2', type: 'build', params: { target: 'web', web } }) as ResponseMessage;
      assert.equal(answer.ok, false, JSON.stringify(web));
      if (!answer.ok) assert.equal(answer.error.kind, 'bad-request', JSON.stringify(web));
    }
  } finally {
    await session.close();
  }
});
