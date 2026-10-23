import fs from 'node:fs';
import path from 'node:path';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { importNarration, importNarrationFiles } from '@elabora/node/narration/audio';
import { alignNarration, disposeAligner } from '@elabora/node/align/index';
import { disposeTranscriber, transcribeAudio } from '@elabora/node/transcribe/index';
import type { TranscribeProgress, TranscriptionEstimate, TranscriptionService } from '@elabora/node/transcribe/index';
import { addNarrationLineFromAudio, setNarrationTextFromAudio, transcribeNarrationLine } from '@elabora/node/narration/from-audio';
import { timelineReport, formatTimeline, narratedScreens, formatNarratedScreens } from '@elabora/core/narration/report';
import { parseAnchor } from '@elabora/core/narration/anchor-text';
import { setBlockTiming, splitStep, narrationFromPlan, keepNarrationAudio } from '@elabora/node/edit';
import type { MomentPatch } from '@elabora/core/commands/index';
import { defineCommand, printDiagnostics, printFormatMigration, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  timeline [dir] [screen] [--language <lang>] [--json]
                                                      A timed screen's timeline as text: its steps and their times,
                                                      each line with its speaker, start, end and audio (ok, missing,
                                                      stale), the blocks of each step, the timed blocks with their
                                                      moments and effects, and the events its cues fire; then each
                                                      layer that has its own timeline. Without a screen: every
                                                      narrated screen and its audio
  timing [dir] <block> [--in <moment>] [--out <moment>] [--effect <name>] [--duration <s>] [--direction <side>]
         [--out-effect <name>] [--out-duration <s>] [--out-direction <side>] [--clear in|out|all] [--json]
                                                      When a block comes and goes on its screen's timeline, in one
                                                      undoable change. A moment: l2 (a line starts), l2:end, a word of
                                                      it l2:imprimante (l2:imprimante:end, #2 its second time, +0.3s
                                                      after it), 1.5s or 1.5s@2 from a step's start on a screen without
                                                      narration, step2, step2:end. Effects: none, fade, rise, slide,
                                                      zoom, wipe, draw, or the theme's; sides: left, right, up, down
  narration import [dir] <screen> <line> <file> [--language <lang>] [--keep-silence] [--json]
                                                      A recorded human voice for a line: converted (M4A, AAC, mono), its
                                                      silence at both ends trimmed, written to
                                                      assets/narration/<language>/<screen>/<line>.m4a with its sidecar,
                                                      in one undoable change (W_NARRATION_AUDIO_MISSING, _STALE)
  narration import-files [dir] [--screen <id>] <file>… [--language <lang>] [--keep-silence] [--json]
                                                      Recordings of several lines at once: each file goes to the line its name
                                                      gives (l2.wav, accueil-l2.m4a, or 02.wav: the second line of --screen),
                                                      the others to the line of --screen whose text the voice says (with the
                                                      word aligner installed); one undoable change a line
  narration from-plan [dir] <screen> [--replace] [--json]
                                                      The screen's script from the voice-over the validated plan gives the items
                                                      it covers (plan items' voiceover), a line each; --replace: a screen that
                                                      has a narration loses it and its audio
  narration transcribe [dir] <file> [--language <lang>] [--service local|elevenlabs] [--spend <percent>] [--json]
                                                      What a recording says, punctuated, its words with their times: on this
                                                      computer by default (Parakeet, downloaded once, 671 MB; free, nothing
                                                      leaves the computer), or by ElevenLabs with the author's key: from 1 %
                                                      of the quota it says the share (exit code 3) and runs with --spend
  narration add-from-audio [dir] <screen> <file> [--text <text>] [--after <line>|--first] [--step <n>] [--speaker <id>] [--layer <id>]
         [--language <lang>] [--keep-silence] [--service local|elevenlabs] [--spend <percent>] [--json]
                                                      A new line made from a recording: its text what the recording says
                                                      (transcribed, or --text), its audio the recording (trimmed, encoded),
                                                      its words timed when the aligner is installed, in one undoable change;
                                                      after the last line by default, in the step and with the speaker of
                                                      the line before it; --layer: a line of that layer's narration
  narration retranscribe [dir] <screen> <line> [--dry-run] [--text <text>] [--service local|elevenlabs] [--spend <percent>] [--json]
                                                      The line's text written again from its recording (a recording says
                                                      something else than the script): its old and new text printed, then
                                                      written in one undoable change, the recording kept and its words timed
                                                      again; translations of the line become « changed since ». --dry-run:
                                                      print only
  narration keep [dir] <screen> <line> [--language <lang>] [--json]
                                                      The line's text was corrected (a checked transcription, a typo) and its
                                                      audio still says it: the audio stays up to date, its words follow
  narration split [dir] <screen> <line> [--json]       Cut a step at a line (W_SEGMENT_TOO_LONG): the line and those after it in
                                                      its step start the next step, so Continue paces them; later steps, their
                                                      blocks and the anchors that name them move one on, in one undoable change
  narration align [dir] [screen] [--line <ids>] [--language <lang>] [--force] [--json]
                                                      When each word of the voiced lines is said (forced alignment):
                                                      written into their sidecars, where word anchors find their
                                                      times. Downloads the word aligner of the language once (French
                                                      355 MB, English 95 MB); lines made or imported afterwards are
                                                      timed at once. --line l1,l2 (with a screen); --force: lines
                                                      already timed too. Says which words the voice may have swallowed`;

// The course folder is optional before the other arguments: a first argument that is a course is the course.
function courseAndArguments(positionals: readonly string[]): { dir: string; rest: string[] } {
  const [first, ...rest] = positionals;
  if (first !== undefined && fs.existsSync(path.join(first, 'course.json'))) return { dir: first, rest };
  return { dir: '.', rest: [...positionals] };
}

const notACourse = (dir: string) => !fs.existsSync(path.join(dir, 'course.json'));

const timeline = defineCommand({
  name: 'timeline',
  flags: { language: 'string', json: 'boolean' },
  run({ positionals, flags }) {
    const { dir, rest: [screen, ...extra] } = courseAndArguments(positionals);
    if (extra.length) { console.error('Usage: elabora timeline [dir] [screen] [--language <lang>] [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const project = loadProjectFromDir(dir);
    const language = flags.language || project.course?.language || '';
    if (!screen) {
      const screens = narratedScreens(project, { language });
      if (flags.json) printJson({ language, screens });
      else console.log(formatNarratedScreens(screens, language));
      return 0;
    }
    if (!project.screens.has(screen)) { console.error(`✘ Unknown screen "${screen}".`); return 1; }
    const report = timelineReport(project, screen, { language });
    if (!report) { console.error(`✘ Screen "${screen}" has no narration (screens/${screen}.json narration.lines).`); return 1; }
    if (flags.json) printJson(report);
    else console.log(formatTimeline(report));
    return 0;
  }
});

const importCommand = defineCommand({
  name: 'narration import',
  flags: { language: 'string', 'keep-silence': 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [screen, line, file, ...extra] } = courseAndArguments(positionals);
    if (!screen || !line || !file || extra.length) { console.error('Usage: elabora narration import [dir] <screen> <line> <file> [--language <lang>] [--keep-silence] [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const result = await importNarration(dir, { screen, line, file, ...(flags.language ? { language: flags.language } : {}), trim: !flags['keep-silence'] }).finally(disposeAligner);
    const touched = new Set(result.files);
    const own = result.diagnostics.filter((d) => d.severity !== 'info' && (d.file === undefined || touched.has(d.file) || d.file === `screens/${screen}.json`));
    if (flags.json) { printJson({ ok: true, screen, line, audio: result.audio, sidecar: result.sidecar, change: result.change, undo: result.undo, files: result.files, diagnostics: own }); return 0; }
    printFormatMigration(result.formatMigration);
    console.log(`✔ Voice of line ${line} of ${screen}: ${result.audio}`);
    printDiagnostics(own);
    if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
    return 0;
  })
});

const importFilesCommand = defineCommand({
  name: 'narration import-files',
  flags: { screen: 'string', language: 'string', 'keep-silence': 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: files } = courseAndArguments(positionals);
    if (!files.length) { console.error('Usage: elabora narration import-files [dir] [--screen <id>] <file>… [--language <lang>] [--keep-silence] [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const result = await importNarrationFiles(dir, { files, ...(flags.screen ? { screen: flags.screen } : {}), ...(flags.language ? { language: flags.language } : {}), trim: !flags['keep-silence'] }).finally(disposeAligner);
    if (flags.json) { printJson(result); return result.files.every((file) => file.status === 'imported') ? 0 : 1; }
    for (const file of result.files) {
      if (file.status === 'imported') console.log(`✔ ${path.basename(file.file)} → ${file.screen} ${file.line}${file.by === 'voice' ? ' (by what it says)' : ''}`);
      else console.log(`✘ ${path.basename(file.file)}: ${file.reason}`);
    }
    const changes = result.files.map((file) => file.change).filter((change): change is number => typeof change === 'number');
    if (changes.length) console.log(`  Undo: elabora undo --change <seq> for each line (${changes.join(', ')})`);
    return result.files.every((file) => file.status === 'imported') ? 0 : 1;
  })
});

const fromPlanCommand = defineCommand({
  name: 'narration from-plan',
  flags: { replace: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [screen, ...extra] } = courseAndArguments(positionals);
    if (!screen || extra.length) { console.error('Usage: elabora narration from-plan [dir] <screen> [--replace] [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const result = await narrationFromPlan(dir, { screen, replace: !!flags.replace });
    const own = result.diagnostics.filter((d) => d.severity !== 'info' && d.file === `screens/${screen}.json`);
    if (flags.json) { printJson({ ok: true, screen, lines: result.lines, change: result.change, undo: result.undo, diagnostics: own }); return 0; }
    printFormatMigration(result.formatMigration);
    console.log(`✔ ${screen} says the plan's voice-over: ${result.lines.length} line(s). Next: elabora voice generate . ${screen}`);
    printDiagnostics(own);
    if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
    return 0;
  })
});

