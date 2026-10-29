import { loadProjectFromDir } from '@elabora/node/project-reader';
import { courseSounds } from '@elabora/core/sounds/sounds';
import { searchLibrary, SOUND_CATEGORIES } from '@elabora/node/sounds/library';
import { searchOpenverse } from '@elabora/node/sounds/openverse';
import { addSound, courseLanguage } from '@elabora/node/sounds/add';
import { estimateSound, generateSound } from '@elabora/node/sounds/generate';
import type { SoundEstimate } from '@elabora/node/sounds/generate';
import { defineTool, editPayload, errorResult, objectSchema, textResult, SLUG } from './tool.ts';

// Sounds (docs/decisions.md D67): finding one (Elabora's library, Openverse), adding it to the course,
// making one with ElevenLabs, listing those of the course.

const failure = (error: unknown) => errorResult({ error: error instanceof Error ? error.message : String(error), ...(error && typeof error === 'object' && 'code' in error ? { code: (error as { code: unknown }).code } : {}) });
const CAPTION = { type: 'string', minLength: 1, maxLength: 200, description: 'Its caption in the course\'s language (« Le téléphone sonne. »), kept as a suggestion in its sidecar: write it where the sound is used when it carries meaning no text gives; leave it out for a decorative sound or when the text around says it.' } as const;

export const searchSoundsTool = defineTool({
  name: 'elabora_sound_search',
  readOnly: true,
  description: 'Sounds to add to the course. source library (default): Elabora\'s library « Sons courants », CC0 or public domain, offline: phones, doors and footsteps, office, notifications, impacts, transitions, nature, crowds and places, stingers, and ambiences that loop (rain, birds, a café). source openverse: Freesound and Wikimedia Commons through Openverse, without an account (CC0, public domain and CC BY only: a CC BY sound is credited in « IA et crédits » by itself); each computer may search 20 times a minute and 200 a day. Search the library first; then Openverse; then make one (elabora_sound_generate). Choose sounds that say something of the scene (the phone that rings, the alarm of a drill), one or two a screen at most, never under an explanation.',
  inputSchema: objectSchema({
    words: { type: 'string', description: 'What to look for, in English or French (« téléphone », « door knock »). Empty: the whole library.' },
    source: { enum: ['library', 'openverse'] },
    category: { enum: SOUND_CATEGORIES },
    kind: { enum: ['effect', 'ambience'] },
    maxDuration: { type: 'number', minimum: 0, description: 'Seconds.' }
  }),
  async handler(args) {
    try {
      if (args.source === 'openverse') return textResult({ source: 'openverse', sounds: await searchOpenverse(args.words ?? '', { ...(args.maxDuration !== undefined ? { maxDuration: args.maxDuration } : {}) }) });
      return textResult({ source: 'library', sounds: searchLibrary(args.words ?? '', { ...(args.category ? { category: args.category } : {}), ...(args.kind ? { kind: args.kind } : {}), ...(args.maxDuration !== undefined ? { maxDuration: args.maxDuration } : {}) }) });
    } catch (error) { return failure(error); }
  }
});

export const listSoundsTool = defineTool({
  name: 'elabora_sound_list',
  readOnly: true,
  description: 'The course\'s sounds (assets/sounds/): each with its title, length, licence (and whether it may ship), the credit it asks for, whether it was generated or loops, and where the course uses it (interface role, play-sound action, sound line, background track).',
  inputSchema: objectSchema({}),
  handler: (_args, { root }) => textResult({ sounds: courseSounds(loadProjectFromDir(root)) })
});

