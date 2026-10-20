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

// « Nouvelle réplique depuis un fichier audio… » (docs/decisions.md D46): a new line, its text what
// the recording says (transcribed unless given), its audio the recording.
export interface LineFromAudioFileArgs {
  screen: string;
  file: string;                    // any audio ffmpeg reads (an absolute path through the engine)
  text?: string;                   // what it says (default: transcribed)
  after?: string | null;           // after this line (null: first; default: last)
  step?: number;                   // default: the step of the line before it
  speaker?: string;                // default: the speaker of the line before it
  language?: string;               // the course's
  trim?: boolean;                  // silence at both ends trimmed (default true)
  service?: 'local' | 'elevenlabs'; // who transcribes (default: this computer)
  approvedPercent?: number;        // ElevenLabs: the share of the quota the author approved (D30)
  install?: boolean;               // download the local transcriber first when it is not here
}

// « Régénérer le texte d'après l'audio »: the line's text becomes what its recording says (given,
// as the author checked it, or transcribed now); the recording stays.
export interface TextFromAudioFileArgs {
  screen: string;
  line: string;
  language?: string;
  text?: string;
  audioHash?: `sha256:${string}`;  // the audio it was heard in (refused when the line's audio changed since)
  service?: 'local' | 'elevenlabs';
  approvedPercent?: number;
  install?: boolean;
}