// --service and --spend, as voice generate takes --spend (D30): null when they are wrong.
function transcribing(flags: { service?: string; spend?: string }): { service?: TranscriptionService; approvedPercent?: number } | null {
  if (flags.service !== undefined && flags.service !== 'local' && flags.service !== 'elevenlabs') { console.error('✘ --service takes local (this computer, free) or elevenlabs (your key, your quota).'); return null; }
  const spend = flags.spend === undefined ? undefined : Number(flags.spend.replace(/\s*%$/, '').replace(',', '.'));
  if (spend !== undefined && !(Number.isFinite(spend) && spend >= 0 && spend <= 100)) { console.error('✘ --spend: the share of the monthly quota the author approved, in percent (2, or 2%).'); return null; }
  return { ...(flags.service === 'elevenlabs' ? { service: 'elevenlabs' as const } : {}), ...(spend !== undefined ? { approvedPercent: spend } : {}) };
}

// The download of the transcriber, on stderr (the answer is on stdout).
function downloadProgress(json: boolean): (progress: TranscribeProgress) => void {
  let shown = -1;
  return (progress) => {
    if (json || progress.phase !== 'install') return;
    const percent = Math.floor((progress.received / Math.max(1, progress.total)) * 100);
    if (percent >= shown + 10 || percent === 100) { shown = percent; process.stderr.write(`  Transcription model: ${Math.round(progress.received / 1e6)}/${Math.round(progress.total / 1e6)} MB\n`); }
  };
}

