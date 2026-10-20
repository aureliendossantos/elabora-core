import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findFont } from '@elabora/fonts';
import type { Project } from '@elabora/core/project/model';
import { planDocument } from '@elabora/core/plan-document/model';
import type { PlanDocument, PlanDocumentOptions } from '@elabora/core/plan-document/model';
import { planDocumentHtml, PLAN_DOCUMENT_FONT } from '@elabora/core/plan-document/html';
import { planDocumentDocx } from '@elabora/core/plan-document/docx';
import { finishPlanPdf, PLAN_PDF_ELECTRON, PLAN_PDF_PLAYWRIGHT, PLAN_PDF_WINDOW } from '@elabora/core/plan-document/pdf';
import { loadProjectFromDir } from './project-reader.ts';
import { FONTS_DIR } from './fonts/index.ts';
import { createZip } from './zip.ts';
import { recordPlanSend } from './edit/index.ts';
import type { EditOptions } from './edit/index.ts';
import { writeFileAtomic } from './util/fs.ts';
import { errorMessage } from './util/values.ts';
import { PLAN_DOCUMENT_FORMATS } from './plan-document-types.ts';
import type { PlanDocumentFormat, ExportedPlanDocument } from './plan-document-types.ts';
import { CHROMIUM_CHANNELS, browserIdentity, launchBrowser } from './emulator/browser.ts';
import { findElectronRuntime, printWithElectron } from './emulator/electron.ts';

const require = createRequire(import.meta.url);

// The plan's document (docs/decisions.md D48) written as a file: Word (.docx, written here from the
// core's parts), HTML (one page holding its fonts), or PDF (that page printed by Chromium). The app
// reads the same model for its Document view and prints the same page itself (PLAN_PDF_ELECTRON).
// It shows a version of the plan (the latest by default) or the working copy (D52); exporting a
// version records that it was sent, and never makes a version.

export { PLAN_DOCUMENT_FORMATS } from './plan-document-types.ts';
export type { PlanDocumentFormat, ExportedPlanDocument } from './plan-document-types.ts';

// The model of a course folder's plan (or of a project already read); an error without a plan.
export function readPlanDocument(source: string | Project, options: PlanDocumentOptions = {}): PlanDocument {
  const project = typeof source === 'string' ? loadProjectFromDir(source) : source;
  const doc = planDocument(project, options);
  if (!doc) throw new Error(`No readable plan.json in ${project.root || 'this course'}.`);
  return doc;
}

// @font-face rules of the document's fonts (Inter for the text, JetBrains Mono for code), their
// WOFF2 inline: the page prints the same on every computer. From @elabora/fonts (SIL OFL, D22).
let fontFaces: string | null = null;
export function planDocumentFontFaces(): string {
  if (fontFaces !== null) return fontFaces;
  const rules: string[] = [];
  for (const [family, styles] of [[PLAN_DOCUMENT_FONT, ['normal', 'italic']], ['JetBrains Mono', ['normal']]] as const) {
    const font = findFont(family);
    if (!font) continue;
    for (const file of font.files.filter((candidate) => (styles as readonly string[]).includes(candidate.style))) {
      const data = fs.readFileSync(path.join(FONTS_DIR, file.path)).toString('base64');
      rules.push(`@font-face { font-family: "${font.family}"; font-style: ${file.style}; font-weight: ${file.weight}; font-display: block; src: url(data:font/woff2;base64,${data}) format("woff2"); unicode-range: ${file.unicodeRange}; }`);
    }
  }
  fontFaces = rules.join('\n');
  return fontFaces;
}

// The page of the document, fonts included: what --format html writes and what the PDF prints.
export function planDocumentPage(doc: PlanDocument): string {
  return planDocumentHtml(doc, { fontFaces: planDocumentFontFaces() });
}

// The .docx: the core's parts in a deterministic ZIP (D8).
export function planDocumentWord(doc: PlanDocument): Buffer {
  return createZip(planDocumentDocx(doc)).zip;
}

export interface PrintedPdf {
  pdf: Uint8Array;
  browser: { engine: string; version: string };
}

