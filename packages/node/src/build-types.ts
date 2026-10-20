// The web target's settings (docs/decisions.md D41), types that leave the process (the engine's
// protocol names them), with no import, as voice/types.ts: the app window's typecheck never brings
// Node modules.

export type WebProgress = 'local' | 'none';
export type WebNavigation = 'authored' | 'free';

export interface WebBuildOptions {
  // local (default): kept in the browser (localStorage), resumed from one visit to the next;
  // none: nothing kept anywhere, a reload starts again.
  progress?: WebProgress;
  // authored (default): the course's navigation rules; free: every screen open from the outline and
  // Next, no lock until complete, narrations seekable (a showcase, a review).
  navigation?: WebNavigation;
  noindex?: boolean; // asks search engines not to index the module (meta robots)
  url?: string; // absolute address where index.html is served: canonical link, og:url, sharing image
  image?: string; // sharing image (PNG, JPEG, WebP): a path in the course folder (assets/…) or absolute
  // A review build (D42): the module carries the review bridge (elabora/review.js) and speaks
  // elabora-review/1 with pages of these origins only (https://revue.elabora.studio; http on this
  // computer for development). Its defaults are those of a review: progress none, navigation free,
  // noindex.
  review?: WebReviewOptions;
}

export interface WebReviewOptions {
  origins: string[];
}
