import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bytesOnDisk, downloading, filesInstalled, filesSize, holdFiles, holders, installFiles, lockHolder, removeFiles, withLock } from './download.ts';
import type { DownloadProgress, DownloadWording, ModelFile } from './download.ts';

// A compatibility entry is an exact, reviewed release, including its checksummed files. Unknown
// installed versions are incompatible by default. Compatibility also promises the current runtime,
// tokenizer/voice catalogue and model-specific options can consume those files.
export interface ModelRelease {
  version?: string;
  model: string;
  files: readonly ModelFile[];
}
export interface VersionedModel extends ModelRelease {
  compatible?: readonly ModelRelease[];
  incompatible?: readonly string[];
}
export interface ModelVersionState {
  installedVersion: string | null;
  desiredVersion: string;
  update: 'absent' | 'current' | 'available' | 'required';
}
interface Located { dir: string; release: ModelRelease }
const receipt = 'release.json';
const revisions = (base: string) => `${base}.versions`;
const family = (base: string) => `${base}.catalogue`;

export function releaseVersion(release: ModelRelease): string {
  return release.version ?? crypto.createHash('sha256').update(JSON.stringify(release.files.map(({ name, sha256 }) => [name, sha256]))).digest('hex').slice(0, 16);
}
const directoryName = (release: ModelRelease) => `${releaseVersion(release).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)}-${crypto.createHash('sha256').update(JSON.stringify(release.files)).digest('hex').slice(0, 12)}`;

function directories(base: string): string[] {
  let names: fs.Dirent[] = [];
  try { names = fs.readdirSync(revisions(base), { withFileTypes: true }); } catch { /* absent */ }
  return [base, ...names.filter(name => name.isDirectory() && !name.isSymbolicLink()).map(name => path.join(revisions(base), name.name))];
}
function candidates(model: VersionedModel): ModelRelease[] {
  const banned = new Set(model.incompatible ?? []);
  if (banned.has(releaseVersion(model)) || model.compatible?.some(version => banned.has(releaseVersion(version)))) throw new Error('A model release cannot be both compatible and incompatible.');
  return [model, ...(model.compatible ?? [])];
}
function locate(base: string, model: VersionedModel): Located | null {
  const dirs = directories(base);
  for (const release of candidates(model)) {
    // Prefer the version directory; keep existing unversioned installations usable in place.
    const dir = [path.join(revisions(base), directoryName(release)), ...dirs].find(dir => filesInstalled(dir, release.files));
    if (dir) return { dir, release };
  }
  return null;
}
function recordedVersion(dir: string): string | null {
  try { const value = JSON.parse(fs.readFileSync(path.join(dir, receipt), 'utf8')); return typeof value.version === 'string' ? value.version : null; } catch { return null; }
}
// A first installation in the original layout says which release it is downloading until it is complete: without
// this mark, verified files there could be a complete earlier release that the new one only adds files to.
const pending = 'pending.json';
function pendingVersion(dir: string): string | null {
  try { const value = JSON.parse(fs.readFileSync(path.join(dir, pending), 'utf8')); return typeof value.version === 'string' ? value.version : null; } catch { return null; }
}
// Whether a folder holds an earlier release, which an upgrade never overwrites (D55): its receipt names another
// version, or a compatible release is complete there, or it has verified files and is not the marked first
// installation of this release (a legacy layout without a receipt counts as earlier: kept, never removed).
function holdsEarlierRelease(dir: string, model: VersionedModel): boolean {
  const recorded = recordedVersion(dir);
  if (recorded !== null) return recorded !== releaseVersion(model);
  if ((model.compatible ?? []).some(release => filesInstalled(dir, release.files))) return true;
  let verified: Record<string, string> = {};
  try { verified = JSON.parse(fs.readFileSync(path.join(dir, 'verified.json'), 'utf8')); } catch { return false; }
  const names = Object.keys(verified);
  if (!names.length) return false;
  return !(pendingVersion(dir) === releaseVersion(model) && names.every(name => model.files.some(file => file.name === name && file.sha256 === verified[name])));
}
// Keep the original layout for a first installation and resume its partial download. Upgrades
// never overwrite that layout: the previous files stay usable until the new release is complete.
export function desiredModelDir(base: string, model: VersionedModel): string {
  if (filesInstalled(base, model.files)) return base;
  return holdsEarlierRelease(base, model) || fs.existsSync(revisions(base)) ? path.join(revisions(base), directoryName(model)) : base;
}
export const modelDir = (base: string, model: VersionedModel): string => locate(base, model)?.dir ?? desiredModelDir(base, model);
export const modelInstalled = (base: string, model: VersionedModel): boolean => locate(base, model) !== null;
export const modelBytes = (base: string): number => directories(base).reduce((sum, dir) => sum + bytesOnDisk(dir), 0);
export const modelHolders = (base: string): number[] => [...new Set(directories(base).flatMap(holders))];
export const modelDownloading = (base: string, model: VersionedModel) => [desiredModelDir(base, model), ...directories(base)].map(dir => downloading(dir, model.files)).find(Boolean) ?? null;

export function modelVersionState(base: string, model: VersionedModel): ModelVersionState {
  const current = locate(base, model);
  const desiredVersion = releaseVersion(model);
  const old = directories(base).find(dir => holdsEarlierRelease(dir, model));
  return {
    installedVersion: current ? releaseVersion(current.release) : old ? recordedVersion(old) ?? 'legacy' : null,
    desiredVersion,
    update: current ? releaseVersion(current.release) === desiredVersion && filesInstalled(current.dir, model.files) ? 'current' : 'available' : old ? 'required' : 'absent'
  };
}

