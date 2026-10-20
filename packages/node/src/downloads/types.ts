// The types of the optional downloads that leave the process (the app's window): no import (D38).

export interface DownloadView {
  installedVersion?: string | null;
  desiredVersion?: string;
  update?: 'absent' | 'current' | 'available' | 'required';

  supported?: boolean;           // false: listed for explanation/removal, never offered for install
  id: string;                    // <kind>-<language> (voices-fr, aligner-en), or <kind> without a language
  kind: string;                  // voices, aligner, transcriber
  title: string;                 // the kind, in English: « Local voices »
  serves: string;                // what it is for
  without: string;               // what happens without it
  language: string | null;       // primary language subtag, or none
  model: string;                 // what it is, as a sidecar records it
  contents?: { id: string; name: string; gender?: 'female' | 'male' }[]; // what it holds (a language's voices)
  installed: boolean;
  size: number;                  // bytes on disk when installed, else to download
  download: number;              // the download's size
  installing: { received: number; total: number } | null; // a download under way, in any process
  inUse: boolean;                // being used now (lines said, words placed): it cannot be removed
}
