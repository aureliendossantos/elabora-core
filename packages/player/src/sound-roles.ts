// The interface sounds' roles (docs/decisions.md D67), without the DOM: the core reads them too.
// The one list: the type of course-data.ts is made from it.

export const INTERFACE_ROLES = ['select', 'good', 'ok', 'bad', 'back', 'open', 'close', 'end'] as const;
export type InterfaceRole = (typeof INTERFACE_ROLES)[number];
// The roles the player package has a file for (packages/player/src/interface-sounds/<role>.m4a, sources.json).
export const PLAYER_INTERFACE_SOUNDS: readonly InterfaceRole[] = ['select', 'good', 'ok', 'bad', 'back', 'open', 'close', 'end'];
