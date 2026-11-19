// Narration types that leave the process (the engine's protocol names them), with no import, as
// voice/types.ts: the app window's typecheck never brings Node modules.

export interface LinePeaks {
  line: string;
  duration: number;
  // The loudest sample of each slice of the line's audio, 0 to 255.
  peaks: Uint8Array;
}

export interface NarrationPeaks {
  screen: string;
  language: string;
  perSecond: number;
  // The lines that have audio, in their order (missing lines are left out).
  lines: LinePeaks[];
}

export interface ImportedFile {
  file: string;
  status: 'imported' | 'unmatched' | 'failed';
  screen?: string;
  line?: string;
  // How the file found its line: its name (l2.wav, accueil-l2.m4a, 02.wav: the second line), or
  // what it says (the line whose text the word aligner finds best in it).
  by?: 'name' | 'voice';
  reason?: string;
  change?: number | null;
}
