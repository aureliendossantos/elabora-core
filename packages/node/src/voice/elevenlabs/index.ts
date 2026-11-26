import { createElevenLabs } from '@elabora/core/voice/elevenlabs/provider';
import type { ElevenLabsHost } from '@elabora/core/voice/elevenlabs/provider';
import { call, generations } from './api.ts';
import { maskKey, missingKey, resolveKey } from './key.ts';
import { credits, keepCharge, keyId, readCharges, rememberVoiceRate, voiceRate } from './costs.ts';

// ElevenLabs voices on this computer (docs/decisions.md D29): the core's provider (@elabora/core
// voice/elevenlabs), given this computer's way to the service. The key is the one this computer
// holds (key.ts: the app's, the environment's or the file's), sent with each request; a generation
// asked before is answered from this computer's cache; the author's charges and the voices' rates
// are kept on disk; the month's credits are counted once for the lines, the sounds and the transcriptions.

const host: ElevenLabsHost = {
  key() {
    const found = resolveKey();
    return found ? { id: keyId(found.key), masked: maskKey(found.key), source: found.source } : null;
  },
  missing: missingKey,
  call,
  cache: generations,
  charges: readCharges,
  recordCharge: keepCharge,
  voiceRate,
  rememberVoiceRate,
  quota: credits
};

const elevenLabs = createElevenLabs(host);

export const elevenLabsProvider = elevenLabs.provider;
export const { searchVoices, lookupVoice, quota, account, estimateCredits, lineShare, synthesize, synthesizeDialogue } = elevenLabs;
export { PROVIDER, DEFAULT_MODEL, SAMPLE_RATE, settingsOf, textFor, wordsFromAlignment, speechBounds, splitDialogue } from '@elabora/core/voice/elevenlabs/provider';
export type { ElevenSettings } from '@elabora/core/voice/elevenlabs/provider';
