import type { ChangeLike, Op } from '@elabora/core/ops/types';
import type { DiagnosticsDelta } from './project-state.ts';
import type { ChangeView, EngineEvent } from '../protocol.ts';

// A journal entry and a change of findings as the protocol tells them.

export function changeView(entry: ChangeLike): ChangeView {
  return {
    type: entry.type, id: entry.id, seq: entry.seq, at: entry.at, author: entry.author, batch: entry.batch,
    ...(entry.command ? { command: entry.command } : {}),
    files: entry.files.map((file) => file.path), ops: entry.ops as Op[],
    ...(entry.unavailable?.length ? { unavailable: entry.inverse.flatMap((op) => (op.op === 'write' && 'blob' in op && entry.unavailable?.includes(op.blob) ? [op.file] : [])) } : {}),
    ...(entry.type === 'undo' ? { undoes: entry.undoes, skipped: entry.skipped } : {})
  };
}

export function diagnosticsEvent(delta: DiagnosticsDelta): EngineEvent {
  return {
    type: 'diagnostics', screens: Object.fromEntries(delta.screens), removed: delta.removed, summary: delta.summary,
    ...(delta.project ? { project: delta.project } : {})
  };
}
