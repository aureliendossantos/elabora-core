import type { CourseCheckContext } from './context.ts';
import { INTERFACE_ROLES, interfaceSounds, soundAssets } from '../sounds/sounds.ts';

// The course's sounds (docs/decisions.md D67): the sounds it names are in assets/sounds/.
export function checkSounds(ctx: CourseCheckContext): void {
  const { project, reporter } = ctx;
  const assets = soundAssets(project);
  // Whether they sound does not matter here: only the sounds they name.
  const settings = interfaceSounds(project, { hasSound: () => false });
  for (const role of INTERFACE_ROLES) {
    const source = settings.roles[role];
    if (source?.kind === 'sound' && !assets.has(source.id)) reporter.emit('E_SOUND_MISSING', { file: 'course.json', path: `/sounds/interface/replace/${role}`, target: source.id, message: `The interface sound "${role}" names the sound "${source.id}", which is not in assets/sounds/.` });
  }
}