// The page printed to PDF: by Elabora's own Electron when the app is installed (D26), with
// webContents.printToPDF as the app prints it (its DevTools protocol has no Page.printToPDF), so that
// the command line and the app's « Exporter ▾ › PDF… » give the same file; else by Google Chrome,
// Microsoft Edge or Playwright's Chromium (Page.printToPDF). Both finish with finishPlanPdf.
export async function printPlanDocument(doc: PlanDocument, html = planDocumentPage(doc)): Promise<PrintedPdf> {
  const failures: string[] = [];
  const runtime = findElectronRuntime();
  if (runtime) {
    let folder: string | null = null;
    try {
      folder = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-plan-'));
      const file = path.join(folder, 'plan.html');
      fs.writeFileSync(file, html);
      const printed = await printWithElectron(require('playwright-core'), runtime, file, PLAN_PDF_ELECTRON, PLAN_PDF_WINDOW);
      return { pdf: finishPlanPdf(printed.pdf, doc.date), browser: { engine: 'electron', version: printed.version } };
    } catch (error) {
      failures.push(errorMessage(error).split('\n')[0]!);
    } finally {
      if (folder) fs.rmSync(folder, { recursive: true, force: true });
    }
  }
  let browser;
  try { browser = await launchBrowser('chromium', { channels: CHROMIUM_CHANNELS }); } catch (error) { failures.push(errorMessage(error)); }
  if (browser) {
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate('document.fonts.ready.then(() => undefined)');
      const pdf = await page.pdf(PLAN_PDF_PLAYWRIGHT);
      return { pdf: finishPlanPdf(pdf, doc.date), browser: browserIdentity(browser) };
    } catch (error) {
      failures.push(errorMessage(error).split('\n')[0]!);
    } finally {
      await browser.close().catch(() => {});
    }
  }
  throw new Error(`Cannot print the plan to PDF: ${failures.join('; ')}. Export it as Word (--format docx) or as a page to print (--format html), or install Google Chrome.`);
}

export interface ExportPlanDocumentOptions extends PlanDocumentOptions {
  format: PlanDocumentFormat;
  // The file to write; <course>/dist/<course id>-plan.<format> by default.
  out?: string;
  // Who exports, for the change that records the send (exportPlanDocument).
  author?: EditOptions['author'];
}


export function defaultPlanDocumentFile(project: Project, format: PlanDocumentFormat): string {
  const id = String(project.course?.id ?? project.plan?.id ?? 'course').replace(/[^A-Za-z0-9._-]+/g, '-');
  return path.join(path.resolve(project.root || '.'), 'dist', `${id}-plan.${format}`);
}

// The document of a project already read (the engine's), written to `out`.
export async function writePlanDocument(project: Project, options: ExportPlanDocumentOptions): Promise<ExportedPlanDocument> {
  if (!PLAN_DOCUMENT_FORMATS.includes(options.format)) throw new Error(`Unknown format "${options.format}": docx, pdf or html.`);
  const doc = readPlanDocument(project, options);
  const file = path.resolve(options.out ?? defaultPlanDocumentFile(project, options.format));
  let content: string | Uint8Array;
  let browser: PrintedPdf['browser'] | undefined;
  if (options.format === 'docx') content = planDocumentWord(doc);
  else if (options.format === 'html') content = planDocumentPage(doc);
  else ({ pdf: content, browser } = await printPlanDocument(doc));
  writeFileAtomic(file, content);
  return { file, format: options.format, bytes: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength, state: doc.status.state, version: doc.plan.version, sent: false, ...(browser ? { browser } : {}) };
}

// The document of a course folder written to file, and, when it shows a version, the send recorded
// on it (one change: « V2 envoyée le … »).
export async function exportPlanDocument(dir: string, options: ExportPlanDocumentOptions): Promise<ExportedPlanDocument> {
  const project = loadProjectFromDir(dir);
  const exported = await writePlanDocument(project, options);
  if (!exported.version) return exported;
  const date = readPlanDocument(project, options).date;
  recordPlanSend(dir, { version: exported.version, format: options.format, date }, options.author ? { author: options.author } : {});
  return { ...exported, sent: true };
}
