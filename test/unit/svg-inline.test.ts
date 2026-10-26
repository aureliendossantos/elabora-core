import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inlineSvg } from '@elabora/core/render/svg-inline';
import { renderScreen } from '@elabora/core/render/screen';
import { subpaths } from '@elabora/player/timed-blocks';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { copyExample, readJSON, writeJSON, codes } from '../helpers.ts';

const DRAWING = `<?xml version="1.0"?>
<!DOCTYPE svg [<!ENTITY x "boom">]>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" onload="alert(1)" class="plate">
  <title>A title the alt replaces</title>
  <style>.ink { stroke: currentColor; animation: trace 2s; } svg .bg { fill: url(#paper); } @import url(http://evil.test/x.css); @keyframes trace { from { stroke-dashoffset: 9; } }</style>
  <defs><linearGradient id="paper"><stop offset="0" stop-color="#fff"/></linearGradient><path id="line" d="M0 0L10 10"/></defs>
  <script>alert(1)</script>
  <foreignObject><div>html</div></foreignObject>
  <a href="https://example.test"><path class="ink" d="M1 1L2 2" onclick="steal()"/></a>
  <use href="#line" xlink:href="#line"/>
  <image href="https://example.test/a.png"/><image href="data:image/png;base64,AAAA"/>
  <rect class="bg" fill="url(#paper)" width="10" height="10" style="filter: url(https://example.test/f.svg#x)"/>
  <!-- a comment -->
  <text>&lt;1&gt; &amp; 2</text>
</svg>`;

