// A video that loops like an animated image (a video block with loop: true, and the same loop at full
// size in the lightbox when it zooms): muted, in a loop, inline, without controls; it starts by itself
// unless the learner prefers reduced motion (then it stays on its first frame, its poster), and
// follows that preference when it changes. Its button pauses it (WCAG 2.2.2: a loop moves for more
// than 5 s however short its file); a pointer that hovers sees it there, a keyboard on focus, a touch
// screen always, and anyone once the loop stands still. Its alt names it as an image; a decorative one
// is hidden from assistive technologies, its button is not.

import type { Labels } from './labels.ts';
import { element } from './dom.ts';

export interface LoopSource {
  src: string;
  poster?: string;
  alt?: string;
  decorative?: boolean;
  // The video is a button that opens it in the lightbox (data-t-zoom, bound by the primitives).
  zoom?: boolean;
}

export interface Loop {
  frame: HTMLElement;
  video: HTMLVideoElement;
  dispose(): void;
}

export function createLoop(source: LoopSource, labels: Pick<Labels, 'playAnimation' | 'pauseAnimation'>): Loop {
  const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const still = () => !!motion?.matches;
  const video = element('video', {
    class: 't-loop', muted: true, loop: true, playsinline: true, autoplay: !still(), preload: 'auto', poster: source.poster,
    disablepictureinpicture: true, disableremoteplayback: true,
    'aria-hidden': source.decorative ? 'true' : undefined, role: source.decorative ? undefined : 'img', 'aria-label': source.decorative ? undefined : source.alt || undefined
  });
  // Muted before its source is known: Safari on iOS plays by itself only a video muted from the
  // start, and a muted attribute set by script does not mute an element already made.
  video.defaultMuted = true;
  video.muted = true;
  video.append(element('source', { src: source.src }));
  const toggle = element('button', { type: 'button', class: 't-loop-toggle' });
  // The learner paused it: neither its data arriving nor a change of preference starts it again.
  let held = false;
  // In the window (as far as the observer below knows; without one, always).
  let seen = typeof IntersectionObserver !== 'function';
  const show = (state: 'playing' | 'paused') => {
    toggle.dataset.state = state;
    toggle.setAttribute('aria-label', state === 'paused' ? labels.playAnimation : labels.pauseAnimation);
  };
  const sync = () => show(video.paused ? 'paused' : 'playing');
  const play = () => { void video.play().then(sync, sync); };
  // What the button says, not video.paused: a loop that is still loading (or out of the window,
  // where Chrome holds it) is paused until it starts by itself; « pause » then keeps it still.
  toggle.addEventListener('click', () => {
    held = toggle.dataset.state !== 'paused';
    if (held) video.pause(); else play();
    show(held ? 'paused' : 'playing');
  });
  video.addEventListener('play', sync);
  video.addEventListener('pause', sync);
  const disposers: (() => void)[] = [];
  // Asked to play when it comes into the window, as browsers start such a video by themselves: one
  // that declines (an iPhone in Low Power Mode) says so, and the button then offers to play it.
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver((entries) => {
      seen = entries.some((entry) => entry.isIntersecting);
      if (seen && !still() && !held && video.paused) play();
    });
    observer.observe(video);
    disposers.push(() => observer.disconnect());
  }
  const onMotion = () => {
    if (still()) { video.pause(); video.currentTime = 0; } else if (!held && seen) play();
  };
  motion?.addEventListener('change', onMotion);
  disposers.push(() => motion?.removeEventListener('change', onMotion));
  show(still() ? 'paused' : 'playing');
  // Zoomed, the video is a button (its alt names it, the primitives say what it does); the pause
  // button stays beside it, never inside.
  const shown = source.zoom ? element('button', { type: 'button', class: 't-zoom', 'data-t-zoom': true }, video) : video;
  return {
    frame: element('div', { class: 't-loop-frame' }, shown, toggle),
    video,
    dispose: () => { for (const dispose of disposers.splice(0)) dispose(); }
  };
}
