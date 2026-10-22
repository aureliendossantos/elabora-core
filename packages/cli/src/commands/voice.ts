import fs from 'node:fs';
import path from 'node:path';
import { listVoices, localVoices, voiceProviders, voiceProvider, generateNarration, estimateNarration, setSpeakerVoice, voiceTakes, disposeVoiceProviders, writeKeyFile, removeKeyFile, resolveKey, maskKey, keyFile, KEY_ENV } from '@elabora/node/voice/index';
import type { VoiceEstimate, VoiceInfo, VoiceQuery } from '@elabora/node/voice/index';
import { disposeAligner } from '@elabora/node/align/index';
import { DEFAULT_VOICE_MODEL, modelName, voiceFit } from '@elabora/core/narration/voice-fit';
import type { VoiceProgress } from '@elabora/node/voice/index';
import { defineCommand, printJson, reportingFailures } from './command.ts';
import { uninstallCommand } from './downloads.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  voice list [--language <lang>] [--json]           The voices a narration line can be generated with: id, name, register
                                                      and pace, licence of the recording it comes from, and whether its
                                                      model is on this computer (else the size downloaded on first use)
  voice models [--language <lang>] [--json]           The local voices by language and their model: on this computer (its
                                                      size on disk) or not (the size downloaded on first use), being
                                                      downloaded now (by the app, a command or an agent) or in use (the
                                                      voices' part of elabora downloads list)
  voice install <language> [--force] [--json]         Downloads the model of a language's local voices once for this
                                                      computer (fr 354 MB, en 126 MB), with its progress; --force removes
                                                      it first and downloads it again (a reinstall)
  voice uninstall <language> [--json]                 Removes the model of a language's local voices from this computer
                                                      (elabora downloads uninstall voices-<language>), refused while lines are
                                                      said with it or it is being downloaded; the lines already made keep
                                                      their audio, and the next generation downloads it again
  voice set [dir] <speaker> <voice> [--language <lang>] [--provider elevenlabs] [--name <n>] [--model <id>]
            [--stability <0-1>] [--similarity <0-1>] [--json]
                                                      The voice of a speaker of course.json in a language
                                                      (speakers[].voices[<lang>]): its lines made with another voice are
                                                      then out of date
  voice generate [dir] <screen> [--line <id,…>] [--all] [--voice <id>] [--language <lang>] [--take <n>]
                 [--dialogue] [--spend <percent>] [--json]
                                                      Generates the lines of a narrated screen with their speaker's voice
                                                      (by default those missing or out of date; --all: every line):
                                                      each a new take, written to assets/narration/<lang>/<screen>/ with
                                                      its sidecar (generated voice, credit), one undoable change a line.
                                                      --voice sets that voice for the speaker of the lines first;
                                                      --take puts back an earlier take of one line
  voice takes [dir] <screen> <line> [--language <lang>] [--json]
                                                      The takes of a line kept on this computer: which one is its audio,
                                                      which can be put back (--take)
  voice search [words] [--language <lang>] [--gender female|male] [--age young|middle_aged|old] [--accent <a>]
               [--use-case <u>] [--mine|--library] [--model <m>] [--high-quality] [--ready] [--page <n>] [--json]
                                                      ElevenLabs voices (D29): the account's own, then the library's
                                                      thousands, most used first; each with its accent, age, use, a
                                                      recording to hear it (free), its price over the model's, its
                                                      quality and whether it is ready for the model (Eleven v4 unless
                                                      --model) in the language: prefer « checked in <lang> ».
                                                      --high-quality: professional clones that passed ElevenLabs'
                                                      check only; --ready: those checked with the model in the language
  voice estimate [dir] <screen> [--line <id,…>] [--all] [--dialogue] [--language <lang>] [--json]
                                                      What generating would cost before anything is spent: the share of
                                                      the monthly quota, characters and credits per line (about, at most),
                                                      lines made free (local voices, earlier takes given back), the runs
                                                      said as one exchange (--dialogue)
  voice account [--check] [--json]                    The ElevenLabs plan, the share of its monthly quota used, what a line
                                                      costs of it, the key (masked) and where it comes from; --check tries
                                                      each permission Elabora needs without spending
  voice key set|remove|status                         The ElevenLabs API key for the command line and agents: set reads
                                                      it from the input (never an argument), keeps it readable by you
                                                      only in Elabora's local data; ELEVENLABS_API_KEY overrides it

  A paid voice's cost is told as a share of the author's monthly quota (D30). Under 1 % of it, voice generate
  runs; from 1 %, it refuses with the estimate (exit code 3) and runs with --spend <percent> once the author
  agreed to that share. --dialogue says the lines of several speakers that follow each other in a step as one
  exchange, cut back into lines (their pauses from it). Stage directions in brackets ([chuchote], [rit]) are
  played by Eleven v4 voices and never shown.`;

function courseAndArguments(positionals: readonly string[]): { dir: string; rest: string[] } {
  const [first, ...rest] = positionals;
  if (first !== undefined && fs.existsSync(path.join(first, 'course.json'))) return { dir: first, rest };
  return { dir: '.', rest: [...positionals] };
}

const notACourse = (dir: string) => !fs.existsSync(path.join(dir, 'course.json'));
const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

// Progress on stderr, so that stdout stays the command's answer: one line rewritten in a terminal,
// else a line every 25 % (agents, logs).
function voiceProgress(): { report(progress: VoiceProgress): void; done(): void } {
  const terminal = !!process.stderr.isTTY;
  let shown = '';
  const write = (label: string, fraction: number | null) => {
    const percent = fraction === null ? null : Math.floor(fraction * 100);
    const message = percent === null ? `${label}…` : `${label} ${percent}%`;
    if (terminal) { process.stderr.write(`\r  ${message}`.padEnd(Math.min(process.stderr.columns || 80, 100) - 1)); return; }
    const key = `${label} ${percent === null ? '' : Math.floor(percent / 25) * 25}`;
    if (key !== shown) { shown = key; console.error(`  ${message}`); }
  };
  return {
    report(progress) {
      if (progress.phase === 'install') write(`downloading the voice model (${megabytes(progress.total ?? 0)})`, progress.fraction);
      else if (progress.phase === 'align') write(`timing words of line ${progress.line}`, null);
      else write(`line ${progress.line} (${(progress.index ?? 0) + 1}/${progress.count})`, progress.fraction);
    },
    done() { if (terminal) process.stderr.write(`\r${' '.repeat(Math.min(process.stderr.columns || 80, 100) - 1)}\r`); }
  };
}

const list = defineCommand({
  name: 'voice list',
  flags: { language: 'string', json: 'boolean' },
  run({ positionals, flags }) {
    if (positionals.length) { console.error('Usage: elabora voice list [--language <lang>] [--json]'); return 2; }
    const voices = listVoices(flags.language).map((voice) => ({ ...voice, ...(voiceProvider(voice.provider).status(voice.language) ?? { installed: false, size: 0 }) }));
    if (flags.json) { printJson({ voices }); return 0; }
    if (!voices.length) { console.log(flags.language ? `No voice speaks ${flags.language}.` : 'No voice.'); return 0; }
    for (const language of [...new Set(voices.map((voice) => voice.language))]) {
      const ofLanguage = voices.filter((voice) => voice.language === language);
      const status = ofLanguage[0].supported === false ? 'unavailable on Intel Macs' : ofLanguage[0].installed ? 'model on this computer' : `model downloaded on first use: ${megabytes(ofLanguage[0].size)}`;
      console.log(`${language} (${status})`);
      for (const voice of ofLanguage) console.log(`  ${voice.id.padEnd(12)} ${voice.name.padEnd(10)} ${(voice.gender === 'female' ? 'woman' : voice.gender === 'male' ? 'man' : '').padEnd(6)} ${voice.description.en ?? Object.values(voice.description)[0] ?? ''} · ${voice.provider} · ${voice.licence}`);
    }
    return 0;
  }
});

const models = defineCommand({
  name: 'voice models',
  flags: { language: 'string', json: 'boolean' },
  run({ positionals, flags }) {
    if (positionals.length) { console.error('Usage: elabora voice models [--language <lang>] [--json]'); return 2; }
    const views = localVoices(flags.language);
    if (flags.json) { printJson({ models: views }); return 0; }
    if (!views.length) { console.log(flags.language ? `No local voice speaks ${flags.language}.` : 'No local voice.'); return 0; }
    for (const view of views) {
      console.log(`${view.language.padEnd(4)}${voiceProvider(view.provider).name} · ${view.voices.length} voice${view.voices.length > 1 ? 's' : ''}: ${view.voices.map((voice) => voice.name).join(', ')}`);
      if (view.supported === false) console.log(`    unavailable on Intel Macs${view.installed ? ` (elabora voice uninstall ${view.language} removes it)` : ''}`);
      else if (view.installing) console.log(`    downloading: ${Math.floor((view.installing.received / Math.max(1, view.installing.total)) * 100)} % (${megabytes(view.installing.received)} of ${megabytes(view.installing.total)})`);
      else if (view.installed) console.log(`    on this computer: ${megabytes(view.size)}${view.inUse ? ', saying lines now' : ''} (elabora voice uninstall ${view.language} removes it)`);
      else console.log(`    not on this computer: ${megabytes(view.download)} downloaded on first use (elabora voice install ${view.language})`);
    }
    return 0;
  }
});

const install = defineCommand({
  name: 'voice install',
  flags: { force: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const [language, ...extra] = positionals;
    if (!language || extra.length) { console.error('Usage: elabora voice install <language> [--force] [--json]'); return 2; }
    const providers = voiceProviders().filter((provider) => !provider.paid && provider.status(language));
    if (!providers.length) { console.error(`✘ No voice speaks ${language}.`); return 1; }
    const progress = voiceProgress();
    try {
      for (const provider of providers) {
        await provider.install(language, { force: flags.force, onProgress: (p) => progress.report({ phase: 'install', fraction: p.total ? p.received / p.total : 0, received: p.received, total: p.total }) });
      }
    } finally { progress.done(); }
    if (flags.json) printJson({ ok: true, language, providers: providers.map((provider) => ({ id: provider.id, ...provider.status(language) })) });
    else console.log(`✔ Voices in ${language} ${flags.force ? 'downloaded again' : 'ready'} on this computer.`);
    return 0;
  })
});

// The local voices' part of elabora downloads uninstall (D38).
const uninstall = defineCommand({
  name: 'voice uninstall',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const [language, ...extra] = positionals;
    if (!language || extra.length) { console.error('Usage: elabora voice uninstall <language> [--json] (elabora downloads uninstall voices-<language>)'); return 2; }
    return uninstallCommand(`voices-${language.toLowerCase().split('-')[0]}`, flags.json);
  })
});

// --model, --stability, --similarity: an ElevenLabs voice's settings (D29), numbers from 0 to 1.
function elevenSettings(flags: { model?: string; stability?: string; similarity?: string }): Record<string, unknown> | undefined {
  const settings: Record<string, unknown> = {};
  if (flags.model) settings.model = flags.model;
  for (const name of ['stability', 'similarity'] as const) {
    if (flags[name] === undefined) continue;
    const value = Number(flags[name]);
    if (!(value >= 0 && value <= 1)) throw new Error(`--${name}: a number from 0 to 1.`);
    settings[name] = value;
  }
  return Object.keys(settings).length ? settings : undefined;
}

const set = defineCommand({
  name: 'voice set',
  flags: { language: 'string', provider: 'string', name: 'string', model: 'string', stability: 'string', similarity: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [speaker, voice, ...extra] } = courseAndArguments(positionals);
    if (!speaker || !voice || extra.length) { console.error('Usage: elabora voice set [dir] <speaker> <voice> [--language <lang>] [--provider elevenlabs] [--name <n>] [--model <id>] [--stability <0-1>] [--similarity <0-1>] [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const settings = elevenSettings(flags);
    const change = await setSpeakerVoice(dir, { speaker, voice, ...(flags.language ? { language: flags.language } : {}), ...(flags.provider ? { provider: flags.provider } : {}), ...(flags.name ? { name: flags.name } : {}), ...(settings ? { settings } : {}) });
    if (flags.json) { printJson({ ok: true, speaker, voice, change }); return 0; }
    console.log(change === null ? `✔ ${speaker} already speaks with ${voice}.` : `✔ ${speaker} speaks with ${voice}. Its lines made with another voice are out of date: elabora voice generate <screen>.`);
    if (change !== null) console.log(`  Undo: elabora undo --change ${change}`);
    return 0;
  })
});

const generate = defineCommand({
  name: 'voice generate',
  flags: { line: 'list', all: 'boolean', voice: 'string', language: 'string', take: 'string', dialogue: 'boolean', spend: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [screen, ...extra] } = courseAndArguments(positionals);
    if (!screen || extra.length) { console.error('Usage: elabora voice generate [dir] <screen> [--line <id,…>] [--all] [--voice <id>] [--language <lang>] [--take <n>] [--dialogue] [--spend <percent>] [--json]'); return 2; }
    const spend = flags.spend === undefined ? undefined : Number(flags.spend.replace(/\s*%$/, '').replace(',', '.'));
    if (spend !== undefined && !(Number.isFinite(spend) && spend >= 0 && spend <= 100)) { console.error('✘ --spend: the share of the monthly quota the author approved, in percent (2, or 2%), as elabora voice estimate gives it.'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const take = flags.take === undefined ? undefined : Number(flags.take);
    if (take !== undefined && !(Number.isInteger(take) && take >= 1)) { console.error('✘ --take: a take number (1, 2…), as elabora voice takes lists them.'); return 2; }
    const progress = voiceProgress();
    let result;
    try {
      result = await generateNarration(dir, {
        screen, ...(flags.line ? { lines: flags.line } : {}), all: flags.all, ...(flags.voice ? { voice: flags.voice } : {}),
        ...(flags.language ? { language: flags.language } : {}), ...(take !== undefined ? { take } : {}),
        dialogue: flags.dialogue, ...(spend !== undefined ? { approvedPercent: spend } : {}),
        onProgress: (p) => progress.report(p)
      });
    } catch (error) {
      // A paid voice from 1 % of the quota, not approved: the estimate, and exit code 3 (an agent asks
      // the author, then --spend <percent>).
      const estimate = error && typeof error === 'object' && 'code' in error && error.code === 'E_VOICE_SPEND' ? (error as { estimate?: VoiceEstimate }).estimate : undefined;
      if (!estimate) throw error;
      if (flags.json) printJson({ ok: false, code: 'E_VOICE_SPEND', needsApproval: true, estimate });
      else { console.error(`✘ ${(error as Error).message}`); printEstimate(estimate); }
      return 3;
    } finally {
      progress.done();
      await disposeVoiceProviders();
      await disposeAligner();
    }
    if (flags.json) { printJson({ ok: true, ...result }); return 0; }
    if (result.voiceSet) console.log(`✔ ${result.voiceSet.speaker} speaks with ${result.voiceSet.voice} in ${result.language}.`);
    if (!result.lines.length) console.log(`✔ Every line of ${screen} has its audio in ${result.language} (--all or --line to make new takes).`);
    for (const line of result.lines) {
      if (line.status === 'skipped') console.log(`· ${line.line}: ${line.reason}`);
      else if (line.status === 'selected') console.log(`✔ ${line.line}: take ${line.take} put back (${line.audio})${line.reason ? `: ${line.reason}` : ''}`);
      else console.log(`✔ ${line.line}: take ${line.take}, ${line.duration ?? '?'} s of ${line.voice}, made in ${line.seconds} s${line.retries ? ` (${line.retries} part${line.retries > 1 ? 's' : ''} said again)` : ''}${line.dialogue ? ` (exchange ${line.dialogue})` : ''}${line.cached ? ' (from this computer\'s cache: nothing spent)' : ''}`);
      if (line.alignmentError) console.log(`  ! ${line.line}: audio kept, but words could not be timed: ${line.alignmentError}`);
    }
    for (const spent of result.spent ?? []) console.log(`  ${spent.provider}: ${spent.characters} characters sent, ${spent.credits ?? `about ${spent.estimate}`} credits${spent.percent !== null ? ` (~${spent.percent} % of the monthly quota)` : ''}`);
    if (result.overBudget) console.log(`  Stopped: the service charged ~${result.overBudget.spentPercent} % of the monthly quota, more than the ${result.overBudget.allowedPercent} % this generation could use. The other lines wait: estimate again, then ask the author.`);
    if (result.credits.length) console.log(`  Credits: ${result.credits.join(' · ')}`);
    if (result.changes.length) console.log(`  Undo: elabora undo --change ${result.changes.at(-1)} (each line is its own change)`);
    return 0;
  })
});

const takes = defineCommand({
  name: 'voice takes',
  flags: { language: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(() => {
    const { dir, rest: [screen, line, ...extra] } = courseAndArguments(positionals);
    if (!screen || !line || extra.length) { console.error('Usage: elabora voice takes [dir] <screen> <line> [--language <lang>] [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const result = voiceTakes(dir, { screen, line, ...(flags.language ? { language: flags.language } : {}) });
    if (flags.json) { printJson(result); return 0; }
    if (!result.takes.length) { console.log(`No take of ${line} in ${result.language} on this computer.`); return 0; }
    for (const take of result.takes) console.log(`  ${take.current ? '▶' : ' '} take ${take.take}  ${take.voice}  ${take.createdAt}${take.usable ? '' : '  (another text, voice or delivery)'}`);
    return 0;
  })
});

function printEstimate(estimate: VoiceEstimate): void {
  for (const line of estimate.lines) {
    const what = line.reuse ? `take ${line.reuse} given back, free` : line.credits ? `${line.characters} characters, about ${line.credits} credits (at most ${line.ceiling})` : 'free (local voice)';
    console.log(`  ${line.line.padEnd(10)} ${line.provider} ${line.voice.padEnd(22)} ${what}${line.dialogue ? ` · exchange ${line.dialogue}` : ''}`);
  }
  const share = estimate.percent !== null ? `~${estimate.percent} % of the monthly quota (${estimate.quota!.plan} plan), ` : '';
  console.log(`  Total: ${share}${estimate.characters} characters, about ${estimate.credits} credits (at most ${estimate.ceiling})${estimate.reused ? `; ${estimate.reused} take(s) given back` : ''}${estimate.free ? `; ${estimate.free} line(s) by a local voice` : ''}.`);
}

const estimate = defineCommand({
  name: 'voice estimate',
  flags: { line: 'list', all: 'boolean', dialogue: 'boolean', language: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [screen, ...extra] } = courseAndArguments(positionals);
    if (!screen || extra.length) { console.error('Usage: elabora voice estimate [dir] <screen> [--line <id,…>] [--all] [--dialogue] [--language <lang>] [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const result = await estimateNarration(dir, { screen, ...(flags.line ? { lines: flags.line } : {}), all: flags.all, dialogue: flags.dialogue, ...(flags.language ? { language: flags.language } : {}) });
    if (flags.json) { printJson(result); return 0; }
    if (!result.lines.length) { console.log(`✔ Every line of ${screen} has its audio in ${result.language}: nothing to make.`); return 0; }
    printEstimate(result);
    if (result.needsApproval) console.log(`  From 1 % of the quota: tell the author « ~${result.percent ?? '?'} % of your monthly quota », then once they agreed: elabora voice generate ${screen}${flags.dialogue ? ' --dialogue' : ''} --spend ${result.percent ?? '<percent>'}`);
    else if (result.credits) console.log(`  Under 1 % of the quota: elabora voice generate ${screen}${flags.dialogue ? ' --dialogue' : ''} needs no approval.`);
    return 0;
  })
});

const search = defineCommand({
  name: 'voice search',
  flags: { language: 'string', gender: 'string', age: 'string', accent: 'string', 'use-case': 'string', mine: 'boolean', library: 'boolean', model: 'string', 'high-quality': 'boolean', ready: 'boolean', page: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const provider = voiceProvider('elevenlabs');
    const query: VoiceQuery = {
      provider: 'elevenlabs', ...(positionals.length ? { text: positionals.join(' ') } : {}), ...(flags.language ? { language: flags.language } : {}),
      ...(flags.gender ? { gender: flags.gender as VoiceQuery['gender'] } : {}), ...(flags.age ? { age: flags.age as VoiceQuery['age'] } : {}),
      ...(flags.accent ? { accent: flags.accent } : {}), ...(flags['use-case'] ? { useCase: flags['use-case'] } : {}),
      scope: flags.mine ? 'account' : flags.library ? 'library' : 'all', ...(flags.page ? { page: Number(flags.page) } : {}),
      ...(flags['high-quality'] ? { quality: 'high' as const } : {}), ...(flags.ready ? { readyFor: flags.model || DEFAULT_VOICE_MODEL } : {})
    };
    const result = await provider.search!(query);
    if (flags.json) { printJson(result); return 0; }
    if (!result.voices.length) { console.log('No ElevenLabs voice matches.'); return 0; }
    // Whether it is ready for the model, in the language searched (else its own): @elabora/core narration/voice-fit.
    const model = flags.model || DEFAULT_VOICE_MODEL;
    const ready = (voice: VoiceInfo) => {
      const language = query.language ?? voice.language;
      const fit = voiceFit(voice, model, language);
      const checked = fit === 'other-languages' && Array.isArray(voice.models?.[model]) ? (voice.models[model] as string[]).join(', ') : '';
      return fit && `${modelName(model)}: ${{ ready: `checked in ${language}`, trained: 'trained', 'other-languages': `checked in ${checked}, not ${language}`, failed: 'training failed', untrained: 'not checked' }[fit]}`;
    };
    const line = (voice: VoiceInfo) => `  ${voice.id}  ${voice.name.slice(0, 44).padEnd(44)} ${(voice.gender ?? '').padEnd(6)} ${voice.language} ${[voice.labels?.accent, voice.labels?.age, voice.labels?.useCase].filter(Boolean).join(' · ')}${voice.rate && voice.rate !== 1 ? ` · ×${voice.rate} credits` : ''} · ${voice.owner}${voice.quality ? ` (${voice.quality})` : ''}${ready(voice) ? ` · ${ready(voice)}` : ''}`;
    for (const voice of result.voices) console.log(line(voice));
    console.log(`  ${result.voices.length} shown of ${result.total}${result.more ? ` (--page ${(query.page ?? 0) + 1} for more)` : ''}. Hear one: its preview in --json. Choose: elabora voice set <speaker> <id> --provider elevenlabs --name "<name>".`);
    return 0;
  })
});

const accountCommand = defineCommand({
  name: 'voice account',
  flags: { check: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    if (positionals.length) { console.error('Usage: elabora voice account [--check] [--json]'); return 2; }
    const account = await voiceProvider('elevenlabs').account!({ check: flags.check });
    if (flags.json) { printJson(account); return 0; }
    console.log(`ElevenLabs, plan ${account.plan}${account.commercial ? ' (commercial use allowed)' : ' (no commercial use: a paid plan is needed)'}`);
    console.log(`  Quota: ${account.usedPercent} % used this month (${account.used} of ${account.limit} credits)${account.resetsAt ? `, renewed ${account.resetsAt.slice(0, 10)}` : ''}${account.linePercent !== null ? `; a line costs about ${account.linePercent} % of it` : ''}`);
    if (!account.library && account.plan !== 'unknown') console.log('  The free plan cannot use the voice library through the API: the default voices only.');
    console.log(`  Key: ${account.key} (${account.keySource === 'file' ? keyFile() : account.keySource === 'environment' ? KEY_ENV : 'the app'})`);
    const words: Record<string, string> = { text_to_speech: 'Text to Speech', voices_read: 'Voices: read', user_read: 'User: read' };
    for (const [permission, ok] of Object.entries(account.permissions)) if (ok !== null) console.log(`  ${ok ? '✔' : '✘'} ${words[permission] ?? permission}`);
    return 0;
  })
});

async function readSecret(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Paste the ElevenLabs API key, then Enter (it is not shown): ');
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  return new Promise((resolve) => {
    let text = '';
    const done = () => { stdin.off('data', onData); if (stdin.isTTY) { stdin.setRawMode(false); process.stderr.write('\n'); } stdin.pause(); resolve(text.trim()); };
    const onData = (chunk: Buffer) => {
      const part = chunk.toString('utf8');
      if (stdin.isTTY && part === '\u0003') { text = ''; done(); return; }
      const end = part.search(/[\r\n]/);
      text += end >= 0 ? part.slice(0, end) : part;
      if (end >= 0 && stdin.isTTY) done();
    };
    stdin.on('data', onData);
    stdin.once('end', done);
    stdin.resume();
  });
}

const key = defineCommand({
  name: 'voice key',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const [action, ...extra] = positionals;
    if (!['set', 'remove', 'status'].includes(action ?? '') || extra.length) { console.error('Usage: elabora voice key set|remove|status (set reads the key from its input: never give it as an argument)'); return 2; }
    if (action === 'set') {
      const secret = await readSecret();
      if (!secret) { console.error('✘ No key read.'); return 1; }
      const file = writeKeyFile(secret);
      if (flags.json) printJson({ ok: true, key: maskKey(secret), file });
      else console.log(`✔ Key ${maskKey(secret)} kept for the command line and agents, readable by you only: ${file}. Check it: elabora voice account --check`);
      return 0;
    }
    if (action === 'remove') {
      const removed = removeKeyFile();
      if (flags.json) printJson({ ok: true, removed });
      else console.log(removed ? '✔ Key removed from this computer\'s Elabora data.' : 'No key was kept.');
      return 0;
    }
    const found = resolveKey();
    if (flags.json) { printJson(found ? { key: maskKey(found.key), source: found.source } : { key: null }); return 0; }
    console.log(found ? `Key ${maskKey(found.key)} from ${found.source === 'file' ? keyFile() : found.source === 'environment' ? KEY_ENV : 'the app'}.` : 'No ElevenLabs key: elabora voice key set.');
    return 0;
  })
});

export const voiceCommands: CommandGroup = {
  title: 'Voices (generated narration)',
  help: HELP,
  commands: [list, models, install, uninstall, set, generate, takes, search, estimate, accountCommand, key],
  subcommandUsage: { voice: `Usage: elabora voice list|models|install|uninstall|set|generate|takes|search|estimate|account|key\n\n${HELP}` }
};
