// What a browser keeps of a person's modules on the canvas host and the frames host, emptied as the person signs out: the player's local and session storage there (display settings, a preview's progress, keyed by
// the module). The window's page cannot empty another origin's storage: it frames each host's relay page, hidden, and asks it to
// (relay/forget). The relay's own files stay kept. Nothing of an author's object is there: an object's frame has an origin of its own.

import { RELAY_FRAME_SANDBOX } from './canvas-page-host.ts';
import { RELAY_PROTOCOL, parseRelayToApp } from './relay-protocol.ts';

// How long a host's relay page is waited for (its service worker registered on a first visit), in ms.
const FORGET_WAIT_MS = 10000;

// Each origin's answer: true once its storage is empty, false when its page could not say so in time (or could not empty it).
export async function forgetHostStorage({ origins, mount = document.body, timeoutMs = FORGET_WAIT_MS }: { origins: readonly string[]; mount?: HTMLElement; timeoutMs?: number }): Promise<Record<string, boolean>> {
  const answers = await Promise.all(origins.map((origin) => forgetOne(new URL(origin).origin, mount, timeoutMs)));
  return Object.fromEntries(origins.map((origin, index) => [origin, answers[index]!]));
}

function forgetOne(origin: string, mount: HTMLElement, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', RELAY_FRAME_SANDBOX);
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'display:none;width:0;height:0;border:0';
    let done = false;
    const end = (emptied: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      removeEventListener('message', heard);
      frame.remove();
      resolve(emptied);
    };
    const heard = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      const message = parseRelayToApp(event.data);
      if (message?.type === 'relay/ready') frame.contentWindow?.postMessage({ type: 'relay/forget', protocol: RELAY_PROTOCOL }, origin);
      else if (message?.type === 'relay/forgotten') end(message.emptied);
      else if (message?.type === 'relay/error') end(false);
    };
    const timer = setTimeout(() => end(false), timeoutMs);
    addEventListener('message', heard);
    frame.src = new URL('/relay.html', origin).href;
    mount.append(frame);
  });
}
