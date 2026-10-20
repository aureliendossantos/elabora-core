import path from 'node:path';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { importNarration } from '@elabora/node/narration/audio';
import { alignNarration } from '@elabora/node/align/index';
import { transcribeAudio } from '@elabora/node/transcribe/index';
import type { TranscriptionEstimate } from '@elabora/node/transcribe/index';
import { addNarrationLineFromAudio, setNarrationTextFromAudio, transcribeNarrationLine } from '@elabora/node/narration/from-audio';
import { timelineReport, formatTimeline, narratedScreens, formatNarratedScreens } from '@elabora/core/narration/report';
import { setBlockTiming } from '@elabora/node/edit';
import type { MomentPatch } from '@elabora/core/commands/index';
import { defineTool, editResult, errorResult, formatValue, objectSchema, SLUG, textResult } from './tool.ts';

// Narration (docs/decisions.md D24): the timeline of a narrated screen as text, a recorded voice for
// a line, and lines made from recordings (D46). The script itself is the screen's narration.lines,
// edited like any screen field.

const LANGUAGE = { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$', description: 'A language of the course or of one of its translations (default: the course language).' } as const;

export const timeline = defineTool({
  name: 'elabora_timeline',
  readOnly: true,
  description: 'A timed screen\'s timeline as text, read without a capture: its steps (segments) and their times, each narration line with its speaker, start, end and audio (ok, missing, stale: what to generate or record again), the blocks each step shows, the timed blocks with their moments (the anchor, its time, the effect) and the events its cues fire (timeline.reached, timeline.ended). Times come from the lines\' audio and their word times, estimated from the text while a line has none. Without screen: every narrated screen with the audio of its lines. To see a moment, elabora_look with at: "l2", "l2:imprimante" or a time in seconds.',
  inputSchema: objectSchema({ screen: { ...SLUG, description: 'A narrated screen (default: the list of narrated screens).' }, language: LANGUAGE }),
  handler(args, { root }) {
    const project = loadProjectFromDir(root);
    const language = args.language || project.course?.language || '';
    if (!args.screen) {
      const screens = narratedScreens(project, { language });
      return textResult({ language, screens, text: formatNarratedScreens(screens, language) });
    }
    const report = timelineReport(project, args.screen, { language });
    if (!report) return errorResult({ error: project.screens.has(args.screen) ? `Screen "${args.screen}" has no narration (narration.lines).` : `Unknown screen "${args.screen}".` });
    return textResult({ ...report, text: formatTimeline(report) });
  }
});

export const importNarrationTool = defineTool({
  name: 'elabora_import_narration',
  description: 'A recorded human voice for one narration line: the file (an absolute path; any audio ffmpeg reads) is converted to M4A (AAC, mono), its silence at both ends trimmed, and written to assets/narration/<language>/<screen>/<line>.m4a with its sidecar (the hash of the text it says, its length, provider "recording"), in one undoable change. Answers W_NARRATION_AUDIO_MISSING and W_NARRATION_AUDIO_STALE. Never write these files by hand. A generated voice comes from the voice tools.',
  inputSchema: objectSchema({
    screen: SLUG,
    line: { ...SLUG, description: 'The line (narration.lines[].id).' },
    file: { type: 'string', description: 'Absolute path of the recording.' },
    language: LANGUAGE,
    keepSilence: { type: 'boolean', description: 'Keep the silence at both ends (default: trimmed to 0.1 s; pauses between lines come from pauseBefore).' }
  }, ['screen', 'line', 'file']),
  async handler(args, { root, author }) {
    return editResult(await importNarration(root, { screen: args.screen, line: args.line, file: path.resolve(root, args.file), ...(args.language ? { language: args.language } : {}), trim: !args.keepSilence }, { author }));
  }
});

export const alignNarrationTool = defineTool({
  name: 'elabora_align_narration',
  description: 'When each word of the voiced lines is said (forced alignment, run on this computer): their words and times are written into the lines\' sidecars, one undoable change per line, and word anchors ({ "line": "l2", "word": "imprimante" }) take their real times instead of times estimated from the text (I_TIMELINE_WORDS_ESTIMATED). screen: one screen (default: every narrated screen); lines: some of its lines; force: lines already timed too. The first use of a language downloads its word aligner once (fr 355 MB, en 95 MB); afterwards lines generated or imported are timed at once. doubtful lists words the voice may have swallowed (a low score): listen to the line and make another take (elabora_voice_generate with lines).',
  inputSchema: objectSchema({
    screen: { ...SLUG, description: 'A narrated screen (default: every narrated screen).' },
    lines: { type: 'array', items: SLUG, description: 'Line ids of the screen (narration.lines[].id).' },
    language: LANGUAGE,
    force: { type: 'boolean', description: 'Time lines already timed by the same aligner again.' }
  }),
  async handler(args, { root, author }) {
    try {
      const result = await alignNarration(root, { ...(args.screen ? { screen: args.screen } : {}), ...(args.lines ? { lines: args.lines } : {}), ...(args.language ? { language: args.language } : {}), force: !!args.force }, { author });
      return textResult({ ok: !result.lines.some((line) => line.status === 'failed'), ...result, ...(result.changes.length ? { undo: `elabora_undo { change: <seq> } for each line (${result.changes.join(', ')})` } : {}) });
    } catch (error) {
      return errorResult({ error: error instanceof Error ? error.message : String(error), ...(error instanceof Error && 'code' in error ? { code: error.code } : {}) });
    }
  }
});

const MOMENT = formatValue<MomentPatch | null>()({
  type: ['object', 'null'],
  description: 'A moment and its effect: { "at": <anchor>, "effect": "rise", "duration": 0.5, "direction": "left" }. Anchors: { "line": "l2" } (the line starts), { "line": "l2", "edge": "end" }, { "line": "l2", "word": "imprimante" } (the voice says that word; a few words work too; occurrence: 2 for its second time; offset: 0.3 seconds after, negative before); on a screen without narration { "seconds": 1.5 } from the start of the block\'s step ({ "seconds": 1.5, "step": 2 }); { "step": 2 } or { "step": 2, "edge": "end" }. Effects: none, fade (default), rise, slide, zoom, wipe, draw, or the theme\'s (course.json theme.effects). Fields set to null go back to their default; the whole moment null removes it.'
});

export const setTiming = defineTool({
  name: 'elabora_set_timing',
  description: 'When a block comes (in) and goes (out) on its screen\'s timeline, with an effect, in one undoable change: the blocks of a narrated screen appear as the voice names them, anchored to a line or a word of the narration (the anchor holds when the voice is generated again or translated); a screen without narration times them in seconds. Without in a block shows with its step, without out it stays until the end. A timed block keeps its place while it is not there (nothing moves). The contents of a stack (type stack) follow one another: give each its in. Read the result\'s diagnostics (E_TIMELINE_ANCHOR_MISSING, W_TEXT_TOO_FAST, E_ACTIVITY_LEAVES_UNANSWERED…), then elabora_timeline and elabora_look at the anchor.',
  inputSchema: objectSchema({ block: SLUG, in: MOMENT, out: MOMENT }, ['block']),
  handler(args, { root, author }) {
    return editResult(setBlockTiming(root, { block: args.block, ...(args.in !== undefined ? { in: args.in } : {}), ...(args.out !== undefined ? { out: args.out } : {}) }, { author }));
  }
});

// Recordings and their text (docs/decisions.md D46): what a recording says, a line made from one,
// a line's text written again from its recording. Transcribed on this computer by default (free,
// private, downloaded once); ElevenLabs with the author's key only when asked, as its voices are.
const SERVICE = { enum: ['local', 'elevenlabs'], description: 'Who transcribes: local (default: on this computer, free, nothing leaves it; the first use downloads the model once, 671 MB) or elevenlabs (the author\'s key and quota: use it only when the author asks for it).' } as const;
const APPROVED = { type: 'number', minimum: 0, maximum: 100, description: 'ElevenLabs only: the share of their monthly quota, in percent, the author agreed to spend after you told them the estimate\'s percent. Only needed from 1 % (a minute of audio is far under it on most plans); never set it without asking.' } as const;
const TRANSCRIBED = 'The text is the transcriber\'s (punctuated, numbers mostly in words, proper names as heard): read it, and correct the line (elabora_update_screen on narration.lines, or text here) when the author\'s spelling differs.';

// From 1 % of the quota, not approved: what to ask the author.
function spendResult(error: unknown) {
  const estimate = error && typeof error === 'object' && 'code' in error && error.code === 'E_TRANSCRIBE_SPEND' ? (error as { estimate?: TranscriptionEstimate }).estimate : undefined;
  return estimate ? textResult({ ok: false, needsApproval: true, estimate, ask: `Ask the author: transcribing ${estimate.seconds} s of audio with ElevenLabs uses ~${estimate.percent ?? '?'} % of their monthly quota (on this computer it is free). Say it as a share of their quota, never in credits. With their agreement, call again with approvedPercent: ${estimate.percent ?? '<percent>'}.` }) : null;
}

const failed = (error: unknown) => spendResult(error) ?? errorResult({ error: error instanceof Error ? error.message : String(error), ...(error instanceof Error && 'code' in error ? { code: error.code } : {}) });

export const transcribeTool = defineTool({
  name: 'elabora_transcribe',
  openWorld: true,
  description: `What a recording says, as text with its words and their times, written nowhere: file is an absolute path (any audio ffmpeg reads). On this computer by default (Parakeet, 25 European languages, punctuation and capitals). To make a line of it, elabora_narration_line_from_audio; to give a line's recording its text, elabora_narration_text_from_audio. ${TRANSCRIBED}`,
  inputSchema: objectSchema({ file: { type: 'string', description: 'Absolute path of the recording.' }, language: LANGUAGE, service: SERVICE, approvedPercent: APPROVED }, ['file']),
  async handler(args, { root }) {
    const language = args.language || loadProjectFromDir(root).course?.language || '';
    try {
      return textResult({ ok: true, ...await transcribeAudio(path.resolve(root, args.file), language, { install: true, ...(args.service ? { service: args.service } : {}), ...(typeof args.approvedPercent === 'number' ? { approvedPercent: args.approvedPercent } : {}) }) });
    } catch (error) { return failed(error); }
  }
});

export const lineFromAudioTool = defineTool({
  name: 'elabora_narration_line_from_audio',
  openWorld: true,
  description: `A new narration line made from a recording, in one undoable change: its text what the recording says (transcribed, or text when you know it), its audio the recording (converted to M4A, its silence at both ends trimmed, provider "recording"), its words timed when the word aligner is installed. It goes after the line after (null: first; default: last), in the step and with the speaker of the line before it unless step or speaker say otherwise. ${TRANSCRIBED} Never write the audio files by hand; a recording for an existing line enters with elabora_import_narration.`,
  inputSchema: objectSchema({
    screen: SLUG,
    file: { type: 'string', description: 'Absolute path of the recording.' },
    text: { type: 'string', description: 'What the recording says, when you know it (no transcription then).' },
    after: { type: ['string', 'null'], pattern: SLUG.pattern, description: 'The line it follows (null: first; default: last).' },
    step: { type: 'integer', minimum: 1, description: 'Its step (default: the step of the line before it).' },
    speaker: { ...SLUG, description: 'Its speaker (course.json speakers[].id; default: the speaker of the line before it).' },
    language: LANGUAGE,
    keepSilence: { type: 'boolean', description: 'Keep the silence at both ends (default: trimmed to 0.1 s).' },
    service: SERVICE,
    approvedPercent: APPROVED
  }, ['screen', 'file']),
  async handler(args, { root, author }) {
    try {
      const result = await addNarrationLineFromAudio(root, {
        screen: args.screen, file: path.resolve(root, args.file), install: true, trim: !args.keepSilence,
        ...(args.text ? { text: args.text } : {}), ...(args.after !== undefined ? { after: args.after } : {}), ...(typeof args.step === 'number' ? { step: args.step } : {}),
        ...(args.speaker ? { speaker: args.speaker } : {}), ...(args.language ? { language: args.language } : {}),
        ...(args.service ? { service: args.service } : {}), ...(typeof args.approvedPercent === 'number' ? { approvedPercent: args.approvedPercent } : {})
      }, { author });
      return editResult(result);
    } catch (error) { return failed(error); }
  }
});

export const textFromAudioTool = defineTool({
  name: 'elabora_narration_text_from_audio',
  openWorld: true,
  description: `A recorded line whose recording says something else than its text (the actor changed words, the script was rewritten after the recording): the line's text becomes what the recording says, in one undoable change; the recording stays, up to date, its words timed again; anchors follow their words (those whose words are gone are listed as lost), and the line's translations become « changed since ». preview: only what the recording says beside the text now, written nowhere (show both to the author when the change is theirs to decide). text: the text checked, to write instead of transcribing again. Refused for a line said by a generated voice (it says its text). ${TRANSCRIBED}`,
  inputSchema: objectSchema({
    screen: SLUG,
    line: { ...SLUG, description: 'The line (narration.lines[].id).' },
    preview: { type: 'boolean', description: 'Say what the recording says, beside the text now, without writing.' },
    text: { type: 'string', description: 'The text to write (what the recording says, checked).' },
    language: LANGUAGE,
    service: SERVICE,
    approvedPercent: APPROVED
  }, ['screen', 'line']),
  async handler(args, { root, author }) {
    const how = { install: true, ...(args.language ? { language: args.language } : {}), ...(args.service ? { service: args.service } : {}), ...(typeof args.approvedPercent === 'number' ? { approvedPercent: args.approvedPercent } : {}) };
    try {
      if (args.preview) {
        const heard = await transcribeNarrationLine(root, { screen: args.screen, line: args.line, ...how });
        return textResult({ ok: true, before: heard.before, text: heard.transcript.text, same: heard.before === heard.transcript.text, transcriber: heard.transcript.transcriber, ...(heard.transcript.percent !== undefined ? { percent: heard.transcript.percent } : {}) });
      }
      return editResult(await setNarrationTextFromAudio(root, { screen: args.screen, line: args.line, ...how, ...(args.text ? { text: args.text } : {}) }, { author }));
    } catch (error) { return failed(error); }
  }
});
