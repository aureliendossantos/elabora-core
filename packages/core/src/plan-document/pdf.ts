// How the plan's document is printed to PDF (docs/decisions.md D48): by Electron's
// webContents.printToPDF in the app, and in the command line when the app is installed (D26); else by
// Chrome's Page.printToPDF through Playwright. The page's own @page rule gives A4, its margins and its
// footer, so the two only need these few settings. Chromium dates the file when it prints;
// finishPlanPdf puts the document's day there instead, so the same page printed by the same Chromium
// is the same bytes (D8).

// Electron's webContents.printToPDF(options).
export const PLAN_PDF_ELECTRON = {
  preferCSSPageSize: true,
  printBackground: true,
  displayHeaderFooter: false,
  generateTaggedPDF: true,
  generateDocumentOutline: true
} as const;

// The offscreen window Electron prints in (A4 at 96 dpi), the same for the app and the command line:
// the page is laid out for print, but its window is part of what Chromium is given.
export const PLAN_PDF_WINDOW = { width: 794, height: 1123 } as const;

// Playwright's page.pdf(options), Chromium's Page.printToPDF underneath (Chrome, Edge, Playwright's
// Chromium: Electron's DevTools protocol has none, so Electron prints with PLAN_PDF_ELECTRON).
export const PLAN_PDF_PLAYWRIGHT = {
  preferCSSPageSize: true,
  printBackground: true,
  displayHeaderFooter: false,
  tagged: true,
  outline: true
} as const;

// The PDF's creation and modification dates set to the document's day (YYYY-MM-DD) at noon UTC.
// Chromium (Skia) writes them as « (D:20261015145446+00'00') » in the Info dictionary: the new
// value has the same length, so the cross-reference offsets stay right.
export function finishPlanPdf(pdf: Uint8Array, date: string): Uint8Array {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!day) return pdf;
  const stamp = `${day[1]}${day[2]}${day[3]}120000`;
  const out = new Uint8Array(pdf);
  // latin1: one character per byte, offsets kept.
  let text = '';
  for (let index = 0; index < out.length; index += 0x8000) text += String.fromCharCode(...out.subarray(index, index + 0x8000));
  const pattern = /\/(CreationDate|ModDate)\s*\(D:(\d{14})/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const at = match.index + match[0].length - 14;
    for (let index = 0; index < 14; index++) out[at + index] = stamp.charCodeAt(index);
  }
  return out;
}
