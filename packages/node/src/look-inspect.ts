import type { CDPSession, Frame, Locator, Page } from 'playwright-core';
import type { LayoutRect } from '@elabora/player/canvas-protocol';
import type { ImageType } from './capture.ts';
import type { LookAction } from './look-client.ts';

// Closing in on a block while looking (elabora look --block): a capture cropped to its box, and its free
// object driven from inside its frame (--act). The canvas of looks shows objects in frames of an opaque
// origin, out of reach of a browser pane's tools; Playwright reaches every frame of its pages.

const BLOCK = (id: string) => `.t-block[data-block="${id.replace(/["\\]/g, '\\$&')}"]`;
// Around the block, so its edges and shadow show.
const MARGIN = 16;

const devtools = new WeakMap<Page, Promise<CDPSession>>();
function cdp(page: Page): Promise<CDPSession> {
  let session = devtools.get(page);
  if (!session) {
    session = page.context().newCDPSession(page);
    devtools.set(page, session);
    session.catch(() => devtools.delete(page));
  }
  return session;
}

// The block's box with a margin, inside the window (what of it the window shows), in px of the window;
// null when the window shows none of it.
export async function closeUpClip(page: Page, block: string): Promise<LayoutRect | null> {
  return page.evaluate(({ selector, margin }) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const left = Math.max(0, Math.floor(box.left - margin));
    const top = Math.max(0, Math.floor(box.top - margin));
    const right = Math.min(innerWidth, Math.ceil(box.right + margin));
    const bottom = Math.min(innerHeight, Math.ceil(box.bottom + margin));
    return right - left >= 1 && bottom - top >= 1 && box.width > 0 && box.height > 0 ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }, { selector: BLOCK(block), margin: MARGIN });
}

// That part of the window at scale 1 or 2 (drawn again at that scale, not enlarged), through the
// devtools protocol: Playwright's clip has no scale. A devtools session of its own does not get the
// page's emulated pixel ratio: it draws at the screen's (2 on a Retina Mac), measured once per page
// on a tiny capture, and the scale asked for is divided by it.
const screenRatios = new WeakMap<Page, Promise<number>>();
export async function captureClip(page: Page, clip: LayoutRect, { scale = 1, type = 'png' }: { scale?: number; type?: ImageType } = {}): Promise<Buffer> {
  const session = await cdp(page);
  const shoot = async (box: LayoutRect, factor: number, format: ImageType) => {
    const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    const { data } = await session.send('Page.captureScreenshot', {
      ...(format === 'jpeg' ? { format: 'jpeg', quality: 90 } : { format: 'png', optimizeForSpeed: true }),
      clip: { x: box.x + scroll.x, y: box.y + scroll.y, width: box.width, height: box.height, scale: factor },
      captureBeyondViewport: false
    });
    return Buffer.from(data, 'base64');
  };
  let ratio = screenRatios.get(page);
  if (!ratio) {
    // A PNG's width is in its header (bytes 16 to 19).
    ratio = shoot({ x: 0, y: 0, width: 8, height: 8 }, 1, 'png').then((png) => Math.max(1, png.readUInt32BE(16) / 8));
    screenRatios.set(page, ratio);
    // Measured again next time when it failed.
    ratio.catch(() => screenRatios.delete(page));
  }
  return shoot(clip, scale / await ratio, type);
}

// The frame of a free object block, or why there is none.
export async function objectFrameOf(page: Page, block: string): Promise<Frame | string> {
  const node = await page.$(BLOCK(block));
  if (!node) return `No block "${block}" on the screen.`;
  const iframe = await node.$('.t-object-frame iframe');
  const frame = iframe ? await iframe.contentFrame() : null;
  return frame ?? `Block "${block}" is not a free object: --act drives the controls of an object's frame.`;
}

