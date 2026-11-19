// The word aligner's types that leave the process (the engine's protocol names them), with no
// import, as voice/types.ts: the app window's typecheck never brings Node modules.

export interface AlignerView {
  language: string;
  model: string;        // what a sidecar records as its aligner
  installed: boolean;
  size: number;         // bytes to download once
}

export type AlignProgress =
  | { phase: 'install'; received: number; total: number }
  | { phase: 'line'; screen: string; line: string; index: number; count: number };

export interface AlignedLine {
  screen: string;
  line: string;
  status: 'aligned' | 'skipped' | 'failed';
  reason?: string;
  words?: number;
  // Words the voice may have swallowed: two letters or more, scored under 0.25 (D27).
  doubtful?: { word: string; score: number }[];
}

export interface AlignResult {
  language: string;
  aligner: string | null;
  lines: AlignedLine[];
  changes: number[];
  cancelled?: boolean;
}
