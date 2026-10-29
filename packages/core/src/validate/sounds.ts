import type { CourseCheckContext } from './context.ts';
import { courseHasMusic, soundAssets, soundLength, soundSidecar, soundUses } from '../sounds/sounds.ts';
import type { SoundUse } from '../sounds/sounds.ts';
import { classifyLicence } from '../sounds/licences.ts';
import { reportSchemaErrors } from './structure.ts';
import { findItem, playerConfig } from '../player/config.ts';

const REFUSALS = {
  'non-commercial': 'a non-commercial licence (NC): a course is a work its author may sell, and NC forbids it',
  'no-derivatives': 'a no-derivatives licence (ND): a sound cut, faded or mixed is a derivative',
  unknown: 'a licence Elabora does not know'
} as const;

// The course's sounds (docs/decisions.md D67): the sounds it names are in assets/sounds/, each with
// its sidecar and a licence a course may ship (CC0, public domain, CC BY, CC BY-SA, the author's own,
// generated), and the credit a licence asks for shows.
export function checkSounds(ctx: CourseCheckContext): void {
  const { project, reporter, course } = ctx;
  const assets = soundAssets(project);
  const checked = new Set<string>();
  const credited: string[] = [];
  for (const use of soundUses(project)) {
    const asset = assets.get(use.id);
    if (!asset) {
      reporter.emit('E_SOUND_MISSING', { file: use.file, path: use.path, target: use.id, message: `${use.kind === 'interface' ? `The interface sound "${use.path.split('/').pop()}"` : use.kind === 'background' ? 'A track of music or ambience' : use.kind === 'line' ? 'A sound line' : 'A play-sound action'} names the sound "${use.id}", which is not in assets/sounds/.` });
      continue;
    }
    if (checked.has(use.id)) continue;
    checked.add(use.id);
    const sidecar = soundSidecar(project, asset);
    if (!sidecar) {
      reporter.emit('E_SOUND_LICENSE', { file: asset.sidecar, target: use.id, message: `The sound "${use.id}" has no readable sidecar ${asset.sidecar}: where it comes from and its licence are unknown, so it cannot ship.` });
      continue;
    }
    reportSchemaErrors(ctx, 'sound', sidecar, asset.sidecar);
    const licence = classifyLicence(sidecar.license);
    if (!licence.ok) reporter.emit('E_SOUND_LICENSE', { file: asset.sidecar, path: '/license', target: use.id, message: `The sound "${use.id}" is under ${REFUSALS[licence.refusal]}${licence.name ? ` (« ${licence.name} »)` : ''}.` });
    else if (licence.credit) credited.push(use.id);
  }
  checkParts(ctx, assets);
  // Music and ambiences: ranges of the course's screens, one track at a time, and a way to stop them.
  const order = ctx.order.map(({ id }) => id);
  const taken = new Map<string, number>();
  (Array.isArray(course.sounds?.background) ? course.sounds.background : []).forEach((track, index) => {
    const path = `/sounds/background/${index}`;
    const from = order.indexOf(track.from);
    const to = order.indexOf(track.to ?? track.from);
    if (from < 0 || to < 0) { reporter.emit('E_SOUND_BACKGROUND', { file: 'course.json', path: from < 0 ? `${path}/from` : `${path}/to`, target: track.sound, message: `The track "${track.sound}" plays from "${track.from}"${track.to ? ` to "${track.to}"` : ''}: ${from < 0 ? track.from : track.to} is not a screen of the course.` }); return; }
    if (to < from) { reporter.emit('E_SOUND_BACKGROUND', { file: 'course.json', path: `${path}/to`, target: track.sound, message: `The track "${track.sound}" runs backwards: "${track.to}" comes before "${track.from}" in the course.` }); return; }
    for (let i = from; i <= to; i++) {
      const other = taken.get(order[i]);
      if (other !== undefined) { reporter.emit('E_SOUND_BACKGROUND', { file: 'course.json', path, target: track.sound, message: `The track "${track.sound}" and track ${other + 1} both play on "${order[i]}": one track at a time.` }); return; }
    }
    for (let i = from; i <= to; i++) taken.set(order[i], index);
  });
  const display = findItem(playerConfig(course), 'display');
  if (courseHasMusic(project) && !display?.item.enabled) reporter.emit('W_SOUND_MUSIC_SWITCH_HIDDEN', { file: 'course.json', path: '/player', key: 'sounds/music', message: 'The course plays music or ambiences that start by themselves, and the player hides « Affichage », where learners switch them off (WCAG 2.2 1.4.2: audio that plays by itself for more than 3 seconds can be stopped).' });
  const credits = findItem(playerConfig(course), 'credits');
  if (credited.length && !credits?.item.enabled) reporter.emit('W_SOUND_CREDITS_HIDDEN', { file: 'course.json', path: '/player', key: `sounds/credits@${credited.join(',')}`, message: `The course plays ${credited.length === 1 ? `a sound whose licence asks` : `${credited.length} sounds whose licences ask`} to credit its author (${credited.join(', ')}), and the player hides « IA et crédits », where the credits are.` });
}

// What a play-sound or a track asks of its sound (schemas 0.1.7): a part (start, end) inside the
// file, after its start; a duck, which an ambience never does (it plays under the voices).
function checkParts(ctx: CourseCheckContext, assets: ReturnType<typeof soundAssets>): void {
  const { project, reporter } = ctx;
  const documents = new Map<string, unknown>([['course.json', project.course]]);
  for (const [id, entry] of project.screens) documents.set(entry.file ?? `screens/${id}.json`, entry.data);
  const seconds = (value: number) => `${Math.round(value * 100) / 100} s`;
  for (const use of soundUses(project)) {
    if (use.kind !== 'action' && use.kind !== 'background') continue;
    const at = use.path.replace(/\/sound$/, '');
    const record = recordAt(documents.get(use.file), at);
    if (!record || (use.kind === 'action' && record.type !== 'play-sound')) continue;
    const start = typeof record.start === 'number' ? record.start : undefined;
    const end = typeof record.end === 'number' ? record.end : undefined;
    const asset = assets.get(use.id);
    const length = asset ? soundLength(project, asset) : null;
    const part = (field: 'start' | 'end', problem: string) => reporter.emit('E_SOUND_PART', { file: use.file, path: `${at}/${field}`, target: use.id, message: `${describe(use)} plays "${use.id}" ${problem}.` });
    if (start !== undefined && end !== undefined && end <= start) part('end', `from ${seconds(start)} to ${seconds(end)}: nothing lies between`);
    else if (length !== null && start !== undefined && start >= length) part('start', `from ${seconds(start)}, and it lasts ${seconds(length)}`);
    else if (length !== null && end !== undefined && end > length + 0.05) part('end', `up to ${seconds(end)}, and it lasts ${seconds(length)}`);
    if (use.kind === 'action' && record.loop === true && typeof record.duck === 'number') reporter.emit('W_SOUND_DUCK_LOOP', { file: use.file, path: `${at}/duck`, target: use.id, message: `An ambience of "${use.id}" asks to lower the voices (duck ${record.duck} dB): it plays under them for the whole screen, so it never does.` });
  }
}
const describe = (use: SoundUse) => (use.kind === 'background' ? 'A track of music or ambience' : 'A play-sound action');
// The object a JSON pointer names in a document.
function recordAt(document: unknown, pointer: string): Record<string, unknown> | null {
  let value = document;
  for (const part of pointer.split('/').slice(1)) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    value = Array.isArray(value) ? value[Number(key)] : value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