// ElevenLabs from 1 % of the quota, not approved: the share, and exit code 3 (an agent asks the
// author, then --spend <percent>). null: another failure.
function spendRefused(error: unknown, json: boolean, again: string): number | null {
  const estimate = error && typeof error === 'object' && 'code' in error && error.code === 'E_TRANSCRIBE_SPEND' ? (error as { estimate?: TranscriptionEstimate }).estimate : undefined;
  if (!estimate) return null;
  if (json) printJson({ ok: false, code: 'E_TRANSCRIBE_SPEND', needsApproval: true, estimate });
  else console.error(`✘ ${(error as Error).message}\n  Tell the author « ~${estimate.percent ?? '?'} % of your monthly quota », then once they agreed: ${again} --spend ${estimate.percent ?? '<percent>'}`);
  return 3;
}

const transcribeCommand = defineCommand({
  name: 'narration transcribe',
  flags: { language: 'string', service: 'string', spend: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [file, ...extra] } = courseAndArguments(positionals);
    const usage = 'Usage: elabora narration transcribe [dir] <file> [--language <lang>] [--service local|elevenlabs] [--spend <percent>] [--json]';
    if (!file || extra.length) { console.error(usage); return 2; }
    const language = flags.language || (notACourse(dir) ? '' : loadProjectFromDir(dir).course?.language || '');
    if (!language) { console.error('✘ Give the language of the recording: --language fr.'); return 2; }
    const how = transcribing(flags);
    if (!how) return 2;
    try {
      const transcript = await transcribeAudio(path.resolve(file), language, { ...how, install: true, onProgress: downloadProgress(!!flags.json) });
      if (flags.json) { printJson(transcript); return 0; }
      console.log(transcript.text);
      console.log(`  ${transcript.words.length} words, ${transcript.duration} s, by ${transcript.transcriber}${transcript.percent !== undefined ? ` (~${transcript.percent} % of your monthly quota)` : ''}: check it.`);
      return 0;
    } catch (error) {
      const refused = spendRefused(error, !!flags.json, `elabora narration transcribe ${file} --service elevenlabs`);
      if (refused !== null) return refused;
      throw error;
    } finally {
      await disposeTranscriber();
    }
  })
});

