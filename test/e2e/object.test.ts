import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { ROOT, copyExample, readJSON, writeJSON, addViewProbe, addListProbe, addLateProbe, addDrawProbe } from '../helpers.ts';
import { replayObject } from '@elabora/node/replay';
import { screenshot } from '@elabora/node/capture';
import { testObject } from '@elabora/node/objects/test';
import { launchBrowser } from '@elabora/node/emulator/browser';
import type { DryFrames } from '@elabora/player/dry-frames';

test('the example free object passes gates 2 to 6', { timeout: 180000 }, async () => {
  const dir = copyExample();
  let r = await testObject(dir, 'diagnostic-reseau');
  // A platform without checked-in baselines records them first; the next run compares them.
  if (r.ok && r.gates.visual === 'recorded') r = await testObject(dir, 'diagnostic-reseau');
  assert.ok(r.ok, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'), null, 1));
  for (const gate of ['smoke', 'behaviour', 'budget', 'visual', 'accessibility'] as const) assert.equal(r.gates[gate], 'passed', gate);
  // Nothing looks at the smoke test's frames, nor at those of tests without snapshots: decided dry.
  assert.equal(r.gates.frames?.smoke, 'dry');
  assert.equal(r.gates.frames?.tests['Hors procédure : indice après deux écarts'], 'dry');
});

test('a behaviour regression fails gate 3', { timeout: 180000 }, async () => {
  const dir = copyExample();
  const file = path.join(dir, 'objects/diagnostic-reseau/object.js');
  // Bug: the failing device is never detected.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("const faulty = id === props.failingDevice;", 'const faulty = false;'));
  const r = await testObject(dir, 'diagnostic-reseau');
  assert.equal(r.gates.behaviour, 'failed');
  assert.ok(r.diagnostics.some((d) => d.code === 'E_GATE_BEHAVIOUR'));
});

test('consecutive expect-event steps check the events of the same action', { timeout: 180000 }, async () => {
  const dir = copyExample();
  const file = path.join(dir, 'objects/diagnostic-reseau/object.tests.json');
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  // A wrong click emits device_inspected then hint_shown.
  t.tests = [{ name: 'two events from one click', props: { hintAfterErrors: 1 }, steps: [
    { action: 'click', object: 'serveur' },
    { action: 'expect-event', name: 'device_inspected', payload: { device: 'serveur' } },
    { action: 'expect-event', name: 'hint_shown' },
    { action: 'expect-no-event', name: 'device_inspected' },
    { action: 'expect-no-event', name: 'completed' }
  ] }];
  fs.writeFileSync(file, JSON.stringify(t));
  const r = await testObject(dir, 'diagnostic-reseau');
  assert.equal(r.gates.behaviour, 'passed', JSON.stringify(r.gates.tests));
  assert.equal(r.gates.perf?.webglContexts, 1);
});

test('event expectations wait for the frame: a late event is awaited, an event on its way is seen', { timeout: 180000 }, async () => {
  const dir = copyExample();
  addLateProbe(dir);
  const r = await testObject(dir, 'late-probe');
  const [late, onItsWay] = r.gates.tests || [];
  assert.ok(late?.ok, JSON.stringify(late));
  assert.equal(onItsWay?.ok, false);
  assert.deepEqual(onItsWay.failures, ['step 2 (expect-no-event): unexpected "updated" event {}']);
  for (const gate of ['smoke', 'accessibility'] as const) assert.equal(r.gates[gate], 'passed', gate);
});

test('an object stuck in a loop fails the smoke gate instead of hanging the run', { timeout: 120000 }, async () => {
  const dir = copyExample();
  const file = path.join(dir, 'objects/diagnostic-reseau/object.js');
  // Stuck when the smoke gate asks for the state after its 300 frames, on fast and slow machines
  // alike (a loop started 800 ms after mount came after the whole gate on Linux CI).
  const code = fs.readFileSync(file, 'utf8');
  assert.ok(code.includes('getState() {'));
  fs.writeFileSync(file, code.replace('getState() {', 'getState() { for (;;) {}'));
  const started = Date.now();
  const r = await testObject(dir, 'diagnostic-reseau', { stallMs: 5000, only: 'none' });
  assert.equal(r.gates.smoke, 'failed');
  assert.ok(r.diagnostics.some((d) => d.code === 'E_GATE_SMOKE' && /stuck in a loop/.test(d.message)), JSON.stringify(r.diagnostics));
  assert.equal(r.gates.behaviour, 'not-run (object stuck)');
  assert.ok(Date.now() - started < 60000);
});

test('screenshots render a screen with its free object', { timeout: 120000 }, async () => {
  const r = await screenshot(copyExample(), { screen: 'simulation' });
  assert.ok(r.ok);
  assert.ok(r.png.length > 20000);
  assert.deepEqual(r.consoleErrors, []);
});

test('object tests set where the frame is: view, then set-view (host.onView)', { timeout: 180000 }, async () => {
  const dir = copyExample();
  addViewProbe(dir);
  const r = await testObject(dir, 'view-probe');
  assert.equal(r.gates.behaviour, 'passed', JSON.stringify(r.gates.tests));
});

test('object tests give a free object a list prop and a material colour, then change them (set-props)', { timeout: 180000 }, async () => {
  const dir = copyExample();
  addListProbe(dir);
  const r = await testObject(dir, 'list-probe');
  assert.equal(r.gates.behaviour, 'passed', JSON.stringify(r.gates.tests));
});

test('an object test replays in the course page: its snapshots on a contact sheet, its expectations checked', { timeout: 180000 }, async () => {
  const dir = copyExample();
  const tests = JSON.parse(fs.readFileSync(path.join(dir, 'objects/diagnostic-reseau/object.tests.json'), 'utf8'));
  const r = await replayObject(dir, 'diagnostic-reseau', { test: tests.tests[0].name, width: 1280, height: 720 });
  assert.ok(r.error === undefined, r.error);
  assert.equal(r.screen, 'simulation');
  assert.ok(r.frames.length >= 1 && r.frames[r.frames.length - 1].name === 'end');
  assert.deepEqual(r.failures, []);
  assert.ok(r.png.length > 20000);
  const missing = await replayObject(dir, 'diagnostic-reseau', { test: 'no such test' });
  assert.ok(missing.error !== undefined && /No test/.test(missing.error));
});

test('a test that reads its drawing back is decided with every frame drawn, not by the frames it ran dry', { timeout: 180000 }, async () => {
  const dir = copyExample();
  // Dry, the switch to green at frame 10 is not drawn: the pixel read would still be red.
  addDrawProbe(dir, [{ name: 'reads its pixel', steps: [{ action: 'step', frames: 20 }, { action: 'key', key: 'Enter' }, { action: 'expect-state', state: { read: 'red' } }] }]);
  const r = await testObject(dir, 'draw-probe');
  assert.equal(r.gates.smoke, 'passed');
  assert.equal(r.gates.behaviour, 'failed');
  assert.match(r.gates.tests?.[0].failures.join(' ') ?? '', /"read":"green"/);
  assert.equal(r.gates.frames?.tests['reads its pixel'], 'every frame (readPixels of a drawing a dry frame skipped)');
});

test('a snapshot of a canvas that dry frames left stale is taken with every frame drawn', { timeout: 180000 }, async () => {
  const dir = copyExample();
  const tests = [{ name: 'colour', steps: [{ action: 'step', frames: 20 }, { action: 'snapshot', name: 'end' }] }];
  addDrawProbe(dir, tests, { before: 'green', after: 'green' });
  const first = await testObject(dir, 'draw-probe');
  assert.equal(first.gates.visual, 'recorded', JSON.stringify(first.diagnostics));
  assert.equal(first.gates.frames?.tests.colour, 'every frame (records baselines)');
  // Now the object turns red at frame 10 and draws only then: dry, that draw is skipped and the
  // canvas would still show the green of the baseline.
  addDrawProbe(dir, tests, { before: 'green', after: 'red' });
  const second = await testObject(dir, 'draw-probe');
  assert.equal(second.gates.visual, 'failed');
  assert.ok(second.diagnostics.some((d) => d.code === 'E_GATE_VISUAL'));
  assert.equal(second.gates.frames?.tests.colour, 'every frame (a snapshot of a canvas a dry frame left stale)');
});

test('a snapshot after the WebGL context was lost is not compared: the test runs again, then says the context was lost', { timeout: 180000 }, async () => {
  const dir = copyExample();
  // The probe loses its context on the key « l », as a GPU process that gives way under load would.
  addDrawProbe(dir, [{ name: 'lost', steps: [{ action: 'step', frames: 20 }, { action: 'key', key: 'l' }, { action: 'step', frames: 1 }, { action: 'snapshot', name: 'after' }] }], { before: 'green', after: 'green' });
  const file = path.join(dir, 'objects/draw-probe/object.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("    if (event.key !== 'Enter') return;", "    if (event.key === 'l') gl.getExtension('WEBGL_lose_context').loseContext();\n    if (event.key !== 'Enter') return;"));
  const r = await testObject(dir, 'draw-probe', { updateSnapshots: true });
  assert.deepEqual(r.diagnostics.filter((d) => d.code.startsWith('E_GATE')).map((d) => d.code), ['E_GATE_CONTEXT_LOST'], JSON.stringify(r.diagnostics));
  assert.equal(r.gates.visual, 'failed');
  assert.match(r.gates.frames?.tests.lost ?? '', /the WebGL context was lost/);
  assert.ok(!fs.existsSync(path.join(dir, 'objects/draw-probe/__snapshots__')) || !fs.readdirSync(path.join(dir, 'objects/draw-probe/__snapshots__')).some((name) => name.startsWith('lost--')), 'no blank baseline recorded');
});

test('with Elabora\'s Electron, a snapshot shows the object down to its last row: a bar at its bottom is in it', { timeout: 180000, skip: !process.env.ELABORA_ELECTRON_EXECUTABLE && 'no Electron (ELABORA_ELECTRON_EXECUTABLE)' }, async () => {
  // The hidden window's content is the page: on macOS a window's size counts its title bar, which took
  // the bottom 28 px off every snapshot (an object's controls cut).
  const dir = copyExample();
  addDrawProbe(dir, [{ name: 'bar', steps: [{ action: 'step', frames: 2 }, { action: 'snapshot', name: 'bottom' }] }], { before: 'green', after: 'green' });
  const file = path.join(dir, 'objects/draw-probe/object.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("  container.appendChild(button);", "  container.appendChild(button);\n  const bar = document.createElement('div');\n  bar.style.cssText = 'position: fixed; left: 0; right: 0; bottom: 0; height: 12px; background: #1d4ed8';\n  container.appendChild(bar);"));
  const r = await testObject(dir, 'draw-probe', { browser: 'electron', updateSnapshots: true });
  assert.equal(r.gates.visual, 'recorded', JSON.stringify(r.diagnostics));
  const folder = path.join(dir, 'objects/draw-probe/__snapshots__');
  const shot = fs.readdirSync(folder).find((name) => name.startsWith('bar--bottom'));
  assert.ok(shot, 'the snapshot');
  const { PNG } = createRequire(import.meta.url)('pngjs');
  const image = PNG.sync.read(fs.readFileSync(path.join(folder, shot)));
  const last = ((image.height - 1) * image.width + Math.floor(image.width / 2)) * 4;
  const [r0, g0, b0] = image.data.slice(last, last + 3);
  assert.ok(b0 > 150 && r0 < 90 && g0 < 120, `the last row is the bar's blue (${[r0, g0, b0]})`);
});

test('dry frames skip draws, track what they leave stale until drawn again, and report any use of it', { timeout: 120000 }, async () => {
  const bundle = await esbuild.build({ entryPoints: [path.join(ROOT, 'packages/player/src/dry-frames.ts')], bundle: true, format: 'iife', globalName: 'ElaboraDry', write: false, logLevel: 'error' });
  const browser = await launchBrowser('chromium');
  type Seen = [number, boolean, string | null][];
  // Each scenario in a page of its own: install() wraps the canvas APIs of the page.
  const scenario = async (run: () => Seen): Promise<Seen> => {
    const page = await browser.newPage();
    try {
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      return await page.evaluate(run);
    } finally { await page.close(); }
  };
  try {
    const canvas = await scenario(() => {
      const dry = (Reflect.get(window, 'ElaboraDry') as { createDryFrames(): DryFrames }).createDryFrames();
      dry.install();
      const seen: Seen = [];
      const look = () => { const r = dry.report(); seen.push([r.skipped, r.stale, r.unsafe]); };
      const gl = document.body.appendChild(document.createElement('canvas')).getContext('webgl2');
      if (!gl) return seen;
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); look();
      dry.setDry('all'); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); look();
      dry.setDry(false); gl.enable(gl.SCISSOR_TEST); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); look();
      gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, false, true, true); gl.clear(gl.COLOR_BUFFER_BIT); look();
      gl.colorMask(true, true, true, true); gl.clear(gl.COLOR_BUFFER_BIT); look();
      gl.drawArrays(gl.POINTS, 0, 0); look();
      return seen;
    });
    assert.deepEqual(canvas, [
      [0, false, null], // drawn
      [1, true, null], // a clear skipped: the canvas shows a stale drawing
      [1, true, null], // a clear under a scissor does not cover it
      [1, true, null], // nor one with a channel masked
      [1, false, null], // a whole clear does (its depth is still stale)
      [1, false, 'a frame drawn over a drawing a dry frame skipped'] // a draw on that depth
    ]);
    const texture = await scenario(() => {
      const dry = (Reflect.get(window, 'ElaboraDry') as { createDryFrames(): DryFrames }).createDryFrames();
      dry.install();
      const seen: Seen = [];
      const look = () => { const r = dry.report(); seen.push([r.skipped, r.stale, r.unsafe]); };
      const gl = document.body.appendChild(document.createElement('canvas')).getContext('webgl2');
      if (!gl) return seen;
      const target = (texture: WebGLTexture) => {
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        return framebuffer;
      };
      const make = () => { const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); return texture; };
      const redrawn = make();
      const redrawnTarget = target(redrawn);
      const reused = make();
      const reusedTarget = target(reused);
      dry.setDry('all');
      for (const framebuffer of [redrawnTarget, reusedTarget]) { gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer); gl.clear(gl.COLOR_BUFFER_BIT); }
      dry.setDry(false);
      gl.bindFramebuffer(gl.FRAMEBUFFER, redrawnTarget); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.bindTexture(gl.TEXTURE_2D, redrawn); gl.drawArrays(gl.POINTS, 0, 0); look();
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, reused); gl.activeTexture(gl.TEXTURE0); gl.drawArrays(gl.POINTS, 0, 0); look();
      return seen;
    });
    assert.deepEqual(texture, [
      [2, false, null], // a texture drawn again before a draw uses it
      [2, false, 'a texture drawn in a dry frame used by a later draw'] // one that was not, bound on another unit (no program: any bound texture counts)
    ]);
    // With a program, only the textures its samplers read count.
    const sampled = await scenario(() => {
      const dry = (Reflect.get(window, 'ElaboraDry') as { createDryFrames(): DryFrames }).createDryFrames();
      dry.install();
      const seen: Seen = [];
      const look = () => { const r = dry.report(); seen.push([r.skipped, r.stale, r.unsafe]); };
      const gl = document.body.appendChild(document.createElement('canvas')).getContext('webgl2');
      if (!gl) return seen;
      const program = (fragment: string) => {
        const linked = gl.createProgram();
        for (const [type, source] of [[gl.VERTEX_SHADER, '#version 300 es\nvoid main() { gl_Position = vec4(0.0); gl_PointSize = 1.0; }'], [gl.FRAGMENT_SHADER, `#version 300 es\nprecision mediump float;\nout vec4 colour;\n${fragment}`]] as const) {
          const shader = gl.createShader(type);
          if (!shader) continue;
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          gl.attachShader(linked, shader);
        }
        gl.linkProgram(linked);
        return linked;
      };
      const one = program('uniform sampler2D a;\nvoid main() { colour = texture(a, vec2(0.5)); }');
      const both = program('uniform sampler2D a;\nuniform sampler2D b[2];\nvoid main() { colour = texture(a, vec2(0.5)) + texture(b[1], vec2(0.5)); }');
      const staleTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, staleTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, staleTexture, 0);
      dry.setDry('all'); gl.clear(gl.COLOR_BUFFER_BIT); dry.setDry(false);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(both); gl.uniform1i(gl.getUniformLocation(both, 'b[1]'), 3);
      gl.useProgram(one); gl.drawArrays(gl.POINTS, 0, 1); look();
      gl.useProgram(both); gl.drawArrays(gl.POINTS, 0, 1); look();
      return seen;
    });
    // Dry on the canvas only: render targets are drawn, a texture they hold stays fresh. Fully dry,
    // its reuse is flagged as offscreen only (what makes the host try the canvas only level).
    const levels: Seen[] = [];
    for (const level of ['all', 'canvas'] as const) {
      const page = await browser.newPage();
      try {
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        levels.push(await page.evaluate((level) => {
          const dry = (Reflect.get(window, 'ElaboraDry') as { createDryFrames(): DryFrames }).createDryFrames();
          dry.install();
          const gl = document.body.appendChild(document.createElement('canvas')).getContext('webgl2');
          if (!gl) return [];
          const texture = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          const framebuffer = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
          dry.setDry(level);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          dry.setDry(false);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.drawArrays(gl.POINTS, 0, 0);
          const r = dry.report();
          return [[r.skipped, r.offscreen, r.unsafe]] as Seen;
        }, level));
      } finally { await page.close(); }
    }
    assert.deepEqual(levels, [
      [[2, true, 'a texture drawn in a dry frame used by a later draw']], // both clears skipped; only the texture was at fault
      [[1, false, null]] // the render target cleared, the canvas skipped
    ]);
    assert.deepEqual(sampled, [
      [1, false, null], // the stale texture is bound on unit 3, the program samples unit 0
      [1, false, 'a texture drawn in a dry frame used by a later draw'] // b[1] samples unit 3
    ]);
    const reads = await Promise.all([
      scenario(() => {
        const dry = (Reflect.get(window, 'ElaboraDry') as { createDryFrames(): DryFrames }).createDryFrames();
        dry.install();
        const gl = document.body.appendChild(document.createElement('canvas')).getContext('webgl2');
        if (!gl) return [];
        const pixel = new Uint8Array(4);
        dry.setDry('all'); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        dry.setDry(false); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const fresh = dry.report().unsafe;
        dry.setDry('all'); gl.clear(gl.COLOR_BUFFER_BIT); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return [[0, false, fresh], [0, false, dry.report().unsafe]];
      }),
      scenario(() => {
        const dry = (Reflect.get(window, 'ElaboraDry') as { createDryFrames(): DryFrames }).createDryFrames();
        dry.install();
        const webgl = document.body.appendChild(document.createElement('canvas'));
        const gl = webgl.getContext('webgl2');
        const flat = document.createElement('canvas').getContext('2d');
        if (!gl || !flat) return [];
        dry.setDry('all'); gl.clear(gl.COLOR_BUFFER_BIT);
        flat.drawImage(webgl, 0, 0);
        return [[0, false, dry.report().unsafe]];
      }),
      scenario(() => {
        const dry = (Reflect.get(window, 'ElaboraDry') as { createDryFrames(): DryFrames }).createDryFrames();
        dry.install();
        const gl = document.body.appendChild(document.createElement('canvas')).getContext('webgl2');
        if (!gl) return [];
        dry.setDry('all'); gl.drawArrays(gl.POINTS, 0, 0);
        gl.getError();
        return [[0, false, dry.report().unsafe]];
      })
    ]);
    assert.deepEqual(reads.map((seen) => seen.map((entry) => entry[2])), [
      [null, 'readPixels of a drawing a dry frame skipped'],
      ['drawImage of a WebGL canvas a dry frame left stale'],
      ['getError after a dry frame']
    ]);
    // WebGL 1 extensions draw too; a canvas off the page is not shown.
    const extension = await scenario(() => {
      const dry = (Reflect.get(window, 'ElaboraDry') as { createDryFrames(): DryFrames }).createDryFrames();
      dry.install();
      const gl = document.createElement('canvas').getContext('webgl');
      const instanced = gl?.getExtension('ANGLE_instanced_arrays');
      if (!gl || !instanced) return [];
      dry.setDry('all'); instanced.drawArraysInstancedANGLE(gl.POINTS, 0, 0, 1);
      const r = dry.report();
      return [[r.skipped, r.stale, r.unsafe]];
    });
    assert.deepEqual(extension, [[1, false, null]]);
  } finally {
    await browser.close();
  }
});

