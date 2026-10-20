import type { PlanDocument } from '@elabora/core/plan-document/model';

// The types of the plan's document as a file (plan-document.ts, D48), without Node: the engine's
// protocol gives them to the app's renderer, which has no Node types.

export type PlanDocumentFormat = 'docx' | 'pdf' | 'html';
export const PLAN_DOCUMENT_FORMATS: readonly PlanDocumentFormat[] = ['docx', 'pdf', 'html'];

export interface ExportedPlanDocument {
  file: string;
  format: PlanDocumentFormat;
  bytes: number;
  state: PlanDocument['status']['state'];
  // The version it shows (« V2 »), or null for the working copy; exporting never makes one (D52).
  version: string | null;
  // Whether the send was recorded on that version (exportPlanDocument does; the engine records it
  // through its own queue).
  sent: boolean;
  browser?: { engine: string; version: string };
}
