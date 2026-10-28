import { classifyLicence } from '@elabora/core/sounds/licences';
import { ELABORA_VERSION } from '../bundles.ts';

// Sounds found through Openverse (docs/decisions.md D67): its index of Freesound and Wikimedia Commons,
// searched anonymously (each computer has its own quota: 20 requests a minute, 200 a day), no key,
// no relay. Only CC0, the public-domain mark and CC BY are asked for and kept: Openverse's « commercial
// use » filter lets ND and SA through. ELABORA_OPENVERSE_URL replaces https://api.openverse.org.

export interface OpenverseSound {
  id: string; // openverse:<uuid>
  title: string;
  author: string;
  license: string; // CC0-1.0, PDM-1.0, CC-BY-4.0…
  licenseUrl: string | null;
  url: string; // the sound's page at its source (Freesound, Commons)
  file: string; // what Openverse links to: an MP3 or Ogg preview for Freesound, the original for Commons
  format: string | null;
  duration: number | null; // seconds
  source: string; // freesound, wikimedia_audio…
  attribution: string | null;
}

export class OpenverseError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) { super(message); this.status = status; }
}

const ALLOWED = ['cc0', 'pdm', 'by'];
const base = () => (process.env.ELABORA_OPENVERSE_URL || 'https://api.openverse.org').replace(/\/$/, '');
const AGENT = `Elabora/${ELABORA_VERSION} (+https://elabora.studio; sound search for course authors)`;

interface Result { id: string; title?: string; creator?: string; license?: string; license_version?: string; license_url?: string; foreign_landing_url?: string; url?: string; filetype?: string; duration?: number | null; source?: string; attribution?: string }

const licenceId = (license: string, version: string | undefined): string => (license === 'cc0' ? 'CC0-1.0' : license === 'pdm' ? 'PDM-1.0' : `CC-${license.toUpperCase()}${version ? `-${version}` : ''}`);

function toSound(result: Result): OpenverseSound | null {
  if (!result.id || !result.url || !result.license || !ALLOWED.includes(result.license)) return null;
  const license = licenceId(result.license, result.license_version);
  const licence = classifyLicence(license);
  if (!licence.ok || licence.kind === 'by-sa') return null;
  return {
    id: `openverse:${result.id}`, title: result.title || result.id, author: result.creator || '', license, licenseUrl: result.license_url ?? null,
    url: result.foreign_landing_url || result.url, file: result.url, format: result.filetype ?? null,
    duration: typeof result.duration === 'number' ? Math.round(result.duration / 100) / 10 : null, source: result.source ?? 'openverse', attribution: result.attribution ?? null
  };
}

// Openverse answers a request it has not cached slowly: 12 s for a sound and 52 s for a search on
// 28 October, then a tenth of a second for the same ones.
const TIMEOUT = 60_000;

async function get(pathAndQuery: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base()}${pathAndQuery}`, { headers: { 'user-agent': AGENT, accept: 'application/json' }, signal: signal ?? AbortSignal.timeout(TIMEOUT) });
  } catch (error) {
    throw new OpenverseError(`Openverse did not answer (${error instanceof Error ? error.message : String(error)}): search the library (--source library), or try again later.`);
  }
  if (response.status === 429) throw new OpenverseError('Openverse limits searches without an account to 20 a minute and 200 a day on each computer: wait a little, or search the library (--source library).', 429);
  if (!response.ok) throw new OpenverseError(`Openverse answered ${response.status}: try again later, or search the library (--source library).`, response.status);
  return response.json();
}

export async function searchOpenverse(query: string, { maxDuration, signal }: { maxDuration?: number; signal?: AbortSignal } = {}): Promise<OpenverseSound[]> {
  const params = new URLSearchParams({ q: query, license: ALLOWED.join(','), page_size: '20', mature: 'false' });
  if (maxDuration !== undefined && maxDuration <= 30) params.set('length', maxDuration <= 10 ? 'shortest,short' : 'shortest,short,medium');
  const body = await get(`/v1/audio/?${params}`, signal) as { results?: Result[] };
  return (body.results ?? []).map(toSound).filter((sound): sound is OpenverseSound => !!sound && (maxDuration === undefined || sound.duration === null || sound.duration <= maxDuration));
}

export async function openverseSound(id: string, { signal }: { signal?: AbortSignal } = {}): Promise<OpenverseSound> {
  const uuid = id.replace(/^openverse:/, '');
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) throw new OpenverseError(`Not an Openverse id: ${id}`);
  const sound = toSound(await get(`/v1/audio/${uuid}/`, signal) as Result);
  if (!sound) throw new OpenverseError(`Openverse's ${id} is not under CC0, the public-domain mark or CC BY: it cannot ship in a course.`);
  return sound;
}