const addFromAudioCommand = defineCommand({
  name: 'narration add-from-audio',
  flags: { text: 'string', after: 'string', first: 'boolean', step: 'string', speaker: 'string', layer: 'string', language: 'string', 'keep-silence': 'boolean', service: 'string', spend: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [screen, file, ...extra] } = courseAndArguments(positionals);
    const usage = 'Usage: elabora narration add-from-audio [dir] <screen> <file> [--text <text>] [--after <line>|--first] [--step <n>] [--speaker <id>] [--layer <id>] [--language <lang>] [--keep-silence] [--service local|elevenlabs] [--spend <percent>] [--json]';
    if (!screen || !file || extra.length || (flags.first && flags.after)) { console.error(usage); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const step = flags.step === undefined ? undefined : Number(flags.step);
    if (step !== undefined && !(Number.isInteger(step) && step >= 1)) { console.error('✘ --step takes a step number (1, 2…).'); return 2; }
    const how = transcribing(flags);
    if (!how) return 2;
    try {
      const result = await addNarrationLineFromAudio(dir, {
        screen, file: path.resolve(file), ...how, install: true, onProgress: downloadProgress(!!flags.json), trim: !flags['keep-silence'],
        ...(flags.text ? { text: flags.text } : {}), ...(flags.first ? { after: null } : flags.after ? { after: flags.after } : {}), ...(step !== undefined ? { step } : {}),
        ...(flags.speaker ? { speaker: flags.speaker } : {}), ...(flags.layer ? { layer: flags.layer } : {}), ...(flags.language ? { language: flags.language } : {})
      });
      const own = result.diagnostics.filter((d) => d.severity !== 'info' && d.file === `screens/${screen}.json`);
      if (flags.json) { printJson({ ok: true, screen, line: result.line, text: result.text, audio: result.audio, sidecar: result.sidecar, transcriber: result.transcript?.transcriber ?? null, change: result.change, undo: result.undo, diagnostics: own }); return 0; }
      printFormatMigration(result.formatMigration);
      console.log(`✔ Line ${result.line} of ${screen}, from ${path.basename(file)}: « ${result.text} »`);
      if (result.transcript) console.log(`  Transcribed by ${result.transcript.transcriber}${result.transcript.percent !== undefined ? ` (~${result.transcript.percent} % of your monthly quota)` : ''}: check the text (elabora narration retranscribe --text, or edit the line).`);
      printDiagnostics(own);
      if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
      return 0;
    } catch (error) {
      const refused = spendRefused(error, !!flags.json, `elabora narration add-from-audio ${screen} ${file} --service elevenlabs`);
      if (refused !== null) return refused;
      throw error;
    } finally {
      await disposeTranscriber();
      await disposeAligner();
    }
  })
});