// Plays the actions in order inside the object's frame; null once done, else why one failed.
export async function playActions(page: Page, frame: Frame, actions: readonly LookAction[]): Promise<string | null> {
  const iframe = await frame.frameElement();
  for (const action of actions) {
    try {
      if (action.kind === 'click') {
        const target = await findTarget(frame, action);
        if (!target) return `${action.source}: nothing in the frame matches. ${await offered(frame)}`;
        await target.click({ timeout: 5000 });
      } else if (action.kind === 'key') {
        // Keys go to the focused frame: the object's, unless something in it holds the focus already.
        if (!await frame.evaluate(() => document.hasFocus())) await iframe.focus();
        await page.keyboard.press(action.key);
      } else if (action.kind === 'choose') {
        return `${action.source}: choose: is for a dialogue block, not a free object.`;
      } else {
        const box = await iframe.boundingBox();
        if (!box) return `${action.source}: the object's frame is not drawn.`;
        const at = (x: number, y: number) => [box.x + x * box.width, box.y + y * box.height] as const;
        const shown = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const outside = [action.from, action.to].find(([x, y]) => { const [left, top] = at(x, y); return left < 0 || top < 0 || left >= shown.width || top >= shown.height; });
        if (outside) return `${action.source}: ${outside.join(',')} of the object is outside the window at this scroll: scroll so that part shows (scroll: a px position).`;
        await page.mouse.move(...at(action.from[0], action.from[1]));
        await page.mouse.down();
        await page.mouse.move(...at(action.to[0], action.to[1]), { steps: 12 });
        await page.mouse.up();
      }
    } catch (error) {
      return `${action.source}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`;
    }
  }
  return null;
}

// By role (and name, which may be part of it), or by text, whole: a button or a link named so, a
// text, a field labelled so. Never a text that only contains it: "Sail" would click "Sail from Majorca".
async function findTarget(frame: Frame, action: Extract<LookAction, { kind: 'click' }>): Promise<Locator | null> {
  const candidates = action.role
    ? [frame.getByRole(action.role as Parameters<Frame['getByRole']>[0], action.name ? { name: action.name } : {})]
    : [frame.getByRole('button', { name: action.text, exact: true }), frame.getByRole('link', { name: action.text, exact: true }), frame.getByText(action.text ?? '', { exact: true }), frame.getByLabel(action.text ?? '', { exact: true })];
  for (const candidate of candidates) {
    const visible = candidate.filter({ visible: true });
    if (await visible.count()) return visible.first();
  }
  return null;
}

