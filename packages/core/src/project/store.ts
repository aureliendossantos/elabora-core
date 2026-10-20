import type { FileHash } from './files.ts';

// Where a project's files live (docs/architecture.md, Store): a folder on the desktop (FsStore in
// @elabora/node), later a browser store or a server. Paths are project-relative POSIX paths, as in
// a files snapshot. The core only defines the interface: it never touches a store itself.

export interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface Store {
  readonly id: string; // folder path, or a URI for remote stores
  // Every file of the project (tool folders, OS files and temporary files left out), sorted by path.
  list(): Promise<FileInfo[]>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array): Promise<void>; // atomic: readers never see half a file
  remove(path: string): Promise<void>;
  // Calls onChange with the paths that changed (project files only), as they change; an empty list
  // means changes the store could not name (an overflowing watcher): list the files again.
  // Calls onReady once, when what is written from then on is reported (a watcher can start a moment
  // after watch returns: FSEvents); a store that cannot tell calls it at once, or after a bound of a
  // few seconds. Returns a function that stops watching.
  watch?(onChange: (paths: string[]) => void, onReady?: () => void): () => void;
  // Optional, for stores that know more than the interface needs: a file's size and time (null
  // when it does not exist), and the hash of its bytes, cached so that media are hashed once.
  stat?(path: string): Promise<FileInfo | null>;
  hash?(path: string): Promise<FileHash>;
}
