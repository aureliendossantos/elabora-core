// The miniatures' painter (D139): one frame of the canvas page (`mode=thumb&painter=1`), kept in the view and clipped to a pixel (a browser
// draws no frame out of the view), that loads its page once and is given each render by message, never loaded again: a browser keeps
// memory for each document a frame loads (WebKit about 1 to 4 MB, never given back), not for renders pushed into one. It answers one
// picture at a time. In WebKit it lives as long as the module's miniatures; elsewhere it goes after a rest, or after a few pictures, and is
// made again when asked.

import { createPageCanvasHost } from './canvas-page-host.ts';
import type { PageCanvasHost } from './canvas-page-host.ts';
import type { RelayHost } from './relay-protocol.ts';
import type { SceneRender } from './thumbs-protocol.ts';

export interface PainterOptions {
  canvasOrigin: string;
  relayPort(host: RelayHost, port: MessagePort): Promise<void>;
  mount?: HTMLElement;
  // Kept for the module's life (WebKit), or gone after `idleMs` without a picture, and made again after `renewAfter` pictures (a page
  // that draws grows: about 90 MB for eight pictures in Firefox).
  keep: boolean;
  idleMs: number;
  renewAfter: number;
  // How long a picture is waited for, in ms.
  timeoutMs: number;
}
export interface PictureAsk {
  width: number;
  block?: string;
  mini?: boolean;
  slides?: boolean;
}
export interface Painter {
  // The screen of the render as an image (WebP or PNG), and whether a slide runs past its window (a block's scene).
  paint(made: SceneRender, ask: PictureAsk): Promise<{ image: Blob; overflow: boolean }>;
  // Made now and its page loaded, so that the first picture does not wait for it.
  warm(): void;
  readonly alive: boolean;
  close(): void;
}

// The pixels a painter gives, as the app accepts them: a WebP or a PNG, never anything a browser would run.
export const PICTURE_TYPES = ['image/webp', 'image/png'] as const;
const isPicture = (value: unknown): value is Blob => typeof Blob === 'function' && value instanceof Blob && (PICTURE_TYPES as readonly string[]).includes(value.type) && value.size > 0;

export function createPainter({ canvasOrigin, relayPort, mount, keep, idleMs, renewAfter, timeoutMs }: PainterOptions): Painter {
  let held: { host: PageCanvasHost; holder: HTMLElement; frame: HTMLIFrameElement; pictures: number } | null = null;
  let renders = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function make(): NonNullable<typeof held> {
    if (held) return held;
    const host = createPageCanvasHost({ canvasOrigin, frames: false, relayPort, mount: mount ?? document.body, askTimeoutMs: timeoutMs });
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    // Above the page: Chrome gives a frame of another origin that the page covers about one animation frame a second (a picture
    // waited 3 s under the window's bar).
    holder.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;z-index:2147483647;';
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', host.info.sandbox);
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('inert', '');
    frame.tabIndex = -1;
    frame.title = '';
    frame.referrerPolicy = 'no-referrer';
    frame.style.cssText = 'border:0;width:1280px;height:720px';
    const address = new URL(host.info.url);
    address.searchParams.set('mode', 'thumb');
    address.searchParams.set('painter', '1');
    address.searchParams.set('placing', 'editor');
    address.searchParams.set('scrollbars', 'none');
    // Its address before it is in the page: a frame put in without one loads a blank document first.
    frame.src = address.href;
    host.attach(frame);
    holder.append(frame);
    (mount ?? document.body).append(holder);
    held = { host, holder, frame, pictures: 0 };
    return held;
  }
  function drop(): void {
    if (!held) return;
    const { host, holder } = held;
    held = null;
    holder.style.visibility = 'hidden';
    void host.close().then(() => holder.remove());
  }
  function rest(): void {
    if (idle) clearTimeout(idle);
    idle = keep ? null : setTimeout(() => { idle = null; drop(); }, idleMs);
  }

  return {
    paint(made, ask) {
      const run = queue.then(async () => {
        if (closed) throw new Error('The painter is closed');
        if (idle) { clearTimeout(idle); idle = null; }
        const { host, frame } = make();
        try {
          if (frame.style.width !== `${made.width}px` || frame.style.height !== `${made.height}px`) {
            frame.style.width = `${made.width}px`;
            frame.style.height = `${made.height}px`;
          }
          const id = `p${++renders}`;
          host.push(made.render, { id });
          const answer = await host.ask('picture', { id, ...ask });
          if (!answer) throw new Error('The painter did not draw the screen in time');
          // A page whose route did not open drew the screen without the module's files: such an image is not kept for its version.
          const relay = host.relays().canvas;
          if (!relay.opened) throw new Error(`The painter's page could not have the module's files${relay.error ? ` (${relay.error})` : ''}`);
          if (!isPicture(answer.image)) throw new Error('The painter gave something that is not a WebP or a PNG');
          if (!keep && held && ++held.pictures >= renewAfter) drop();
          return { image: answer.image, overflow: answer.overflow === true };
        } catch (error) {
          // A page that does not answer is not kept: the next picture gets a new one.
          drop();
          throw error;
        } finally {
          if (!closed) rest();
        }
      });
      queue = run.catch(() => null);
      return run;
    },
    warm() {
      if (closed) return;
      make();
      rest();
    },
    get alive() { return held !== null; },
    close() {
      closed = true;
      if (idle) clearTimeout(idle);
      drop();
    }
  };
}