// What the frame offers to click: its controls by role and name, its labels.
async function offered(frame: Frame): Promise<string> {
  const found = await frame.evaluate(() => {
    const nameOf = (element: Element) => (element.getAttribute('aria-label') || element.textContent || element.getAttribute('title') || (element instanceof HTMLInputElement ? element.value || element.placeholder || element.name : '') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const shown = (element: Element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
    // Each element in the first group that takes it.
    const taken = new Set<Element>();
    const group = (selector: string) => [...new Set([...document.querySelectorAll(selector)].filter((element) => shown(element) && !taken.has(element)).map((element) => { taken.add(element); return `"${nameOf(element)}"`; }))].slice(0, 12);
    return {
      buttons: group('button, [role="button"], input[type="button"], input[type="submit"]'),
      links: group('a[href], [role="link"]'),
      fields: group('input:not([type="button"]):not([type="submit"]), select, textarea, [role="slider"], [role="checkbox"], [role="radio"], [role="tab"], [role="option"]'),
      labels: group('label'),
      canvas: document.querySelectorAll('canvas').length
    };
  });
  const parts = Object.entries({ buttons: found.buttons, links: found.links, fields: found.fields, labels: found.labels }).filter(([, names]) => names.length).map(([kind, names]) => `${kind}: ${names.join(', ')}`);
  if (parts.length) return `The frame offers ${parts.join('; ')}.`;
  return found.canvas ? 'The frame has no control to click: it draws on a canvas (drag:x,y->x,y and key:<key> reach it).' : 'The frame has no control to click.';
}

// ── The controls of the free objects on the screen ───────────────────
// Each control of each object's frame (a button, a field, anything that takes the focus), where it
// is in the window, and what the page puts over the middle of its part in the window: a bar, a title, a panel there takes the
// clicks meant for it (document.elementFromPoint). Text instead of a capture.
export interface ObjectControl {
  block: string;
  role: string;
  name: string;
  // In px of the window, rounded.
  box: { x: number; y: number; width: number; height: number };
  disabled: boolean;
  // Out of the window (not checked), or what covers its middle (null: nothing, the click reaches it).
  outside: boolean;
  coveredBy: string | null;
}

export async function objectControls(page: Page): Promise<ObjectControl[]> {
  // The look's bars are inert (out of reach), and inert elements let clicks through: in a package
  // they take them. They count again while the controls are tested.
  await page.evaluate(() => { for (const node of document.querySelectorAll<HTMLElement>('.t-bar[inert]')) { node.inert = false; node.dataset.lookInert = ''; } });
  try {
    return await controlsOf(page);
  } finally {
    await page.evaluate(() => { for (const node of document.querySelectorAll<HTMLElement>('.t-bar[data-look-inert]')) { node.inert = true; delete node.dataset.lookInert; } }).catch(() => {});
  }
}

async function controlsOf(page: Page): Promise<ObjectControl[]> {
  const out: ObjectControl[] = [];
  for (const iframe of await page.$$('iframe')) {
    const block = await iframe.evaluate((node) => (/\/frame\.html(\?|$)/.test(node.getAttribute('src') || '') ? node.closest<HTMLElement>('[data-block]')?.dataset.block ?? null : null)).catch(() => null);
    const frame = block ? await iframe.contentFrame() : null;
    const at = frame ? await iframe.boundingBox() : null;
    if (!block || !frame || !at) continue;
    const found = await frame.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, [role="button"], [role="slider"], [role="switch"], [role="tab"], input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden'; })
      .map((node) => {
        const box = node.getBoundingClientRect();
        const name = (node.getAttribute('aria-label') || node.textContent || node.getAttribute('title') || node.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 48);
        return { role: node.getAttribute('role') || node.tagName.toLowerCase(), name, x: box.x, y: box.y, width: box.width, height: box.height, disabled: (node as HTMLButtonElement).disabled === true || node.getAttribute('aria-disabled') === 'true' };
      })).catch(() => []);
    // Every control of the frame in one call: what is over the middle of its part in the window.
    const boxes = found.map((control) => ({ left: at.x + control.x, top: at.y + control.y, right: at.x + control.x + control.width, bottom: at.y + control.y + control.height }));
    const covers = await page.evaluate(({ element, boxes: list }) => list.map((b) => {
      const left = Math.max(0, b.left), top = Math.max(0, b.top), right = Math.min(innerWidth, b.right), bottom = Math.min(innerHeight, b.bottom);
      if (right - left < 1 || bottom - top < 1) return 'outside';
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (!hit) return 'outside';
      if (hit === element) return null;
      const owner = hit.closest<HTMLElement>('[data-block]')?.dataset.block;
      const classes = [...hit.classList].slice(0, 3).map((name) => `.${name}`).join('');
      return `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}${classes}${owner ? ` (block ${owner})` : ''}`;
    }), { element: iframe, boxes });
    for (const [index, control] of found.entries()) {
      const box = { x: Math.round(boxes[index].left), y: Math.round(boxes[index].top), width: Math.round(control.width), height: Math.round(control.height) };
      const coveredBy = covers[index];
      out.push({ block, role: control.role, name: control.name, box, disabled: control.disabled, outside: coveredBy === 'outside', coveredBy: coveredBy === 'outside' ? null : coveredBy });
    }
  }
  return out;
}
