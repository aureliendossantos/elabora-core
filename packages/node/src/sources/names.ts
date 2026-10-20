// The names of sources (docs/decisions.md D49). A source keeps the name the author knows it by,
// accents and spaces included, made safe on every system the module may travel to: Windows refuses
// < > : " / \ | ? *, control characters, a trailing dot or space and its device names (CON, NUL…);
// macOS writes accents decomposed and Windows composed, so names are compared in NFC and without
// case (both file systems ignore it). A name is never taken twice, nor by what a source's readable
// version is called (its .md and its .files folder).

export const READABLE_SUFFIX = '.md';
export const PARTS_SUFFIX = '.files';
// Room for ".files/slide-100.png" and a deep library path on Windows (260 characters by default).
const MAX_NAME_LENGTH = 120;
const MAX_EXTENSION_LENGTH = 12;

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

export const nameKey = (name: string): string => name.normalize('NFC').toLowerCase();

// The extension of a name as Elabora reads it (".docx"), or "".
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  const extension = name.slice(dot);
  return extension.length <= MAX_EXTENSION_LENGTH && /^\.[\p{L}\p{N}_-]+$/u.test(extension) ? extension.toLowerCase() : '';
}

export function sourceName(raw: string): string {
  let name = raw.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '') // control and direction marks
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^[.\- ]+/, ''); // no hidden file, nothing a command line reads as an option
  const extension = extensionOf(name);
  let stem = extension ? name.slice(0, name.length - extension.length) : name;
  stem = stem.replace(/[. ]+$/, '');
  if (!stem) stem = 'source';
  if (WINDOWS_DEVICE.test(stem)) stem = `${stem}_`;
  const chars = [...stem];
  if (chars.length + extension.length > MAX_NAME_LENGTH) stem = chars.slice(0, MAX_NAME_LENGTH - extension.length).join('').trimEnd();
  name = `${stem}${extension}`;
  return name;
}

// A name that is not taken: « brief.docx », then « brief (2).docx », « brief (3).docx »…
export function freeName(name: string, taken: (key: string) => boolean): string {
  const extension = extensionOf(name);
  const stem = extension ? name.slice(0, name.length - extension.length) : name;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${extension}`;
    if (!nameReserved(candidate, taken)) return candidate;
  }
}

// Taken: the name itself, its readable version's names, or the source a readable name belongs to.
export function nameReserved(name: string, taken: (key: string) => boolean): boolean {
  const key = nameKey(name);
  if (taken(key) || taken(key + READABLE_SUFFIX) || taken(key + PARTS_SUFFIX)) return true;
  for (const suffix of [READABLE_SUFFIX, PARTS_SUFFIX]) if (key.endsWith(suffix) && taken(key.slice(0, -suffix.length))) return true;
  return false;
}
