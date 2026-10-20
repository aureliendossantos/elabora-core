// The types of the voice tools that leave the process (the engine's protocol, the app): no import,
// so that the app's window can name them without Node's (docs/decisions.md D25).

export type VoiceGender = 'female' | 'male';

export interface VoiceInfo {
  provider: string;
  id: string;                    // the provider's id of the voice, as course.json names it
  name: string;                  // shown to authors
  language: string;              // the language it speaks (fr, en)
  gender: VoiceGender | null;
  description: Readonly<Record<string, string>>; // its register and pace, for choosing it, by language of the interface (fr, en)
  licence: string;               // of the recording the voice was made from (CC0-1.0, CC-BY-4.0)
  source: string;                // where that recording comes from
  credit: Readonly<Record<string, string>>; // the line for the module credits, by language of the credits
  // A voice service's voice (ElevenLabs, D29): it speaks every language of its model, its own
  // language being its accent; whose it is (the author's account, or the service's library); what
  // describes it; a recording to hear it without spending; its price over the model's (2: twice).
  multilingual?: boolean;
  owner?: 'account' | 'library' | 'premade';
  labels?: Readonly<{ accent?: string; age?: string; useCase?: string; descriptive?: string; locale?: string }>;
  preview?: string;
  rate?: number;
  noticeDays?: number | null;     // a library voice its owner removes stays usable this long
}

// Searching a voice service's voices (ElevenLabs: its library of thousands, and the account's own).
export interface VoiceQuery {
  provider: string;
  text?: string;                 // words of its name or description
  language?: string;
  gender?: VoiceGender | 'neutral';
  age?: 'young' | 'middle_aged' | 'old';
  accent?: string;
  useCase?: string;              // narrative_story, conversational, informative_educational, characters_animation…
  scope?: 'all' | 'account' | 'library';
  sort?: 'used' | 'trending' | 'recent';  // the library's order: most used in a year (default), trending, newest
  page?: number;
  pageSize?: number;
}

export interface VoiceSearchResult {
  voices: VoiceInfo[];
  total: number;
  more: boolean;
}

// What the account of a voice service has left (ElevenLabs: its subscription's credits this month).
// The quota is in the service's own units (ElevenLabs: credits); authors are told shares of it
// (@elabora/core ai/quota, D30): usedPercent.
export interface VoiceAccount {
  provider: string;
  key: string;                   // masked: sk_…1a2b
  keySource: 'app' | 'environment' | 'file' | 'given';
  plan: string;
  used: number;
  limit: number;
  remaining: number;
  usedPercent: number;           // of the month's quota, as people say it (quotaPercent)
  resetsAt: string | null;       // ISO date
  commercial: boolean;           // the plan allows commercial use of what it makes
  library: boolean;              // the plan may use the service's library of voices (ElevenLabs: not the free plan)
  linePercent: number | null;    // what a typical line (70 characters, the default model) costs of the quota
  permissions: Readonly<Record<string, boolean | null>>; // what the key may do (null: not checked)
}

// What generating some lines would cost, before anything is spent: credits are what the service
// is expected to charge (its rate as measured on this computer, D29), ceiling what it could charge
// at most (its list price); authors and agents are told the share of the monthly quota (D30).
export interface VoiceEstimate {
  screen: string;
  language: string;
  lines: { line: string; provider: string; voice: string; characters: number; credits: number; ceiling: number; reuse?: number; dialogue?: string }[];
  characters: number;            // sent to paid services
  credits: number;               // about, in the service's credits
  ceiling: number;               // at most
  free: number;                  // lines a local voice makes
  reused: number;                // lines given back an earlier take of the same text, voice and delivery, at no cost
  // The month's quota of the paid service, when something is to pay (null: nothing to pay, or the
  // quota could not be read); the share of it the credits are, in percent as people say it; whether
  // spending them asks the author first (from 1 % of the quota, or when the quota is unknown).
  quota: { plan: string; limit: number; used: number; resetsAt: string | null } | null;
  percent: number | null;
  needsApproval: boolean;
}

export interface VoiceStatus {
  installedVersion?: string | null;
  desiredVersion?: string;
  update?: 'absent' | 'current' | 'available' | 'required';

  supported?: boolean;           // false: this platform cannot generate with this provider
  installed: boolean;
  size: number;                  // bytes to download when not installed (0 when installed)
  // A model downloaded on this computer (local voices): what it takes on disk when installed, the
  // download under way in any process (the app, a command, an MCP server), and whether lines are being
  // said with it (it cannot be removed meanwhile).
  onDisk?: number;
  download?: number;             // its download's size, installed or not
  installing?: { received: number; total: number } | null;
  inUse?: boolean;
}

// A language's local voices and their model (elabora voice models, Elabora settings in the app).
export interface LocalVoicesView {
  installedVersion?: string | null;
  desiredVersion?: string;
  update?: 'absent' | 'current' | 'available' | 'required';

  supported?: boolean;
  language: string;              // primary language subtag
  provider: string;
  model: string;                 // what a sidecar records as its model
  voices: { id: string; name: string; gender?: VoiceGender }[];
  installed: boolean;
  size: number;                  // bytes on disk when installed, else to download
  download: number;              // the download's size
  installing: { received: number; total: number } | null;
  inUse: boolean;                // lines are being said with it: it cannot be removed now
}

export interface InstallProgress {
  received: number;
  total: number;
  file?: string;
}

export interface VoiceProgress {
  phase: 'install' | 'line' | 'align';
  line?: string;
  index?: number;                // line being made, from 0
  count?: number;
  fraction: number;              // of install or line; align is indeterminate
  received?: number;             // install: bytes
  total?: number;
}

export interface LineResult {
  line: string;
  status: 'generated' | 'selected' | 'skipped';
  dialogue?: string;             // made in one exchange with the other lines of this id (D29)
  cached?: boolean;              // a request already paid for, given back from this computer's cache
  reason?: string;
  take?: number;
  audio?: string;
  duration?: number;
  provider?: string;
  voice?: string;
  retries?: number;
  seconds?: number;              // time the voice took
  alignmentError?: string;       // audio kept, but its words could not be timed
}

export interface GenerateResult {
  screen: string;
  language: string;
  voiceSet?: { speaker: string; provider: string; voice: string };
  lines: LineResult[];
  changes: number[];             // journal sequence numbers of the changes made (elabora undo --change)
  credits: string[];
  // Paid services: characters sent, credits expected and spent (as the service charged each request;
  // null when it did not say), and that share of the month's quota in percent.
  spent?: { provider: string; characters: number; estimate: number; credits: number | null; percent: number | null }[];
  cancelled?: boolean;           // stopped before the end: the lines listed were said, the others not
  // Stopped because the service charged more than the share allowed (the approved one, or under
  // 1 % of the quota without approval): the lines listed were said, the others not.
  overBudget?: { allowedPercent: number; spentPercent: number };
}

export interface TakeInfo {
  take: number;
  file: string;                  // absolute path of the take's audio
  provider: string;
  voice: string;
  spokenHash: string;
  settingsHash: string;
  seed: number;
  model: string;
  credit: string;
  createdAt: string;
  retries: number;
  dialogue?: string;             // the exchange it was cut from (D29)
  current: boolean;              // the line's audio is this take
  usable: boolean;               // made from the line's current text, voice and settings
}
