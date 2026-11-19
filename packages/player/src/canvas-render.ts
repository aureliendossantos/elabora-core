// The render a host sends its canvas pages (canvas-protocol.ts, ScreenRender), made from what the renderer gave: the
// screen, the course reduced to it, its view, the design layer, the files it uses with the hash of their content (never
// their content), the outline of the live bars. The desktop's local host sends it as server-sent events, a page of the
// web by postMessage and the browser engine's events (CanvasRenderEvent); this is the one place that says its shape.
// Pure: no Node, nothing of the DOM.

import type { RenderFile, RenderOutline, RenderStyles, RenderView, ScreenRender } from './canvas-protocol.ts';
import type { CourseData } from './course-data.ts';

// What the renderer gives (core's RenderedScreen has more, which the page does not need).
export interface ScreenRenderSource {
  screen: string;
  course: CourseData;
  view: RenderView;
  styles?: RenderStyles;
  files?: readonly RenderFile[];
  outline?: RenderOutline;
}

// `styles` is left out when the page has them already (their hash): a host that knows what its page holds.
export function screenRenderOf(render: ScreenRenderSource, { styles = true }: { styles?: boolean } = {}): ScreenRender {
  return {
    screen: render.screen, course: render.course, view: render.view,
    ...(styles && render.styles ? { styles: render.styles } : {}),
    ...(render.files ? { files: render.files.map(({ path, kind, hash }) => ({ path, kind, hash })) } : {}),
    ...(render.outline ? { outline: render.outline } : {})
  };
}