const retranscribeCommand = defineCommand({
  name: 'narration retranscribe',
  flags: { 'dry-run': 'boolean', text: 'string', language: 'string', service: 'string', spend: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [screen, line, ...extra] } = courseAndArguments(positionals);
    const usage = 'Usage: elabora narration retranscribe [dir] <screen> <line> [--dry-run] [--text <text>] [--service local|elevenlabs] [--spend <percent>] [--json]';
    if (!screen || !line || extra.length || (flags['dry-run'] && flags.text)) { console.error(usage); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const how = transcribing(flags);
    if (!how) return 2;
    const language = flags.language ? { language: flags.language } : {};
    try {
      if (flags['dry-run']) {
        const heard = await transcribeNarrationLine(dir, { screen, line, ...language, ...how, install: true, onProgress: downloadProgress(!!flags.json) });
        if (flags.json) { printJson({ ok: true, screen, line, before: heard.before, text: heard.transcript.text, transcript: heard.transcript, audioHash: heard.audioHash }); return 0; }
        console.log(`  Now:        ${heard.before}`);
        console.log(`  Recording:  ${heard.transcript.text}`);
        console.log(heard.before === heard.transcript.text ? '  The recording says the line\'s text.' : `  Write it: elabora narration retranscribe ${screen} ${line}${flags.service ? ` --service ${flags.service}` : ''} (or --text with the text checked)`);
        return 0;
      }
      const result = await setNarrationTextFromAudio(dir, { screen, line, ...language, ...how, install: true, onProgress: downloadProgress(!!flags.json), ...(flags.text ? { text: flags.text } : {}) });
      const own = result.diagnostics.filter((d) => d.severity !== 'info' && d.file === `screens/${screen}.json`);
      if (flags.json) { printJson({ ok: true, screen, line, before: result.before, text: result.text, anchors: result.anchors ?? null, transcriber: result.transcript?.transcriber ?? null, change: result.change, undo: result.undo, diagnostics: own }); return 0; }
      printFormatMigration(result.formatMigration);
      if (!result.change) { console.log(`✔ The recording of ${line} (${screen}) says its text: nothing changed.`); return 0; }
      console.log(`  Was:  ${result.before}`);
      console.log(`✔ Now:  ${result.text}`);
      for (const lost of result.anchors?.lost ?? []) console.log(`  ⚠ ${lost.where} was anchored to « ${lost.word} », which the line no longer says: anchor it again (elabora timing).`);
      printDiagnostics(own);
      console.log(`  Undo: elabora undo --change ${result.change.seq}`);
      return 0;
    } catch (error) {
      const refused = spendRefused(error, !!flags.json, `elabora narration retranscribe ${screen} ${line}${flags['dry-run'] ? ' --dry-run' : ''} --service elevenlabs`);
      if (refused !== null) return refused;
      throw error;
    } finally {
      await disposeTranscriber();
      await disposeAligner();
    }
  })
});

