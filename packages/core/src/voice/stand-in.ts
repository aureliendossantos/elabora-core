import { withoutDirections } from '../narration/directions.ts';
import type { SynthesisRequest, SynthesisResult, VoiceProvider } from './provider.ts';

const RATE = 24000;
const primary = (language: string) => language.toLowerCase().split('-')[0];

async function taking(ms: number, onProgress: ((fraction: number) => void) | undefined, signal: AbortSignal | undefined): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    signal?.throwIfAborted();
    onProgress?.(Math.min(1, (Date.now() - start) / ms));
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, ms)));
  }
  signal?.throwIfAborted();
}

// A stand-in for a local provider, for the routine checks of what the author sees (the app's try:
// scripts, the conformance suite), which need a voice that speaks, not Pocket TTS's model: the
// provider's own id, voices, credits and model, said installed, each line a tone of its voice (its
// pitch from the voice's id, its length from the text: 60 ms a character, 0.3 s of silence at both
// ends) after ms (so that the busy states show), progress told and stopped by its signal. The same
// text and voice always give the same audio. Never a course's voice. The desktop puts it in place
// with ELABORA_VOICE_FAKE=1, a browser's session when its host asks (voiceStandIn).
export function standIn(provider: VoiceProvider, ms = 500): VoiceProvider {
  const hz = (voice: string) => 180 + ([...voice].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 997, 7) % 260);
  return {
    id: provider.id,
    name: provider.name,
    voices: (language) => provider.voices(language),
    status(language) {
      const real = provider.status(language);
      return real && { installed: true, supported: true, size: 0, onDisk: 0, download: real.download ?? real.size, installing: null, inUse: false };
    },
    async install() {},
    model: provider.model ? (language) => provider.model!(language) : undefined,
    uninstall: provider.uninstall ? async () => ({ freed: 0 }) : undefined,
    hold: provider.hold ? async () => () => {} : undefined,
    async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
      const voice = provider.voices(request.language).find((v) => v.id === request.voice);
      if (!voice) throw new Error(`${provider.name} has no voice "${request.voice}" in ${request.language}.`);
      await taking(ms, request.onProgress, request.signal);
      const silence = Math.round(0.3 * RATE);
      const sound = Math.round(Math.max(0.3, 0.06 * withoutDirections(request.text).length) * RATE);
      const samples = new Float32Array(silence * 2 + sound);
      // A tone whose loudness rises and falls by word, so that a wave drawn from it has bars of
      // different heights, as a voice's.
      const pitch = hz(voice.id);
      for (let i = 0; i < sound; i++) samples[silence + i] = (0.15 + 0.15 * Math.abs(Math.sin((Math.PI * i) / (0.35 * RATE)))) * Math.sin((2 * Math.PI * pitch * i) / RATE);
      request.onProgress?.(1);
      const language = primary(request.language);
      return { samples, sampleRate: RATE, model: `${provider.id} stand-in`, credit: voice.credit[language] ?? voice.credit.en ?? Object.values(voice.credit)[0] ?? '', retries: 0, settings: {} };
    },
    async dispose() {}
  };
}