// Four full runs of the gates: on a loaded computer, more than three minutes.
test('an object unchanged since its last run is not run again; a change to it or to the theme runs it, and so does force', { timeout: 360000 }, async () => {
  const dir = copyExample();
  addDrawProbe(dir, [{ name: 'counts', steps: [{ action: 'step', frames: 20 }, { action: 'expect-state', state: { frame: 21 } }] }]); // the mount draws the first frame
  const first = await testObject(dir, 'draw-probe');
  assert.equal(first.gates.behaviour, 'passed', JSON.stringify(first.diagnostics));
  assert.equal(first.reused, undefined);
  const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'objects/draw-probe/object.gates.json'), 'utf8'));
  const again = await testObject(dir, 'draw-probe');
  assert.deepEqual(again.reused, { at: recorded.at });
  assert.deepEqual({ ...again, reused: undefined }, { ...first, reused: undefined });
  // The theme's tokens, which props may be bound to: it runs again.
  const course = readJSON(dir, 'course.json');
  course.theme.tokens = { ...course.theme.tokens, 'color.primary': '#7a1f3d' };
  writeJSON(dir, 'course.json', course);
  assert.equal((await testObject(dir, 'draw-probe')).reused, undefined);
  assert.ok((await testObject(dir, 'draw-probe')).reused);
  // Its own folder.
  fs.appendFileSync(path.join(dir, 'objects/draw-probe/object.js'), '\n// revu\n');
  assert.equal((await testObject(dir, 'draw-probe')).reused, undefined);
  assert.equal((await testObject(dir, 'draw-probe', { force: true })).reused, undefined);
});

test('--update-snapshots removes the baselines of states no test names, and none when object.tests.json does not read', { timeout: 180000 }, async () => {
  const dir = copyExample();
  addDrawProbe(dir, [{ name: 'colour', steps: [{ action: 'step', frames: 20 }, { action: 'snapshot', name: 'end' }] }]);
  const snapshots = path.join(dir, 'objects/draw-probe/__snapshots__');
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(snapshots, 'renamed--gone-darwin.png'), '');
  const first = await testObject(dir, 'draw-probe', { updateSnapshots: true });
  assert.deepEqual(first.snapshots?.removed, ['renamed--gone-darwin.png']);
  const baselines = fs.readdirSync(snapshots);
  assert.ok(baselines.length === 1 && baselines[0].startsWith('colour--end-'), JSON.stringify(baselines));
  // An agent's half-written tests file: nothing is removed.
  fs.writeFileSync(path.join(dir, 'objects/draw-probe/object.tests.json'), '{ "tests": [');
  const broken = await testObject(dir, 'draw-probe', { updateSnapshots: true });
  assert.equal(broken.snapshots, undefined);
  assert.deepEqual(fs.readdirSync(snapshots), baselines);
});