const keepCommand = defineCommand({
  name: 'narration keep',
  flags: { language: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [screen, line, ...extra] } = courseAndArguments(positionals);
    if (!screen || !line || extra.length) { console.error('Usage: elabora narration keep [dir] <screen> <line> [--language <lang>] [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const result = await keepNarrationAudio(dir, { screen, line, ...(flags.language ? { language: flags.language } : {}) });
    if (flags.json) { printJson({ ok: true, screen, line, sidecar: result.sidecar, change: result.change, undo: result.undo }); return 0; }
    console.log(`✔ The audio of ${line} (${screen}) says its text as it is now.`);
    if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
    return 0;
  })
});

const splitCommand = defineCommand({
  name: 'narration split',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [screen, line, ...extra] } = courseAndArguments(positionals);
    if (!screen || !line || extra.length) { console.error('Usage: elabora narration split [dir] <screen> <line> [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const result = await splitStep(dir, { screen, line });
    const own = result.diagnostics.filter((d) => d.severity !== 'info' && d.file === `screens/${screen}.json`);
    if (flags.json) { printJson({ ok: true, screen, step: result.step, lines: result.lines, blocks: result.blocks, change: result.change, undo: result.undo, diagnostics: own }); return 0; }
    printFormatMigration(result.formatMigration);
    console.log(`✔ Step ${result.step} of ${screen} now starts at ${line} (${result.lines.join(', ')}${result.blocks.length ? `; with ${result.blocks.join(', ')}` : ''}).`);
    printDiagnostics(own);
    if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
    return 0;
  })
});

const alignCommand = defineCommand({
  name: 'narration align',
  flags: { line: 'string', language: 'string', force: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [screen, ...extra] } = courseAndArguments(positionals);
    if (extra.length || (flags.line && !screen)) { console.error('Usage: elabora narration align [dir] [screen] [--line <ids>] [--language <lang>] [--force] [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    let shown = -1;
    try {
      const result = await alignNarration(dir, {
        ...(screen ? { screen } : {}), ...(flags.line ? { lines: flags.line.split(',').map((line) => line.trim()).filter(Boolean) } : {}),
        ...(flags.language ? { language: flags.language } : {}), force: !!flags.force,
        onProgress: (progress) => {
          if (flags.json || progress.phase !== 'install') return;
          const percent = Math.floor((progress.received / Math.max(1, progress.total)) * 100);
          if (percent >= shown + 10 || percent === 100) { shown = percent; process.stderr.write(`  Word aligner: ${Math.round(progress.received / 1e6)}/${Math.round(progress.total / 1e6)} MB\n`); }
        }
      });
      if (flags.json) { printJson(result); return result.lines.some((line) => line.status === 'failed') ? 1 : 0; }
      const aligned = result.lines.filter((line) => line.status === 'aligned');
      for (const line of result.lines) {
        if (line.status === 'aligned') console.log(`✔ ${line.screen} ${line.line}: ${line.words} words`);
        else if (line.status === 'failed') console.log(`✘ ${line.screen} ${line.line}: ${line.reason}`);
        else if (screen || line.reason !== 'already timed') console.log(`· ${line.screen} ${line.line}: ${line.reason}`);
        for (const doubt of line.doubtful ?? []) console.log(`  ⚠ The voice may have swallowed « ${doubt.word} » (score ${doubt.score}): listen to it, or make another take (elabora voice generate . ${line.screen} --line ${line.line}).`);
      }
      if (!result.lines.length) console.log(`No voiced line to time in ${result.language}.`);
      else console.log(`${aligned.length} line(s) timed in ${result.language}${result.aligner ? ` by ${result.aligner}` : ''}.${result.changes.length ? ` Undo: elabora undo --change ${result.changes[0]}${result.changes.length > 1 ? ` … ${result.changes.at(-1)}` : ''}` : ''}`);
      return result.lines.some((line) => line.status === 'failed') ? 1 : 0;
    } finally {
      await disposeAligner();
    }
  })
});

