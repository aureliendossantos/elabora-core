// The desktop's voice providers (docs/decisions.md D25), in one registry for the process: Pocket TTS
// in a worker thread (voice/pocket/), ElevenLabs with the author's key (voice/elevenlabs/, D29), the
// tones of the tests. What a provider is, and the registry, are the core's (@elabora/core/voice/provider).

import { VoiceRegistry } from '@elabora/core/voice/provider';
import type { VoiceProvider } from '@elabora/core/voice/provider';
import type { VoiceInfo, LocalVoicesView } from './types.ts';
export { VoiceError, VoiceRegistry, speaks } from '@elabora/core/voice/provider';
export type { SynthesisRequest, SynthesisResult, DialogueRequest, DialogueResult, VoiceProvider } from '@elabora/core/voice/provider';
export type { VoiceGender, VoiceInfo, VoiceStatus, InstallProgress, VoiceQuery, VoiceSearchResult, VoiceAccount, VoiceEstimate, LocalVoicesView } from './types.ts';
import { VoiceError } from '@elabora/core/voice/provider';

export const voiceRegistry = new VoiceRegistry();

export function registerVoiceProvider(provider: VoiceProvider): void {
  voiceRegistry.register(provider);
}

export const voiceProviders = (): VoiceProvider[] => voiceRegistry.list();
export const voiceProvider = (id: string): VoiceProvider => voiceRegistry.provider(id);
export const listVoices = (language?: string): VoiceInfo[] => voiceRegistry.voices(language);
export const findVoice = (id: string, provider?: string): VoiceInfo | null => voiceRegistry.find(id, provider);
export const resolveVoice = (id: string, provider?: string, signal?: AbortSignal): Promise<VoiceInfo | null> => voiceRegistry.resolve(id, provider, signal);

// The local voices by language, with their model: on this computer (its size on disk) or not (its
// download's), downloading now in any process, in use. Providers whose model can be removed only.
export function localVoices(language?: string): LocalVoicesView[] {
  const views: LocalVoicesView[] = [];
  for (const provider of voiceProviders().filter((p) => !p.paid && p.uninstall && p.model)) {
    const voices = provider.voices(language);
    for (const lang of [...new Set(voices.map((voice) => voice.language))]) {
      const status = provider.status(lang);
      const model = provider.model!(lang);
      if (!status || !model) continue;
      views.push({
        ...(status.supported !== undefined ? { supported: status.supported } : {}),
        ...(status.update ? { update: status.update, installedVersion: status.installedVersion, desiredVersion: status.desiredVersion } : {}),
        language: lang, provider: provider.id, model: model.model,
        voices: voices.filter((voice) => voice.language === lang).map((voice) => ({ id: voice.id, name: voice.name, ...(voice.gender ? { gender: voice.gender } : {}) })),
        installed: status.installed, size: status.installed ? status.onDisk ?? 0 : status.size, download: status.download ?? status.size,
        installing: status.installing ?? null, inUse: !!status.inUse
      });
    }
  }
  return views;
}

// Removes the model of a language's local voices from this computer (every provider's that has one).
export async function uninstallVoices(language: string, { partial }: { partial?: boolean } = {}): Promise<{ language: string; freed: number; providers: string[] }> {
  const providers = voiceProviders().filter((provider) => !provider.paid && provider.uninstall && provider.status(language));
  if (!providers.length) throw new VoiceError('E_VOICE_LANGUAGE', `No local voice speaks ${language}.`);
  let freed = 0;
  for (const provider of providers) freed += (await provider.uninstall!(language, { partial })).freed;
  return { language, freed, providers: providers.map((provider) => provider.id) };
}

export async function disposeVoiceProviders(): Promise<void> {
  await Promise.all(voiceProviders().map((provider) => provider.dispose()));
}
