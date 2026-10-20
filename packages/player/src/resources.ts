// Resources (docs/decisions.md D58): the files and links of course.json resources, in a side panel.
// A PDF or an image opens in a preview over the module with « Télécharger »; any other file downloads
// directly; a link opens in a new tab.
//
// The PDF preview is the browser's own PDF viewer in a frame (Chromium's, Firefox's pdf.js, Safari's
// PDFKit): nothing is added to the package, and the file is a .pdf that every LMS web server serves
// (D7). Browsers without a viewer (Android, older iOS: navigator.pdfViewerEnabled false) get the
// file's card with « Télécharger » and « Ouvrir dans un nouvel onglet », which also stay in the
// preview's head for LMS frames that refuse a viewer.

import { element, uniqueId } from './dom.ts';
import { icon } from './icons.ts';
import { createSheet } from './sheet.ts';
import type { Labels } from './labels.ts';
import type { ResourceData } from './course-data.ts';
import type { Tooltip } from './tooltip.ts';

type FileResource = Extract<ResourceData, { kind: 'file' }>;

export interface ResourcesOptions {
  resources: readonly ResourceData[];
  labels: Labels;
  language: string;
  format(label: string, values: Readonly<Record<string, unknown>>): string;
  host: HTMLElement;
  tooltip: Tooltip | null;
  onToggle?(open: boolean): void;
  // The preview opened or closed (it is modal: the narration waits).
  onModal?(open: boolean): void;
}

// A file's size in the course's language: « 1,2 Mo », « 840 ko ».
export function fileSize(bytes: number, language: string): string {
  const units: [string, number][] = [['gigabyte', 1e9], ['megabyte', 1e6], ['kilobyte', 1e3]];
  for (const [unit, size] of units) {
    if (bytes >= size || unit === 'kilobyte') {
      const value = Math.max(bytes / size, unit === 'kilobyte' ? 1 : 0);
      try { return new Intl.NumberFormat(language, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: value < 10 ? 1 : 0 }).format(value); } catch { return `${Math.round(value)} ${unit[0].toUpperCase()}B`; }
    }
  }
  return String(bytes);
}

