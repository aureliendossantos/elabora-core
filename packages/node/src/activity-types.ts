import type { Author } from '@elabora/core/ops/types';

// The agents' activity as the window sees it (activity.ts writes and reads it): no Node here, the
// app's window imports these types.

// What an operation does, in the words the app gives each family (present while it runs, past once
// done). The CLI's catalogue (packages/cli/src/activity.ts) gives every tool and command its family.
export const ACTIVITY_FAMILIES = [
  // Reading
  'learn', 'docs', 'module', 'plan', 'screen', 'search', 'sources', 'reviews', 'blocks', 'object', 'voices', 'sounds', 'translations', 'status',
  // Looking and checking
  'look', 'check', 'fit', 'try-object', 'dialogue',
  // Writing
  'write-screen', 'write-plan', 'write-course', 'design', 'write-object', 'translate', 'media', 'record', 'listen', 'package', 'download', 'undo'
] as const;
export type ActivityFamily = (typeof ACTIVITY_FAMILIES)[number];

export interface ActivityEntry {
  at: string;           // ISO
  id: string;           // the call's: its start and its end share it
  phase: 'start' | 'end';
  op: string;           // the tool (elabora_look) or the command (look)
  family: ActivityFamily;
  author: Author;
  // Where, when the operation says it: a screen's id, a page of the manual, a language.
  screen?: string;
  page?: string;
  language?: string;
  ok?: boolean;         // at the end: whether it succeeded
}