export const addSoundTool = defineTool({
  name: 'elabora_sound_add',
  description: 'Adds a sound to the course: from, a library id (elabora_sound_search), openverse:<id>, or a file on this computer (then license is required: CC0-1.0, CC-BY-4.0…, own for a sound the author made or bought). Copied into assets/sounds/<id> with its sidecar (source, author, licence, changes); trim keeps a part, fade fades its end; a lossy file kept whole is not encoded again. Then use it: a sound line { "id", "sound", "caption"? } in a narration\'s lines (elabora_update_screen) or a dialogue\'s node lines, an action { "type": "play-sound", "sound", "volume"? (up to 2), "loop"?, "fade"?, "fadeOut"?, "start"?, "end"? (a part of the file, seconds), "duck"? (dB the music and ambiences go down under it, never a voice), "caption"? } in an event, a cue of a dialogue\'s line or a dialogue option, or a background track in course.json sounds.background [{ "sound", "from", "to"?, "volume"?, "start"?, "end"? }] (elabora_update_course; enable « Affichage » so learners can switch music off). Undo with elabora_undo.',
  inputSchema: objectSchema({
    from: { type: 'string', minLength: 1 },
    id: SLUG,
    trim: { type: 'object', properties: { start: { type: 'number', minimum: 0 }, end: { type: 'number', exclusiveMinimum: 0 } }, required: ['start', 'end'], additionalProperties: false, description: 'The part kept, in seconds.' },
    fade: { type: 'number', minimum: 0, maximum: 10, description: 'Seconds of fade out at its end.' },
    loop: { type: 'boolean', description: 'Made to loop (an ambience).' },
    caption: CAPTION,
    license: { type: 'string', maxLength: 40 },
    author: { type: 'string', maxLength: 200 },
    title: { type: 'string', maxLength: 200 },
    url: { type: 'string', pattern: '^https://' }
  }, ['from']),
  async handler(args, { root, author }) {
    try {
      const language = courseLanguage(root);
      const result = await addSound(root, { from: args.from, ...(args.id ? { id: args.id } : {}), ...(args.trim ? { trim: args.trim } : {}), ...(args.fade !== undefined ? { fade: args.fade } : {}), ...(args.loop ? { loop: true } : {}), ...(args.caption ? { caption: { [language]: args.caption } } : {}), ...(args.license ? { license: args.license } : {}), ...(args.author ? { author: args.author } : {}), ...(args.title ? { title: args.title } : {}), ...(args.url ? { url: args.url } : {}) }, { author });
      return textResult({ ...editPayload(result), id: result.id, path: result.path, reused: result.reused, license: result.license, duration: result.duration });
    } catch (error) { return failure(error); }
  }
});

export const generateSoundTool = defineTool({
  name: 'elabora_sound_generate',
  description: 'Makes a sound effect with ElevenLabs (the author\'s key) from a description in English (« a desk phone rings twice, close, office room tone »), 0.5 to 30 s (duration; without it the service chooses), loop for an ambience, and adds it to the course like elabora_sound_add (its sidecar says it was generated: « IA et crédits » says so). Its cost is a share of the author\'s monthly quota, never said in credits: a sound of 3 s is about 0.4 % of a Starter plan, 10 s about 1.3 %. Under 1 % it runs; from 1 % the call spends nothing and returns needsApproval with the estimate: tell the author « ~N % of your monthly ElevenLabs quota », ASK them, and only with their agreement call again with approvedPercent: N. estimate: only say the share. The same request is never paid twice. Search the library and Openverse first: a generated sound costs, and every try costs as much as the one kept.',
  inputSchema: objectSchema({
    prompt: { type: 'string', minLength: 1, maxLength: 450 },
    duration: { type: 'number', minimum: 0.5, maximum: 30 },
    loop: { type: 'boolean' },
    influence: { type: 'number', minimum: 0, maximum: 1, description: 'How closely it follows the description (default 0.3).' },
    id: SLUG,
    caption: CAPTION,
    estimate: { type: 'boolean' },
    approvedPercent: { type: 'number', minimum: 0, maximum: 100, description: 'The share of their monthly quota, in percent, the author agreed to spend. Only needed from 1 %; never set it without asking.' }
  }, ['prompt']),
  async handler(args, { root, author }) {
    try {
      if (args.estimate) return textResult(await estimateSound({ ...(args.duration !== undefined ? { duration: args.duration } : {}) }));
      const language = courseLanguage(root);
      const result = await generateSound(root, { prompt: args.prompt, ...(args.duration !== undefined ? { duration: args.duration } : {}), ...(args.loop ? { loop: true } : {}), ...(args.influence !== undefined ? { influence: args.influence } : {}), ...(args.id ? { id: args.id } : {}), ...(args.caption ? { caption: { [language]: args.caption } } : {}), ...(args.approvedPercent !== undefined ? { approvedPercent: args.approvedPercent } : {}) }, { author });
      return textResult({ ok: true, ...editPayload(result), id: result.id, path: result.path, duration: result.duration, percent: result.percent, cached: result.cached });
    } catch (error) {
      const estimate = error && typeof error === 'object' && 'code' in error && error.code === 'E_VOICE_SPEND' ? (error as { estimate?: SoundEstimate }).estimate : undefined;
      if (estimate) return textResult({ ok: false, needsApproval: true, estimate, ask: `Ask the author: this sound uses ~${estimate.percent ?? '?'} % of their monthly ElevenLabs quota. Say it as a share of their quota, never in credits. With their agreement, call again with approvedPercent: ${estimate.percent ?? '<percent>'}.` });
      return failure(error);
    }
  }
});
