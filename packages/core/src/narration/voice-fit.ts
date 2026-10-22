// How ready a voice service's voice is for the model that says a speaker's lines, in their language
// (ElevenLabs: VoiceInfo.models, read from each voice's verified languages and training by model).
// A professional clone is trained once per model: on a model it was not trained for, or whose
// training failed, the model still speaks with it, less like it and less expressive. A language the
// service checked with that model is said well; in another, the voice keeps an accent of its own.
//   ready            checked in this language with this model
//   trained          trained for the model, no language checked
//   other-languages  checked with this model, in other languages only
//   failed           its training for the model failed
//   untrained        neither trained nor checked for the model (the service's own voices too)
// null: the service says nothing of it (a local voice, a voice the search did not describe).

export type VoiceFit = 'ready' | 'trained' | 'other-languages' | 'failed' | 'untrained';

export const DEFAULT_VOICE_MODEL = 'eleven_v4';

// The model a speaker's voice is said with: its settings', else Eleven v4 for ElevenLabs.
export function voiceModel(voice: { provider?: unknown; settings?: unknown } | null | undefined): string | null {
  if (voice?.provider !== 'elevenlabs') return null;
  const model = voice.settings && typeof voice.settings === 'object' ? (voice.settings as Record<string, unknown>).model : undefined;
  return typeof model === 'string' && model ? model : DEFAULT_VOICE_MODEL;
}

const primary = (language: string): string => language.toLowerCase().split('-')[0]!;

export function voiceFit(voice: { models?: Readonly<Record<string, readonly string[] | 'failed'>> }, model: string, language: string): VoiceFit | null {
  const models = voice.models;
  if (!models || !Object.keys(models).length) return null;
  const languages = models[model];
  if (languages === undefined) return 'untrained';
  if (languages === 'failed') return 'failed';
  if (!languages.length) return 'trained';
  return languages.some((checked) => primary(checked) === primary(language)) ? 'ready' : 'other-languages';
}

// « Eleven v4 », « Eleven v4 Turbo », « Eleven Multilingual v2 »: a model's name as the service says it.
export function modelName(model: string): string {
  const named: Record<string, string> = { eleven_multilingual_v2: 'Eleven Multilingual v2', eleven_flash_v2_5: 'Eleven Flash v2.5', eleven_turbo_v2_5: 'Eleven Turbo v2.5', eleven_flash_v2: 'Eleven Flash v2', eleven_turbo_v2: 'Eleven Turbo v2' };
  if (named[model]) return named[model]!;
  const version = /^eleven_v(\d+(?:_\d+)?)(_[a-z]+)?$/.exec(model);
  if (!version) return model;
  const suffix = version[2] ? ` ${version[2].slice(1)[0]!.toUpperCase()}${version[2].slice(2)}` : '';
  return `Eleven v${version[1]!.replace('_', '.')}${suffix}`;
}