const IMAGES: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']);
export const isPdf = (resource: ResourceData) => resource.kind === 'file' && resource.type === 'pdf';
export const isImage = (resource: ResourceData) => resource.kind === 'file' && IMAGES.has(resource.type);
// What opens in the preview: a PDF or an image.
const previewed = (resource: ResourceData): boolean => isPdf(resource) || isImage(resource);
const hostOf = (url: string) => /^https:\/\/([^/?#:]+)/.exec(url)?.[1] ?? url;

export function createResources(options: ResourcesOptions) {
  const { labels } = options;
  const sheet = createSheet({ name: 'resources', title: labels.resources, closeLabel: labels.close, tooltip: options.tooltip, host: options.host, onToggle: options.onToggle });
  const info = (resource: ResourceData) => (resource.kind === 'link'
    ? `${labels.link} · ${hostOf(resource.url)}`
    : options.format(labels.fileInfo, { type: resource.type.toUpperCase() || '—', size: fileSize(resource.bytes, options.language) }));
  const list = element('ul', { class: 't-resource-list' }, options.resources.map((resource) => {
    const shown = previewed(resource);
    const infoId = uniqueId('t-resource-info');
    const content = [
      element('span', { class: 't-resource-icon' }, icon(resource.kind === 'link' ? 'link' : isImage(resource) ? 'image' : isPdf(resource) ? 'fileText' : 'file')),
      element('span', { class: 't-resource-text' },
        element('span', { class: 't-resource-title', text: resource.title }),
        resource.description ? element('span', { class: 't-resource-description', text: resource.description }) : null,
        element('span', { id: infoId, class: 't-resource-info', text: info(resource) }),
        resource.kind === 'link' ? element('span', { class: 't-sr-only', text: ` (${labels.opensInTab})` }) : null),
      element('span', { class: 't-resource-action', 'aria-hidden': 'true' }, icon(shown ? 'chevronRight' : resource.kind === 'link' ? 'external' : 'download'))
    ];
    // A PDF or an image opens its preview, a link a new tab; any other file is a download link.
    if (resource.kind === 'link') return element('li', {}, element('a', { class: 't-resource', 'data-resource': resource.id, 'data-kind': 'link', href: resource.url, target: '_blank', rel: 'noopener noreferrer', 'aria-describedby': infoId }, content));
    return element('li', {}, shown
      ? element('button', { type: 'button', class: 't-resource', 'data-resource': resource.id, 'aria-describedby': infoId, 'aria-haspopup': 'dialog', onclick: () => preview(resource) }, content)
      : element('a', { class: 't-resource', 'data-resource': resource.id, href: resource.src, download: '', 'aria-describedby': infoId }, content));
  }));
  sheet.body.append(list);

  // ── The preview of a PDF or an image ───────────────────────────────
  let viewer: HTMLDialogElement | null = null;
  function preview(resource: FileResource) {
    viewer?.close();
    const titleId = uniqueId('t-viewer-title');
    const close = element('button', { type: 'button', class: 't-icon-btn t-viewer-close', 'aria-label': labels.close, onclick: () => dialog.close() }, icon('close'));
    options.tooltip?.attach(close, labels.close);
    // An SVG opened as a page of its own would run its scripts with the package's origin (often the
    // LMS's): it is shown as an image only, and downloaded.
    const openTab = resource.type === 'svg' ? null : element('a', { class: 't-icon-btn t-viewer-tab', href: resource.src, target: '_blank', rel: 'noopener', 'aria-label': labels.openInTab }, icon('external'));
    if (openTab) options.tooltip?.attach(openTab, labels.openInTab);
    const download = element('a', { class: 't-nav-btn t-nav-btn--next t-viewer-download', href: resource.src, download: '' }, icon('download'), element('span', { class: 't-nav-label', text: labels.download }));
    const head = element('div', { class: 't-viewer-head' },
      element('div', { class: 't-viewer-name' }, element('h2', { id: titleId, class: 't-viewer-title', tabindex: '-1', text: resource.title }), element('span', { class: 't-resource-info', text: info(resource) })),
      element('div', { class: 't-viewer-actions' }, download, openTab, close));
    const viewable = isImage(resource) || (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled !== false;
    const card = () => element('div', { class: 't-viewer-empty' }, icon('fileText'), element('p', { text: labels.previewUnavailable }));
    const frame = !isImage(resource) && viewable ? element('iframe', { class: 't-viewer-frame', src: `${resource.src}#navpanes=0&view=FitH`, title: resource.title }) : null;
    const body = isImage(resource)
      ? element('img', { class: 't-viewer-image', src: resource.src, alt: resource.title })
      : frame ?? card();
    if (frame) whenUnshown(frame, resource.src, () => frame.replaceWith(card()));
    const dialog: HTMLDialogElement = element('dialog', { class: 't-viewer', 'aria-labelledby': titleId, 'data-resource': resource.id }, head, element('div', { class: 't-viewer-body' }, body));
    dialog.addEventListener('close', () => { dialog.remove(); if (viewer === dialog) viewer = null; options.onModal?.(false); list.querySelector<HTMLElement>(`[data-resource="${resource.id}"]`)?.focus({ preventScroll: true }); });
    document.body.append(dialog);
    viewer = dialog;
    dialog.showModal();
    head.querySelector<HTMLElement>('.t-viewer-title')?.focus({ preventScroll: true });
    options.onModal?.(true);
  }

  return { sheet, preview, get viewer() { return viewer; }, dispose() { viewer?.close(); sheet.dispose(); } };
}

// The browser shows a PDF in a frame only when it comes as application/pdf, inline: a server that
// sends it as anything else (application/octet-stream, an attachment: some LMSs, and the local
// servers before 20 Oct 2026) makes it a download, and the frame stays on its empty first document
// with no load event (measured in Chrome and Electron). Then the file's card replaces the frame,
// under « Télécharger » and « Ouvrir dans un nouvel onglet ». What the server says decides (a HEAD
// request, same origin only); a server that does not answer it leaves the frame 8 s to show the
// file, so that a slow LMS is not taken for one that refuses.
function whenUnshown(frame: HTMLIFrameElement, src: string, fallBack: () => void): void {
  let url: URL;
  try { url = new URL(src, document.baseURI); } catch { return; }
  if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return;
  let shown = false;
  frame.addEventListener('load', () => { shown = true; }, { once: true });
  const fall = () => { if (!shown && frame.isConnected) { shown = true; fallBack(); } };
  const empty = () => { try { return frame.contentDocument?.URL === 'about:blank'; } catch { return false; } };
  fetch(url.href, { method: 'HEAD', cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error(String(response.status));
    const type = response.headers.get('content-type') ?? '';
    if (!/^application\/pdf\b/i.test(type) || /^\s*attachment/i.test(response.headers.get('content-disposition') ?? '')) fall();
  }).catch(() => { setTimeout(() => { if (empty()) fall(); }, 8000); });
}
