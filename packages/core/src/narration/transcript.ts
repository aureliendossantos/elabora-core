// What a transcriber heard in a recording: what a host gives the commands that write a line's text
// from its audio (docs/decisions/D110.md). The transcribers themselves run on a computer
// (@elabora/node transcribe/) or in a browser.

export interface Transcript {
  // What the recording says, as the transcriber writes it: punctuation and capitals (Parakeet,
  // ElevenLabs), numbers mostly in words.
  text: string;
  // Its words and when they are said (seconds from the start of the file): the transcriber's own,
  // coarse (80 ms steps); the word aligner times the text again when the line is written.
  words: { text: string; start: number; end: number; score?: number }[];
  transcriber: string;     // the model (parakeet-tdt-0.6b-v3@8f23f0c int8, scribe_v2…)
  duration: number;
  // Who heard it: this computer (free, nothing leaves it) or ElevenLabs (the author's quota).
  service?: TranscriptionService;
  // ElevenLabs: the share of the monthly quota it took (D30).
  percent?: number;
}

export type TranscriptionService = 'local' | 'elevenlabs';
