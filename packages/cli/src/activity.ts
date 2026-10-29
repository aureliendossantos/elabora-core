import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Author } from '@elabora/core/ops/types';
import { recordActivity } from '@elabora/node/activity';
import type { ActivityEntry, ActivityFamily } from '@elabora/node/activity';

// What each agent operation says while it runs (@elabora/node/activity): its family, from which the
// app makes words (« Claude examine l'écran 2.1… »), and where it works. Every tool and every
// command is named here (test/unit/activity.test.ts): a new one without a family fails the test.
// A command with null is said nowhere: it is the author's (publish, approve) or no work on the
// course (init, mcp).

export const TOOL_ACTIVITY: Readonly<Record<string, ActivityFamily>> = {
  elabora_overview: 'module', elabora_agent_guide: 'learn', elabora_docs: 'docs', elabora_sources: 'sources', elabora_source_read: 'sources',
  elabora_get_plan: 'plan', elabora_plan_diff: 'plan', elabora_get_screen: 'screen', elabora_find_text: 'search',
  elabora_translation_table: 'translations', elabora_translation_status: 'translations',
  elabora_list_components: 'blocks', elabora_get_schema: 'blocks', elabora_get_component: 'blocks', elabora_list_fonts: 'blocks',
  elabora_validate: 'check', elabora_get_object: 'object', elabora_object_map: 'object',
  elabora_list_profiles: 'status', elabora_history: 'status', elabora_projects_list: 'status', elabora_projects_path: 'status', elabora_media_status: 'status', elabora_downloads: 'status', elabora_voice_account: 'status',
  elabora_look: 'look', elabora_preview_screenshot: 'look', elabora_preview_component: 'look', elabora_check_fit: 'fit', elabora_replay_object: 'try-object', elabora_test_object: 'try-object',
  elabora_timeline: 'screen', elabora_dialogue_show: 'screen', elabora_dialogue_play: 'dialogue', elabora_dialogue_paths: 'dialogue',
  elabora_voice_list: 'voices', elabora_voice_takes: 'voices', elabora_voice_search: 'voices', elabora_voice_estimate: 'voices', elabora_voice_set: 'voices',
  elabora_sound_search: 'sounds', elabora_sound_list: 'sounds', elabora_review_list: 'reviews', elabora_review_comments: 'reviews',
  elabora_create_screen: 'write-screen', elabora_update_screen: 'write-screen', elabora_delete_screen: 'write-screen', elabora_move_screen: 'write-screen', elabora_duplicate_screen: 'write-screen',
  elabora_add_block: 'write-screen', elabora_update_block: 'write-screen', elabora_remove_block: 'write-screen', elabora_move_block: 'write-screen', elabora_duplicate_block: 'write-screen',
  elabora_detach_block: 'write-screen', elabora_convert_block: 'write-screen', elabora_set_continuity: 'write-screen', elabora_upsert_layer: 'write-screen', elabora_remove_layer: 'write-screen',
  elabora_upsert_event: 'write-screen', elabora_remove_event: 'write-screen', elabora_set_timing: 'write-screen', elabora_set_dialogue_node: 'write-screen', elabora_remove_dialogue_node: 'write-screen',
  elabora_upsert_variable: 'write-course', elabora_rename_variable: 'write-course', elabora_remove_variable: 'write-course', elabora_replace_text: 'write-course', elabora_update_course: 'write-course',
  elabora_ignore_finding: 'write-course', elabora_rename: 'write-course', elabora_player: 'write-course',
  elabora_translate_text: 'translate',
  elabora_source_add: 'media', elabora_media_import: 'media', elabora_set_captions: 'media', elabora_import_narration: 'media', elabora_sound_add: 'media',
  elabora_narration_line_from_audio: 'listen', elabora_narration_text_from_audio: 'listen', elabora_transcribe: 'listen', elabora_align_narration: 'listen',
  elabora_voice_generate: 'record', elabora_sound_generate: 'record',
  elabora_voice_install: 'download', elabora_download_install: 'download', elabora_download_uninstall: 'download',
  elabora_create_object: 'write-object', elabora_write_object_file: 'write-object',
  elabora_write_plan: 'write-plan', elabora_set_plan_voiceover: 'write-plan',
  elabora_export_plan_document: 'package', elabora_dialogue_export: 'package', elabora_build: 'package', elabora_test_package: 'package',
  elabora_write_design_file: 'design', elabora_upgrade_theme: 'design', elabora_add_font: 'design', elabora_create_component: 'design', elabora_fork_component: 'design',
  elabora_write_component_file: 'design', elabora_migrate_components: 'design', elabora_add_library_component: 'design', elabora_publish_component: 'design', elabora_build_assets: 'design',
  elabora_undo: 'undo'
};

