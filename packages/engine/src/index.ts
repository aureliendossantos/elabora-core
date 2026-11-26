// @elabora/engine: the editing session of the desktop app (docs/architecture/engine.md).
//   const session = await openProject(dir);
//   session.subscribe((message) => port.postMessage(message));
//   port.onmessage = async ({ data }) => port.postMessage(await session.handle(data));
export { openProject, Session, type OpenOptions, type BackupOptions, type CloseOptions } from './session.ts';
export { changeView } from './base/events.ts';
export { ProjectState, type DiagnosticsDelta } from './base/project-state.ts';
export { EngineError, protocolError } from './errors.ts';
export { rewriteAssetReferences } from './base/references.ts';
export { Renderer } from './base/render.ts';
export type { SessionStore } from './disk.ts';
export type { MediaOptions } from './media.ts';
export * from './protocol.ts';
