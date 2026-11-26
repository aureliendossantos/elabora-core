// The AAC encoder in wasm, for a browser without its own (Chromium and Firefox under Linux), given by
// an address only (D107, D135): the media Worker never bundles it. The module at that address is
// @elabora/engine/aac-encoder's aacEncoderModule: @mediabunny/aac-encoder with its 'mediabunny' taken
// from globalThis.ElaboraMediabunny, this Worker's own copy, so that it registers into the Mediabunny
// that encodes. That interface is what lets a rebuilt encoder take its place (the LGPL, D135). Loaded once, when a
// sound must be encoded and the browser has no AAC encoder.

import { CustomAudioEncoder, EncodedPacket, Logging, canEncodeAudio, registerEncoder } from 'mediabunny';

let loading: Promise<void> | null = null;

export function provideAac(url: string | undefined): () => Promise<boolean> {
  return async () => {
    if (await canEncodeAudio('aac')) return true;
    if (!url) return false;
    loading ??= (async () => {
      (globalThis as { ElaboraMediabunny?: unknown }).ElaboraMediabunny = { CustomAudioEncoder, EncodedPacket, Logging, registerEncoder };
      const module = await import(/* @vite-ignore */ url) as { registerAacEncoder(): void };
      module.registerAacEncoder();
    })().catch((error: unknown) => { loading = null; throw error; });
    await loading;
    return canEncodeAudio('aac');
  };
}
