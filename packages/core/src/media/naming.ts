// Where an imported medium goes and what it is called, the same on both hosts
// (docs/architecture/media.md, « Import and optimisation »).

import type { MediaKind } from './presets.ts';

export const MEDIA_FOLDERS = { video: 'assets/video', audio: 'assets/audio', image: 'assets/images', vector: 'assets/images' } as const;

// "Présentation du Réseau (v2).MOV" → "presentation-du-reseau-v2": portable in every LMS.
export function slugify(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug || 'media';
}

export function normaliseExtension(extension: string): string {
  return extension === '.jpeg' ? '.jpg' : extension === '.tiff' ? '.tif' : extension;
}

// A project-relative POSIX path that stays inside the project.
export function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath) || relPath.includes('\\')) return false;
  const parts: string[] = [];
  for (const part of relPath.split('/')) {
    if (part === '..') { if (!parts.length) return false; parts.pop(); } else if (part && part !== '.') parts.push(part);
  }
  return true;
}

// The folder of assets/ an import goes to: the kind's, or the one asked (« images » is assets/images);
// null when the one asked leaves assets/.
export function importFolder(kind: MediaKind, to?: string): string | null {
  const given = (to ?? MEDIA_FOLDERS[kind]).replace(/^\.\//, '').replace(/\/+$/, '');
  const folder = given === 'assets' || given.startsWith('assets/') ? given : `assets/${given}`;
  return !given || given.split('/').includes('..') || !isSafeRelativePath(folder) ? null : folder;
}

// intro.mp4, then intro-2.mp4, intro-3.mp4…: never a path taken. Compared without case: macOS and
// Windows file systems ignore it.
export function uniquePathAmong(relPath: string, taken: (candidate: string) => boolean): string {
  const dot = relPath.lastIndexOf('.');
  const extension = dot > relPath.lastIndexOf('/') ? relPath.slice(dot) : '';
  const stem = extension ? relPath.slice(0, -extension.length) : relPath;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? relPath : `${stem}-${n}${extension}`;
    if (!taken(candidate)) return candidate;
  }
}