test('inline SVG: what draws stays, scripts, handlers, links and outside references go, ids and styles keep to the drawing', () => {
  const { html, removed } = inlineSvg(DRAWING, { prefix: 't-svg-plate', label: 'A "plate"' });
  assert.match(html, /^<svg width="200" height="100" viewBox="0 0 200 100" class="t-figure-svg plate" data-t-svg="t-svg-plate" role="img" aria-label="A &quot;plate&quot;" focusable="false">/);
  for (const gone of ['onload', 'onclick', '<script', 'alert', 'foreignObject', '<div', 'example.test', '<a ', '@import', '<title', 'ENTITY', '<!--', '<?xml']) assert.ok(!html.includes(gone), gone);
  assert.match(html, /<path class="ink" d="M1 1L2 2"><\/path>/); // the link's drawing stays
  assert.match(html, /<linearGradient id="t-svg-plate-paper">/);
  assert.match(html, /<use href="#t-svg-plate-line" xlink:href="#t-svg-plate-line"><\/use>/);
  assert.match(html, /fill="url\(#t-svg-plate-paper\)"/);
  assert.match(html, /<image href="data:image\/png;base64,AAAA"><\/image>/);
  assert.match(html, /svg\[data-t-svg="t-svg-plate"\] \.ink\{stroke: currentColor;animation: t-svg-plate-trace 2s;\}/);
  assert.match(html, /svg\[data-t-svg="t-svg-plate"\] \.bg\{fill: url\(#t-svg-plate-paper\);\}/);
  assert.match(html, /@keyframes t-svg-plate-trace\{/);
  assert.match(html, /<text>&lt;1&gt; &amp; 2<\/text>/);
  assert.deepEqual(removed.sort(), ['<a> (its content kept)', '<foreignObject>', '<script>', '@import in its <style>', 'a reference out of the drawing (https://example.test/a.png)', 'a reference out of the drawing in a style attribute', 'event handlers'].sort());
  // Decorative: hidden from screen readers, no name.
  const decorative = inlineSvg('<svg viewBox="0 0 1 1" role="img" aria-label="x"><path d="M0 0"/></svg>', { prefix: 'p', decorative: true }).html;
  assert.equal(decorative, '<svg viewBox="0 0 1 1" class="t-figure-svg" data-t-svg="p" aria-hidden="true" focusable="false"><path d="M0 0"></path></svg>');
  assert.deepEqual(inlineSvg('<html><body/></html>', { prefix: 'p' }).removed, ['<html> as the root (not an SVG)']);
});

test('inline SVG: hostile drawings neither run script, load anything nor reach the page around them (the independent review\'s cases)', () => {
  const inline = (svg: string) => inlineSvg(svg, { prefix: 'p', label: 'x' });
  // A CDATA style holding markup: foreign content would make it an <img onerror>.
  const cdata = inline('<svg><style><![CDATA[ a{fill:"<img src=x onerror=alert(1)>"} ]]></style></svg>').html;
  assert.ok(!/<img/i.test(cdata), cdata);
  assert.match(cdata, /\\3c img src=x onerror=alert\(1\)/);
  // Character references in a style decode in the page: written so that they cannot.
  const entity = inline('<svg><style>a{fill:"&amp;#60;img"}</style></svg>').html;
  assert.ok(!/&#60;|<img/.test(entity), entity);
  // Loads, however they are written: keyframes, CSS escapes, entities, image-set(), src().
  for (const css of ['@keyframes k{from{background-image:url(https://evil.test/x)}}', '.a{background:u\\72l(https://evil.test/x)}', '.a{background:&#117;rl(https://evil.test/x)}', '.a{background:image-set("https://evil.test/x" 1x)}', '.a{background:src("https://evil.test/x")}']) {
    const { html, removed } = inline(`<svg><style>${css}</style><path class="a" d="M0 0"/></svg>`);
    assert.ok(!html.includes('evil.test'), html);
    assert.ok(removed.length > 0, css);
  }
  assert.ok(!inline('<svg><path style="background:u\\72l(https://evil.test/x)" d="M0 0"/></svg>').html.includes('evil.test'));
  // Selectors that reach the root's siblings, a drawing fixed over the page, references to page ids.
  const reach = inline('<svg style="position:fixed;inset:0"><style>svg ~ * { display:none } :root + p { color:red } .ok { fill:red }</style><use href="#page-logo"/><path fill="url(#page-grad)" d="M0 0"/></svg>');
  assert.ok(!/~|\+ p|position:fixed/.test(reach.html), reach.html);
  assert.match(reach.html, /svg\[data-t-svg="p"\] \.ok\{fill:red;\}/);
  assert.match(reach.html, /href="#p-page-logo"/);
  assert.match(reach.html, /fill="url\(#p-page-grad\)"/);
});

test('the draw effect: subpaths of path data, each from an absolute point', () => {
  assert.deepEqual(subpaths('M10 10 L20 20 m5 0 l10 0 h5 z m1 1 v3 M0 0 c1 1 2 2 3 3 1 1 1 1 4 4'), ['M10 10L20 20', 'M25 20l10 0h5Z', 'M26 21v3', 'M0 0c1 1 2 2 3 3c1 1 1 1 4 4']);
  assert.deepEqual(subpaths('m1 1 2 2 3 3'), ['M1 1l2 2l3 3']);
  assert.deepEqual(subpaths('M0 0a5 5 0 0 1 10 0m-10 5h1'), ['M0 0a5 5 0 0 1 10 0', 'M0 5h1']);
  // Arc flags written together (as SVGO writes them), and path data that cannot be read: none.
  assert.deepEqual(subpaths('M0 0l1 1M5 5a5 5 0 105 5M20 20l200 0'), ['M0 0l1 1', 'M5 5a5 5 0 1 0 5 5', 'M20 20l200 0']);
  assert.deepEqual(subpaths('M0 0l1 1M5 5a5 5 0 2 0 5 5'), []);
});

test('an image block with inline: true has its SVG in the page, named by its alt; the checks follow', () => {
  const dir = copyExample();
  fs.writeFileSync(path.join(dir, 'assets/images/trace.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path id="a" d="M0 0L9 9" fill="none" stroke="currentColor"/><script>x()</script></svg>');
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push({ id: 'accueil-trace', type: 'image', props: { asset: 'images/trace.svg', alt: 'Un trait', inline: true }, timing: { in: { at: { seconds: 0.5 }, effect: 'draw' } } });
  screen.blocks.push({ id: 'accueil-photo', type: 'image', props: { asset: 'images/ticket-marc.svg', alt: 'Le ticket', inline: false }, timing: { in: { at: { seconds: 0.5 }, effect: 'draw' } } });
  writeJSON(dir, 'screens/accueil.json', screen);
  const rendered = renderScreen(loadProjectFromDir(dir), 'accueil');
  const html = JSON.stringify(rendered.course.screens[0].blocks?.find((block) => block.id === 'accueil-trace'));
  assert.match(html, /<figure class=\\"t-figure\\"><span class=\\"t-media\\"><svg viewBox=\\"0 0 10 10\\" class=\\"t-figure-svg\\" data-t-svg=\\"t-svg-accueil-trace\\" role=\\"img\\" aria-label=\\"Un trait\\" focusable=\\"false\\"><path id=\\"t-svg-accueil-trace-a\\"/);
  assert.ok(!html.includes('<img') && !html.includes('script'));
  let c = codes(validateDir(dir).diagnostics);
  assert.ok(c.includes('W_SVG_INLINE_SANITIZED'), 'a script removed');
  assert.equal(c.filter((code) => code === 'W_TIMING_DRAW_IMAGE').length, 1, 'draw on an SVG shown as an image');
  screen.blocks.at(-1).props.inline = true;
  screen.blocks.at(-1).props.asset = 'images/nowhere.png';
  writeJSON(dir, 'screens/accueil.json', screen);
  c = codes(validateDir(dir).diagnostics);
  assert.ok(c.includes('W_IMAGE_INLINE_NOT_SVG') && c.includes('W_TIMING_DRAW_IMAGE'));
});