export const COMMAND_ACTIVITY: Readonly<Record<string, ActivityFamily | null>> = {
  init: null, templates: null, validate: 'check', project: 'module', migrate: null, rename: 'write-course', ignore: 'write-course',
  'projects list': 'status', 'projects path': 'status', 'projects create': null, 'projects duplicate': null, 'projects rename': null, 'projects trash': null, export: null, import: null,
  history: 'status', undo: 'undo', mark: null,
  'sources list': 'sources', 'sources add': 'media', 'sources read': 'sources', 'sources refresh': 'sources', 'sources remove': 'media',
  'media import': 'media', 'media optimize': 'media', 'media captions': 'media', 'media status': 'status', 'media cancel': null, 'media worker': null,
  timeline: 'screen', timing: 'write-screen', 'narration import': 'media', 'narration import-files': 'media', 'narration from-plan': 'write-screen', 'narration transcribe': 'listen',
  'narration add-from-audio': 'listen', 'narration retranscribe': 'listen', 'narration keep': 'write-screen', 'narration split': 'write-screen', 'narration align': 'listen',
  'voice list': 'voices', 'voice models': 'status', 'voice install': 'download', 'voice uninstall': 'download', 'voice set': 'voices', 'voice generate': 'record',
  'voice takes': 'voices', 'voice search': 'voices', 'voice estimate': 'voices', 'voice account': 'status', 'voice key': null,
  'sound search': 'sounds', 'sound add': 'media', 'sound list': 'sounds', 'sound generate': 'record',
  'dialogue show': 'screen', 'dialogue play': 'dialogue', 'dialogue paths': 'dialogue', 'dialogue export': 'package',
  'downloads list': 'status', 'downloads install': 'download', 'downloads uninstall': 'download',
  build: 'package', test: 'package', preview: null, look: 'look', screenshot: 'look', fit: 'fit', inspect: 'check', diff: 'status', profiles: 'status',
  'account login': null, 'account handle': null, 'account status': null, 'account logout': null, 'account ai-key': null,
  publish: null, 'publication versions': null, 'publication withdraw': null, 'review create': null, 'review list': 'reviews', 'review link': null, 'review close': null,
  'review open': null, 'review delete': null, 'review comments': 'reviews', 'review reply': null, 'review resolve': null, 'review reopen': null,
  assets: 'design', 'theme upgrade': 'design', player: 'write-course',
  'font list': 'blocks', 'font add': 'design',
  'component list': 'blocks', 'component new': 'design', 'component fork': 'design', 'component preview': 'look', 'component migrate': 'design', 'component add': 'design',
  'component publish': 'design', 'block duplicate': 'write-screen', 'block detach': 'write-screen', 'block continue': 'write-screen', convert: 'write-screen',
  'object new': 'write-object', 'object map': 'object', 'object test': 'try-object', 'object replay': 'try-object',
  'plan status': 'plan', 'plan write': 'write-plan', 'plan text': 'plan', 'plan voiceover': 'write-plan', 'plan diff': 'plan', 'plan revert': 'write-plan', 'plan note': 'write-plan',
  'plan version': null, 'plan approve': null, 'plan export': 'package',
  'translate export': 'translations', 'translate status': 'translations', 'translate reuse': 'translate', 'translate build': 'package', 'translate approve': null,
  'lesson-md export': 'package', 'lesson-md import': 'write-screen',
  // tools call: the tool it calls says itself (callAgentTool).
  mcp: null, codes: 'docs', docs: 'docs', rules: 'learn', 'rules update': null,
  'tools skills': 'docs', 'tools guide': 'learn', 'tools list': 'learn', 'tools call': null
};