// When a block comes and goes: its in and out moments, as patches of what it has.
const timingCommand = defineCommand({
  name: 'timing',
  flags: { in: 'string', out: 'string', effect: 'string', duration: 'string', direction: 'string', 'out-effect': 'string', 'out-duration': 'string', 'out-direction': 'string', clear: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [block, ...extra] } = courseAndArguments(positionals);
    const usage = 'Usage: elabora timing [dir] <block> [--in <moment>] [--out <moment>] [--effect <name>] [--duration <s>] [--direction <side>] [--out-effect <name>] [--out-duration <s>] [--out-direction <side>] [--clear in|out|all] [--json]';
    if (!block || extra.length) { console.error(usage); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    if (flags.clear && !['in', 'out', 'all'].includes(flags.clear)) { console.error('✘ --clear takes in, out or all.'); return 2; }
    const patchOf = (kind: 'in' | 'out'): MomentPatch | null | undefined => {
      if (flags.clear === kind || flags.clear === 'all') return null;
      const prefix = kind === 'in' ? '' : 'out-';
      const written = flags[kind];
      const effect = flags[`${prefix}effect` as 'effect'];
      const duration = flags[`${prefix}duration` as 'duration'];
      const direction = flags[`${prefix}direction` as 'direction'];
      if (written === undefined && effect === undefined && duration === undefined && direction === undefined) return undefined;
      const patch: MomentPatch = {};
      if (written !== undefined) {
        const at = parseAnchor(written);
        if (!at) throw new Error(`"${written}" is not a moment: l2, l2:end, l2:imprimante, l2:imprimante:end, l2:imprimante#2, l2:imprimante+0.3s, 1.5s, 1.5s@2, step2 or step2:end.`);
        patch.at = at;
      }
      if (effect !== undefined) patch.effect = effect;
      if (duration !== undefined) { const seconds = Number(duration); if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`--${prefix}duration takes seconds (0.4).`); patch.duration = seconds; }
      if (direction !== undefined) { if (!['left', 'right', 'up', 'down'].includes(direction)) throw new Error(`--${prefix}direction takes left, right, up or down.`); patch.direction = direction as 'left'; }
      return patch;
    };
    const args = { block, ...(patchOf('in') !== undefined ? { in: patchOf('in') } : {}), ...(patchOf('out') !== undefined ? { out: patchOf('out') } : {}) };
    if (!('in' in args) && !('out' in args)) { console.error(usage); return 2; }
    const result = await setBlockTiming(dir, args);
    const own = result.diagnostics.filter((d) => d.severity !== 'info' && d.file === `screens/${result.screen}.json`);
    if (flags.json) { printJson({ ok: true, block, screen: result.screen, timing: result.timing, change: result.change, undo: result.undo, diagnostics: own }); return 0; }
    printFormatMigration(result.formatMigration);
    console.log(result.timing ? `✔ Timing of ${block} (${result.screen}): ${JSON.stringify(result.timing)}` : `✔ ${block} (${result.screen}) is no longer timed: it shows with its step.`);
    printDiagnostics(own);
    console.log(`  See it: elabora timeline . ${result.screen}${result.timing?.in ? `  ·  elabora look . --screen ${result.screen} --at <moment>` : ''}`);
    if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
    return 0;
  })
});

export const narrationCommands: CommandGroup = {
  title: 'Narration (the voice of narrated screens, and their timeline)',
  help: HELP,
  commands: [timeline, timingCommand, importCommand, importFilesCommand, fromPlanCommand, transcribeCommand, addFromAudioCommand, retranscribeCommand, keepCommand, splitCommand, alignCommand],
  subcommandUsage: { narration: `Usage: elabora narration import|import-files|from-plan|transcribe|add-from-audio|retranscribe|keep|split|align\n\n${HELP}` }
};
