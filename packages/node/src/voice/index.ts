import { registerVoiceProvider } from './provider.ts';
import { pocketProvider } from './pocket/index.ts';
import { standIn, toneProvider } from './tone.ts';
import { elevenLabsProvider } from './elevenlabs/index.ts';

// The voice providers Elabora knows: Kyutai's Pocket TTS, local and free (docs/decisions.md D25), and
// ElevenLabs with the author's own key (D29).
// ELABORA_VOICE_TONES=1 adds test tones (tests and fixtures, never a course's real voice); with
// ELABORA_VOICE_TONE_SECONDS a tone takes that long to say, for interfaces that show progress.

// ELABORA_VOICE_FAKE=1 puts a stand-in in Pocket TTS's place: its voices, said with test tones
// (tone.ts, standIn), for the app's routine checks; never for a course.
registerVoiceProvider(process.env.ELABORA_VOICE_FAKE === '1' ? standIn(pocketProvider) : pocketProvider);
registerVoiceProvider(elevenLabsProvider);
if (process.env.ELABORA_VOICE_TONES === '1') registerVoiceProvider(toneProvider);

export { listVoices, findVoice, resolveVoice, speaks, voiceProvider, voiceProviders, disposeVoiceProviders, registerVoiceProvider, localVoices, uninstallVoices, VoiceError } from './provider.ts';
export type { VoiceInfo, VoiceProvider, VoiceStatus, LocalVoicesView, SynthesisRequest, SynthesisResult, InstallProgress, VoiceQuery, VoiceSearchResult, VoiceAccount, VoiceEstimate, DialogueRequest, DialogueResult } from './provider.ts';
export { setSessionKey, resolveKey, writeKeyFile, removeKeyFile, keyFile, maskKey, KEY_ENV } from './elevenlabs/key.ts';
export { generateNarration, estimateNarration, setSpeakerVoice, voiceTakes, voiceSample, folderWriter, takeDialogue } from './generate.ts';
export type { GenerateOptions, GenerateResult, LineResult, TakeInfo, VoiceProgress, VoiceWriter } from './generate.ts';
