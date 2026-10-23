// The player's icons: drawn here (no icon font, no file, no licence to carry), 24 × 24 strokes in
// the text colour, as the Lin pages draw them. The bars show them at 20 px, their menus at 18 px.

import { element } from './dom.ts';

const PATHS = {
  play: '<path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
  replay: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v5h5"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6"/>',
  settings: '<path d="M19.06 10.6l2.47.27v2.26l-2.47.27-1.07 2.6 1.55 1.94-1.6 1.6-1.94-1.55-2.6 1.07-.27 2.47h-2.26l-.27-2.47-2.6-1.07-1.94 1.55-1.6-1.6 1.55-1.94-1.07-2.6-2.47-.27v-2.26l2.47-.27 1.07-2.6-1.55-1.94 1.6-1.6 1.94 1.55 2.6-1.07.27-2.47h2.26l.27 2.47 2.6 1.07 1.94-1.55 1.6 1.6-1.55 1.94z"/><circle cx="12" cy="12" r="3"/>',
  volume: '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  volumeLow: '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>',
  muted: '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  transcript: '<path d="M7 3.5h9.5a2.5 2.5 0 0 1 2.5 2.5v12.5"/><path d="M5 20.5h10.5a2 2 0 0 0 2-2V8"/><path d="M5 20.5a2 2 0 0 1-2-2v-1h10v1a2 2 0 0 0 2 2M9 8h6M9 12h6"/><path d="M7 3.5a2 2 0 0 0-2 2v12"/>',
  more: '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  chevronLeft: '<path d="M14.5 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  folder: '<path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V9"/><path d="M3.6 10.2A1.5 1.5 0 0 1 5 9h15.3a1.5 1.5 0 0 1 1.4 1.9l-1.9 7.6a2 2 0 0 1-1.9 1.5H5a2 2 0 0 1-2-2v-7z"/>',
  book: '<path d="M12 6.5C10.3 5.2 7.8 4.5 4 4.5v13c3.8 0 6.3.7 8 2 1.7-1.3 4.2-2 8-2v-13c-3.8 0-6.3.7-8 2z"/><path d="M12 6.5v13"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none"/>',
  spark: '<path d="M12 3.5l1.9 5.1a2 2 0 0 0 1.2 1.2l5.1 1.9-5.1 1.9a2 2 0 0 0-1.2 1.2L12 20l-1.9-5.2a2 2 0 0 0-1.2-1.2L3.8 11.7l5.1-1.9a2 2 0 0 0 1.2-1.2z"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M4.5 16v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V16"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  file: '<path d="M14 3.5H7A2 2 0 0 0 5 5.5v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/>',
  fileText: '<path d="M14 3.5H7A2 2 0 0 0 5 5.5v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5M8.5 13h7M8.5 16.5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.8 2.8L16.2 9.6"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  exit: '<path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h9.5"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-4.5-4.5-9.5 8"/>',
  textSize: '<path d="M3 18.5l5-13 5 13M4.8 14h6.4"/><path d="M14.5 18.5l3.2-8 3.3 8M15.6 16h4.2"/>',
  languages: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  note: '<path d="M5.5 4h13a1.5 1.5 0 0 1 1.5 1.5V14l-6 6H5.5A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4z"/><path d="M20 14h-4.5a1.5 1.5 0 0 0-1.5 1.5V20M8 9h8M8 12.5h4.5"/>',
  half: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v5h5M12 7.5V12l3 2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>'
} as const;

export type IconName = keyof typeof PATHS;

// An icon, hidden from screen readers (its button says what it does).
export function icon(name: IconName, className = ''): HTMLElement {
  return element('span', { class: `t-icon t-icon--${name}${className ? ` ${className}` : ''}`, 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">${PATHS[name]}</svg>` });
}