// A completed receipt is for status/migration, never authority to run an unlisted version.
function writeReceipt(dir: string, release: ModelRelease): void {
  const temp = path.join(dir, `${receipt}.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify({ version: releaseVersion(release), model: release.model }));
  fs.renameSync(temp, path.join(dir, receipt));
}

export async function installModel(id: string, base: string, model: VersionedModel, host: string, wording: DownloadWording, options: { updateOnly?: boolean; signal?: AbortSignal; onProgress?: (progress: DownloadProgress) => void } = {}): Promise<string> {
  candidates(model); // reject a contradictory release policy before touching files
  const familyRelease = await holdFiles(family(base), options.signal);
  try {
    if (options.updateOnly && !['available', 'required'].includes(modelVersionState(base, model).update)) return desiredModelDir(base, model);
    const target = desiredModelDir(base, model);
    // Reuse unchanged files from a reviewed release. A hold prevents concurrent cleanup/removal;
    // installFiles verifies each copied file before recording it in the new release.
    const old = locate(base, model);
    const release = old && old.dir !== target ? await holdFiles(old.dir, options.signal) : null;
    // A first installation in place is marked, so that what it has verified is never taken for an earlier release.
    if (target === base && !holdsEarlierRelease(base, model) && recordedVersion(base) === null) {
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(path.join(base, pending), JSON.stringify({ version: releaseVersion(model) }));
    }
    let dir: string;
    try {
      dir = await installFiles(id, target, model.files, host, wording, { ...options, prepare: () => {
        if (!old || old.dir === target) return;
        for (const file of model.files) {
          const same = old.release.files.find(candidate => candidate.name === file.name && candidate.sha256 === file.sha256 && candidate.size === file.size);
          if (!same || fs.existsSync(path.join(target, file.name))) continue;
          const from = path.join(old.dir, same.name);
          const to = path.join(target, file.name);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          try { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
      } });
    } finally { release?.(); }

    writeReceipt(dir, model);
    fs.rmSync(path.join(dir, pending), { force: true });
    return dir;
  } finally { familyRelease(); }
}

// Directory leases pin a version for an entire call, including while its worker still uses it.
// Re-check after taking the hold: another process may have removed it between discovery and hold.
export async function acquireModel(base: string, model: VersionedModel, wording: DownloadWording, signal?: AbortSignal): Promise<{ dir: string; model: string; version: string; release: () => void }> {
  for (;;) {
    signal?.throwIfAborted();
    const held = await withLock(family(base), 'hold', async () => {
      const selected = locate(base, model);
      if (!selected) throw wording.fail(`No compatible ${wording.what} is installed.`);
      return { selected, release: await holdFiles(selected.dir, signal) };
    }, signal);
    const { selected, release } = held;
    if (!filesInstalled(selected.dir, selected.release.files)) { release(); continue; }
    // Cleanup is best effort: an old native session on Windows may still have its files open.
    const cleanup = () => { if (modelVersionState(base, model).update === 'current') void pruneModels(base, model, wording).catch(() => {}); };
    cleanup();
    return { dir: selected.dir, model: selected.release.model, version: releaseVersion(selected.release), release: () => { release(); cleanup(); } };
  }
}

export async function holdModel(base: string, model: VersionedModel, wording: DownloadWording, signal?: AbortSignal): Promise<() => void> {
  const release = await withLock(family(base), 'hold', () => holdFiles(modelDir(base, model), signal), signal);
  return () => { release(); if (modelVersionState(base, model).update === 'current') void pruneModels(base, model, wording).catch(() => {}); };
}
async function pruneModels(base: string, model: VersionedModel, wording: DownloadWording): Promise<void> {
  return withLock(family(base), 'remove', async () => {
    const selected = locate(base, model);
    if (!selected || !filesInstalled(selected.dir, model.files)) return;
    for (const dir of directories(base)) {
      if (dir === selected.dir || holders(dir).length || lockHolder(dir)) continue;
      await removeFiles(dir, wording).catch(() => {});
    }
  });
}

export async function removeModels(base: string, model: VersionedModel, wording: DownloadWording, partial = false): Promise<number> {
  // What a stopped download left: never a folder that holds an earlier release.
  if (partial) {
    const dir = desiredModelDir(base, model);
    return dir === base && holdsEarlierRelease(base, model) ? 0 : removeFiles(dir, wording, { partial: model.files });
  }
  return withLock(family(base), 'remove', async () => {
    const dirs = directories(base);
    if (holders(family(base)).length) throw wording.busy(`The ${wording.what} is being downloaded by another Elabora process.`);
    const using = modelHolders(base);
    if (using.length) throw wording.busy(`The ${wording.what} is in use${using.some(pid => pid !== process.pid) ? ` by another Elabora process (${using.filter(pid => pid !== process.pid).join(', ')})` : ''}: ${wording.using}.`);
    if (dirs.some(dir => lockHolder(dir))) throw wording.busy(`The ${wording.what} is being downloaded by another Elabora process.`);
    let freed = 0;
    for (const dir of dirs) freed += await removeFiles(dir, wording);
    try { fs.rmdirSync(revisions(base)); } catch { /* absent, or still contains a completed version */ }
    fs.rmSync(family(base), { recursive: true, force: true });
    return freed;
  });
}
