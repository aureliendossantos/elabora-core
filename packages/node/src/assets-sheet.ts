import fs from 'node:fs';
import path from 'node:path';
import { launchMotionBrowsers } from './emulator/browser.ts';

// ── Contact sheet of generated assets ─────────────────────────────────
// Every figure a generator wrote, on the course's surface colour, with its file name and size:
// the light review of generators/ (elabora assets --sheet), one image for all of them.
export interface AssetGroup {
  generator: string;
  description?: string;
  outputs: string[]; // paths under assets/
}

export async function assetsSheet(dir: string, groups: AssetGroup[], { surface = '#ffffff', width = 1600 }: { surface?: string; width?: number } = {}): Promise<Buffer> {
  const root = path.resolve(dir);
  const types: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sections = groups.map((group) => {
    const cells = group.outputs.filter((output) => types[path.extname(output).toLowerCase()]).map((output) => {
      const file = path.join(root, 'assets', output);
      if (!fs.existsSync(file)) return `<figure><div class="missing">missing</div><figcaption>${escape(output)}</figcaption></figure>`;
      const data = fs.readFileSync(file).toString('base64');
      return `<figure><div class="art"><img src="data:${types[path.extname(output).toLowerCase()]};base64,${data}"></div><figcaption>${escape(output)} <span></span></figcaption></figure>`;
    }).join('');
    return `<section><h2>${escape(group.generator)}${group.description ? ` <small>${escape(group.description)}</small>` : ''}</h2><main>${cells}</main></section>`;
  }).join('');
  // The figures as they rest: animations off, in the SVGs shown through <img> too (a figure that draws
  // itself would be captured at its first, empty frame).
  const browsers = launchMotionBrowsers({ rendering: 'gpu' });
  try {
    const page = await (await browsers.for(false)).newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await page.setContent(`<!doctype html><style>
body{margin:0;padding:20px;background:#1a1a1a;color:#ddd;font:13px system-ui}
h2{font-size:15px;margin:18px 0 10px;color:#fff}h2 small{font-weight:400;color:#999}
main{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
figure{margin:0}.art,.missing{display:grid;place-items:center;aspect-ratio:4/3;background:${surface.replace(/[^#0-9a-zA-Z(),. %]/g, '')};border:1px solid #333;overflow:hidden}
.art img{width:100%;height:100%;object-fit:contain}.missing{color:#c33}figcaption{padding:4px 2px;word-break:break-all}figcaption span{color:#888}
</style>${sections}`);
    await page.evaluate(() => Promise.all([...document.images].map(async (image) => {
      await image.decode().catch(() => {});
      const caption = image.closest('figure')?.querySelector('figcaption span');
      if (caption) caption.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
    })));
    return await page.screenshot({ fullPage: true });
  } finally {
    await browsers.close();
  }
}
