// A panel over a dialogue (D61): the History over a scene, the debrief over the thread. While one is
// open, the rest of the dialogue is dimmed under a veil and inert (nothing behind takes a click or the
// focus); a click on the veil closes the panel, as does Échap, and the focus comes back where it was.
// The page around the dialogue stays as it is. Not part of the pure walk.

import { element } from '../dom.ts';

export type DialogueModal = ReturnType<typeof createModal>;

export function createModal(root: HTMLElement) {
  const veil = element('div', { class: 't-dialogue-veil', hidden: true });
  root.append(veil);
  let open: { close(): void; inert: HTMLElement[]; back: HTMLElement | null } | null = null;
  veil.addEventListener('click', () => open?.close());
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !open || event.defaultPrevented) return;
    event.preventDefault();
    open.close();
  });

  return {
    get open(): boolean { return open !== null; },
    // keep: the panel and what goes with it (its close button), the dialogue's parts left usable;
    // close: what the veil and Échap do; focus: where the focus goes when it was in the dialogue,
    // or when the learner opened the panel (asked).
    show({ keep, close, focus, asked = false }: { keep: readonly (HTMLElement | null)[]; close(): void; focus: HTMLElement | null; asked?: boolean }) {
      // One panel at a time: the one open closes first.
      if (open) open.close();
      if (open) return;
      const active = document.activeElement;
      const back = active instanceof HTMLElement && active !== document.body && root.contains(active) ? active : null;
      // The focus first: what holds it may turn inert, and it never falls to the page.
      if (focus && (back || asked)) focus.focus({ preventScroll: true });
      const inert = [...root.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child !== veil && !keep.includes(child) && !child.inert);
      for (const child of inert) child.inert = true;
      veil.hidden = false;
      root.setAttribute('data-t-modal', '');
      open = { close, inert, back };
    },
    // fallback: where the focus goes when where it was is gone (what opened the panel).
    hide(fallback: HTMLElement | null = null) {
      if (!open) return;
      const { inert, back } = open;
      open = null;
      const active = document.activeElement;
      const inside = !active || active === document.body || root.contains(active);
      for (const child of inert) child.inert = false;
      veil.hidden = true;
      root.removeAttribute('data-t-modal');
      if (!inside) return;
      const target = back?.isConnected && !back.closest('[inert], [hidden]') ? back : fallback;
      target?.focus({ preventScroll: true });
    }
  };
}