type Place = Pick<ActivityEntry, 'screen' | 'page' | 'language'>;
// The tools whose id is a screen's (elsewhere id names a block, a layer…).
const SCREEN_ID = new Set(['elabora_get_screen', 'elabora_create_screen', 'elabora_update_screen', 'elabora_delete_screen', 'elabora_move_screen', 'elabora_duplicate_screen']);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined);

// Where a tool works, from its arguments: never the course's text, only ids.
export function toolPlace(tool: string, args: unknown): Place {
  if (typeof args !== 'object' || args === null) return {};
  const a = args as Record<string, unknown>;
  const screens = Array.isArray(a.screens) ? a.screens : [];
  const place: Place = {
    screen: text(a.screen) ?? (SCREEN_ID.has(tool) ? text(a.id) : undefined) ?? text(screens[0]),
    page: tool === 'elabora_docs' ? text(a.page) : undefined,
    language: text(a.language) ?? text(a.to)
  };
  return Object.fromEntries(Object.entries(place).filter(([, value]) => value !== undefined)) as Place;
}

// Where a command works, from its words: --screen, --language (or --lang, --to), and the page docs reads.
export function commandPlace(command: string, args: readonly string[]): Place {
  const flag = (...names: string[]): string | undefined => {
    for (const [index, arg] of args.entries()) {
      for (const name of names) {
        if (arg === `--${name}`) return text(args[index + 1]);
        if (arg.startsWith(`--${name}=`)) return text(arg.slice(name.length + 3));
      }
    }
    return undefined;
  };
  const place: Place = {
    screen: flag('screen'),
    page: command === 'docs' ? text(args.find((arg) => !arg.startsWith('-'))) : undefined,
    language: flag('language', 'lang', 'to')
  };
  return Object.fromEntries(Object.entries(place).filter(([, value]) => value !== undefined)) as Place;
}

// Runs an operation of an agent between its two lines of activity. Only AI work is reported: a
// human typing a command is not an agent at work.
// found: where the result says it worked, when the arguments did not (a block's screen).
export async function withActivity<T>(root: string, op: string, family: ActivityFamily | null | undefined, author: Author, place: Place, run: () => Promise<T>, ok: (result: T) => boolean, found?: (result: T) => Place): Promise<T> {
  if (!family || (author.kind !== 'agent' && author.kind !== 'external')) return run();
  const id = randomUUID();
  const base = { id, op, family, author, ...place };
  recordActivity(root, { at: new Date().toISOString(), phase: 'start', ...base });
  let succeeded = false;
  let more: Place = {};
  try {
    const result = await run();
    succeeded = ok(result);
    if (found && !place.screen) more = found(result);
    return result;
  } finally {
    recordActivity(root, { at: new Date().toISOString(), phase: 'end', ...base, ...more, ok: succeeded });
  }
}

// The screen an edit says it changed (its payload's screen), for a tool given a block's id.
export function resultScreen(result: CallToolResult): Place {
  const part = result.content.find((each) => each.type === 'text');
  if (result.isError || !part || part.type !== 'text' || !part.text.startsWith('{')) return {};
  try {
    const screen = text(JSON.parse(part.text)?.screen);
    return screen ? { screen } : {};
  } catch {
    return {};
  }
}
