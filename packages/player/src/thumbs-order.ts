// The order in which a window's miniatures are drawn (D130, D139), the same for live frames and for the painter's images: a preview the
// author chooses from first (« Ajouter un bloc », the Charte), then the screen of the editor's canvas, then those in the view as the eye
// reads them (a line, then the left first), then the nearest to the view.

import type { Scene, SceneRender, ThumbRequestName, ThumbRequests } from './thumbs-protocol.ts';

export const screenOf = (scene: Scene): string | null => (scene.kind === 'block' || scene.kind === 'charter' ? scene.args.screen : scene.screen);
// It opens over the miniatures of the window, which the view still counts.
export const previewing = (scene: Scene): boolean => scene.kind === 'block' || scene.kind === 'charter';

// How far from the view an element is, and among those in it, its place in reading order.
export function distance(element: Element): number {
  const box = element.getBoundingClientRect();
  const dy = Math.max(0, box.top - innerHeight, -box.bottom);
  const dx = Math.max(0, box.left - innerWidth, -box.right);
  return Math.hypot(dx, dy) * 1e9 + Math.round(Math.max(0, box.top)) * 1e4 + Math.max(0, box.left);
}

export function firstOf<T extends { element: Element; scene: Scene }>(waiting: readonly T[], current: string | null): T {
  return waiting.reduce((best, entry) => {
    if (previewing(entry.scene) !== previewing(best.scene)) return previewing(entry.scene) ? entry : best;
    const mine = current !== null && screenOf(entry.scene) === current;
    const theirs = current !== null && screenOf(best.scene) === current;
    if (mine !== theirs) return mine ? entry : best;
    return distance(entry.element) < distance(best.element) ? entry : best;
  });
}

// The engine's request for a scene (ThumbRequests).
export function requestOf(scene: Scene): { name: ThumbRequestName; params: ThumbRequests[ThumbRequestName]['params'] } {
  switch (scene.kind) {
    case 'screen': return { name: 'thumbRender', params: { screen: scene.screen, ...(scene.language !== undefined ? { language: scene.language } : {}) } };
    case 'moment': return { name: 'momentRender', params: { screen: scene.screen, at: scene.at } };
    case 'block': return { name: 'blockPreviewRender', params: { args: scene.args } };
    case 'charter': {
      const args = scene.args;
      return { name: 'blockPreviewRender', params: { args: 'layout' in args ? { screen: args.screen, layout: { layout: args.layout } } : 'style' in args ? { screen: args.screen, screenStyle: args.style } : { screen: args.screen, backdrop: args.backdrop } } };
    }
  }
}
export type BlockRender = SceneRender & { block: string; slides: boolean };
