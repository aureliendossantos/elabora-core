import { withoutDirections } from '@elabora/core/narration/directions';
import type { SynthesisRequest, SynthesisResult, VoiceInfo, VoiceProvider } from './provider.ts';

// A voice provider for tests: a tone whose length follows the text (60 ms a character), with 0.3 s
// of silence at both ends, so that commands that make narration run without a model in seconds.
// Registered only when ELABORA_VOICE_TONES=1 (voice/index.ts). Never a real voice.
// ELABORA_VOICE_TONE_SECONDS=<n>: each tone takes n seconds to say, its progress told every tenth of a
// second and stopped by its signal, as a real voice is (the app's tests of progress and of « Arrêter »).

const VOICES: readonly (Omit<VoiceInfo, 'provider' | 'licence' | 'source' | 'credit'> & { hz: number })[] = [
  { id: 'tone-a', name: 'Tone A', language: 'fr', gender: 'female', description: { fr: 'tonalité de test, 440 Hz', en: 'test tone, 440 Hz' }, hz: 440 },
  { id: 'tone-b', name: 'Tone B', language: 'fr', gender: 'male', description: { fr: 'tonalité de test, 220 Hz', en: 'test tone, 220 Hz' }, hz: 220 },
  { id: 'tone-c', name: 'Tone C', language: 'en', gender: 'female', description: { fr: 'tonalité de test, 330 Hz', en: 'test tone, 330 Hz' }, hz: 330 }
];

const RATE = 24000;
const primary = (language: string) => language.toLowerCase().split('-')[0];

// How long a tone takes to say, in ms (0: at once).
function sayingTime(): number {
  const seconds = Number(process.env.ELABORA_VOICE_TONE_SECONDS);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

async function taking(ms: number, onProgress: ((fraction: number) => void) | undefined, signal: AbortSignal | undefined): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < ms) {
    signal?.throwIfAborted();
    onProgress?.(Math.min(1, (performance.now() - start) / ms));
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, ms)));
  }
  signal?.throwIfAborted();
}

export const toneProvider: VoiceProvider = {
  id: 'tone',
  name: 'Test tones',
  voices(language) {
    return VOICES.filter((voice) => !language || voice.language === primary(language)).map(({ hz: _hz, ...voice }) => ({
      ...voice, provider: 'tone', licence: 'CC0-1.0', source: 'generated test tone', credit: { fr: 'Tonalité de test', en: 'Test tone' }
    }));
  },
  status(language) {
    return VOICES.some((voice) => voice.language === primary(language)) ? { installed: true, size: 0 } : null;
  },
  async install() {},
  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    const voice = VOICES.find((v) => v.id === request.voice && v.language === primary(request.language));
    if (!voice) throw new Error(`No test tone "${request.voice}" in ${request.language}.`);
    await taking(sayingTime(), request.onProgress, request.signal);
    const silence = Math.round(0.3 * RATE);
    const sound = Math.round(Math.max(0.3, 0.06 * withoutDirections(request.text).length) * RATE);
    const samples = new Float32Array(silence * 2 + sound);
    for (let i = 0; i < sound; i++) samples[silence + i] = 0.3 * Math.sin((2 * Math.PI * voice.hz * i) / RATE);
    request.onProgress?.(1);
    return { samples, sampleRate: RATE, model: 'tone', credit: request.language.startsWith('fr') ? 'Tonalité de test' : 'Test tone', retries: 0, settings: {} };
  },
  async dispose() {}
};
