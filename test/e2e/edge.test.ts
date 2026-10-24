import { test } from 'node:test';
import { resources } from '../resources.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, LaunchOptions } from 'playwright-core';
import { CHROMIUM_CHANNELS, launchBrowser, launchChromium } from '@elabora/node/emulator/browser';
import type { ChromiumChannel } from '@elabora/node/emulator/browser';

// Microsoft Edge stands in for Google Chrome on computers without it (launchBrowser's order). Where
// both are installed (GitHub's runners have both), Edge in software draws what Chrome draws: the
// same SwiftShader device and the same pixels, so a free object's baselines do not depend on which
// of the two recorded them. The scene is still: smooth colours, a pattern computed per fragment,
// multisampled edges, text.

const require = createRequire(import.meta.url);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:radial-gradient(circle at 30% 30%,#fdf6e3,#93a1a1);font:20px/1.4 Georgia,serif}
canvas{display:block}p{margin:8px 16px}</style></head><body>
<canvas width="480" height="320"></canvas><p>Le réseau tombe : trouvez la panne, pas à pas.</p>
<script>
const gl = document.querySelector('canvas').getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
const program = gl.createProgram();
gl.attachShader(program, shader(gl.VERTEX_SHADER, \`#version 300 es
in vec2 p; in vec3 c; out vec3 v; out vec2 q;
void main() { v = c; q = p; gl_Position = vec4(p, 0.0, 1.0); }\`));
gl.attachShader(program, shader(gl.FRAGMENT_SHADER, \`#version 300 es
precision highp float; in vec3 v; in vec2 q; out vec4 o;
void main() { float r = length(q); o = vec4(v * (0.6 + 0.4 * sin(18.0 * r) * cos(9.0 * atan(q.y, q.x))), 1.0); }\`));
gl.linkProgram(program);
gl.useProgram(program);
const vertices = [];
for (let i = 0; i < 7; i++) {
  const a = (i / 7) * Math.PI * 2 + 0.3, b = ((i + 1) / 7) * Math.PI * 2 + 0.3;
  vertices.push(0, 0, 1, 1, 1, Math.cos(a) * 0.9, Math.sin(a) * 0.8, i / 7, 0.4, 1 - i / 7, Math.cos(b) * 0.9, Math.sin(b) * 0.8, 0.9, i / 7, 0.2);
}
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
for (const [name, size, offset] of [['p', 2, 0], ['c', 3, 8]]) {
  const at = gl.getAttribLocation(program, name);
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, size, gl.FLOAT, false, 20, offset);
}
gl.clearColor(0.05, 0.07, 0.12, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 5);
const info = gl.getExtension('WEBGL_debug_renderer_info');
window.renderer = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
</script></body></html>`;

// The browser of that channel alone, or null when it is not installed here.
async function only(channel: ChromiumChannel): Promise<Browser | null> {
  try { return await launchBrowser('chromium', { channels: [channel] }); } catch (error) {
    if (error instanceof Error && / not installed /.test(error.message)) return null;
    throw error;
  }
}

async function draw(browser: Browser): Promise<{ version: string; renderer: string; png: Buffer }> {
  const page = await browser.newPage({ viewport: { width: 480, height: 400 }, deviceScaleFactor: 1 });
  await page.setContent(PAGE);
  const renderer = await page.evaluate(() => (window as unknown as { renderer: string }).renderer);
  return { version: browser.version(), renderer, png: await page.screenshot() };
}

test('Edge draws in software as Chrome does: the same SwiftShader, the same pixels', { timeout: 60000 }, async (t) => {
  const chrome = resources(t).own(await only('chrome'), value => value?.close());
  const edge = resources(t).own(await only('msedge'), value => value?.close());
  try {
    if (!chrome || !edge) return t.skip(`${chrome ? 'Microsoft Edge' : 'Google Chrome'} is not installed`);
    const [a, b] = [await draw(chrome), await draw(edge)];
    assert.match(a.renderer, /SwiftShader/);
    assert.equal(b.renderer, a.renderer, `Edge ${b.version} and Chrome ${a.version} draw with the same device`);
    const { PNG } = require('pngjs');
    const pixelmatchModule = require('pixelmatch');
    const pixelmatch = pixelmatchModule.default || pixelmatchModule;
    const [x, y] = [PNG.sync.read(a.png), PNG.sync.read(b.png)];
    // The gates' measure: pixels apart beyond pixelmatch's 0.1 threshold, at most 0.1 %.
    const ratio = (100 * pixelmatch(x.data, y.data, undefined, x.width, x.height, { threshold: 0.1 })) / (x.width * x.height);
    let different = 0;
    let largest = 0;
    for (let i = 0; i < x.data.length; i += 4) {
      let delta = 0;
      for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(x.data[i + c] - y.data[i + c]));
      if (delta) different++;
      largest = Math.max(largest, delta);
    }
    t.diagnostic(`Chrome ${a.version}, Edge ${b.version}: ${different} of ${x.width * x.height} pixels differ, largest channel difference ${largest}/255; gate difference ${ratio.toFixed(3)} %. ${a.renderer}`);
    assert.ok(ratio <= 0.1, `Edge ${b.version} differs from Chrome ${a.version} on ${ratio.toFixed(3)} % of the pixels`);
  } finally {
    await chrome?.close();
    await edge?.close();
  }
});

test('a missing Chrome executable falls back to the installed Edge and renders a page', { timeout: 60000 }, async (t) => {
  const available = await only('msedge');
  if (!available) return t.skip('Microsoft Edge is not installed');
  const version = available.version();
  await available.close();
  const { chromium } = require('playwright-core') as typeof import('playwright-core');
  const missing = path.join(resources(t).tempDir('elabora-missing-chrome-'), 'chrome.exe');
  assert.ok(!fs.existsSync(missing));
  const attempts: LaunchOptions[] = [];
  const options = { headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-features=IsolateSandboxedIframes'] };
  const browser = await launchChromium({ launch: async (launch = {}) => {
    attempts.push(launch);
    // Playwright reports the real missing-executable error; Edge starts normally.
    return chromium.launch(launch.channel === 'chrome' ? { ...launch, executablePath: missing } : launch);
  } }, CHROMIUM_CHANNELS, options);
  try {
    assert.deepEqual(attempts, [{ ...options, channel: 'chrome' }, { ...options, channel: 'msedge' }]);
    assert.equal(browser.version(), version);
    const result = await draw(browser);
    assert.match(result.renderer, /SwiftShader/);
    const { PNG } = require('pngjs');
    const capture = PNG.sync.read(result.png);
    assert.deepEqual([capture.width, capture.height], [480, 400]);
    assert.ok(capture.data.some((value: number, index: number) => value !== capture.data[index % 4]), 'a rendered scene contains visible variation');
    t.diagnostic(`Missing Chrome → Edge ${result.version}, ${result.png.length} byte capture`);
  } finally { await browser.close(); }
});
