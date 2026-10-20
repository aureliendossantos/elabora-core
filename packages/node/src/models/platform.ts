// Product support, independent of whether an older native binding happens to load. Keep Intel
// Macs usable for editing and media, without maintaining a second generation of local AI engines.
export function localAiSupported(platform: string = process.platform, arch: string = process.arch): boolean {
  return !(platform === 'darwin' && arch === 'x64');
}

export function requireLocalAi(): void {
  if (localAiSupported()) return;
  const error = new Error('Local AI is unavailable on Intel Macs. Existing audio, recordings and online services remain usable.');
  Object.assign(error, { code: 'E_LOCAL_AI_PLATFORM' });
  throw error;
}
