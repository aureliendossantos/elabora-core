import fs from 'node:fs';
import path from 'node:path';
import { addSources, listSources, makeSourcesReadable, readSource, removeSource } from '@elabora/node/sources/index';
import type { SourceEntry, SourceProgress } from '@elabora/node/sources/index';
import { disposeTranscriber } from '@elabora/node/transcribe/index';
import { defineCommand, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';

// The author's sources (docs/decisions.md D49): the files a module is made from, in sources/, never
// published, and each one's readable version, which any agent can read.

const HELP = `  sources list [dir] [--json]                         The author's sources (sources/: a brief, a deck, recordings; never
                                                      published), each with its readable version: ready, partial (its
                                                      transcript to come), stale, missing, failed, native (read as it
                                                      is: images, text, a PDF) or unsupported
  sources add [dir] <file|folder>… [--no-read] [--json]
                                                      Copies files into sources/ (a file already there is not copied
                                                      again, a name taken is numbered, one Windows refuses is made
                                                      portable), then writes their readable versions (--no-read: later)
  sources read [dir] <file> [--no-refresh] [--json]   A source's readable version (Markdown), written first when it is
                                                      missing or out of date: a Word document with its comments and
                                                      tracked changes, a deck's slides in reading order with their notes
                                                      and pictures, a recording's transcript (heard on this computer, the
                                                      model downloaded once, 671 MB); an image or a PDF: its path
  sources refresh [dir] [<file>…] [--force] [--json]  Writes the readable versions missing, out of date or waiting for a
                                                      transcript; --force writes them all again
  sources remove [dir] <file> [--json]                Deletes a source and its readable version for good: no backup
                                                      holds sources

  Nothing leaves the computer: a client's brief may hold personal data. A deck gives its slides' texts, notes
  and pictures (the slides themselves are not drawn: add the deck as a PDF too to see them); a file in an older
  office format (.doc, .rtf, .odt, .ppt, .odp, .key) is read once saved as .docx or .pptx; agents read PDFs themselves.`;

function courseAndArguments(positionals: readonly string[]): { dir: string; rest: string[] } {
  const [first, ...rest] = positionals;
  if (first !== undefined && fs.existsSync(path.join(first, 'course.json'))) return { dir: first, rest };
  return { dir: '.', rest: [...positionals] };
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const size = (bytes: number) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} kB` : megabytes(bytes));

const STATUS: Record<SourceEntry['readable']['status'], string> = {
  ready: 'readable', partial: 'readable, transcript to come', stale: 'out of date', missing: 'not read yet', failed: 'could not be read', native: 'read as it is', unsupported: 'not readable',
};

function line(entry: SourceEntry): string {
  const readable = entry.readable.path && entry.readable.status !== 'native' ? ` → ${entry.readable.path}` : '';
  const parts = entry.readable.parts.length ? ` (+${entry.readable.parts.length} image${entry.readable.parts.length === 1 ? '' : 's'})` : '';
  return `  ${entry.name}  ${entry.kind}, ${size(entry.size)} · ${STATUS[entry.readable.status]}${readable}${parts}`;
}

// What is being read, on stderr: stdout stays the command's answer.
function progress(json: boolean): (progress: SourceProgress) => void {
  let shown = -1;
  return (event) => {
    if (json) return;
    if (event.phase === 'install') {
      const percent = Math.floor((event.received / Math.max(1, event.total)) * 100);
      if (percent >= shown + 10 || percent === 100) { shown = percent; process.stderr.write(`  Transcription model: ${Math.round(event.received / 1e6)}/${Math.round(event.total / 1e6)} MB\n`); }
    } else if (event.phase === 'read') process.stderr.write(`  Reading ${event.source}…\n`);
  };
}

const list = defineCommand({
  name: 'sources list',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest } = courseAndArguments(positionals);
    if (rest.length) { console.error('Usage: elabora sources list [dir] [--json]'); return 2; }
    const sources = await listSources(dir);
    if (flags.json) { printJson({ sources }); return 0; }
    if (!sources.length) { console.log('No sources: elabora sources add . <file>… copies the files the module is made from.'); return 0; }
    for (const entry of sources) console.log(line(entry));
    return 0;
  })
});

const add = defineCommand({
  name: 'sources add',
  flags: { 'no-read': 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: files } = courseAndArguments(positionals);
    if (!files.length) { console.error('Usage: elabora sources add [dir] <file|folder>… [--no-read] [--json]'); return 2; }
    const json = !!flags.json;
    try {
      const added = await addSources(dir, files);
      const sources = flags['no-read'] ? await listSources(dir) : await makeSourcesReadable(dir, { names: [...new Set(added.map((entry) => entry.name))], install: true, onProgress: progress(json) });
      const byName = new Map(sources.map((entry) => [entry.name, entry]));
      if (json) { printJson({ added: added.map((entry) => ({ ...entry, source: byName.get(entry.name) ?? null })) }); return 0; }
      for (const entry of added) {
        const source = byName.get(entry.name);
        const how = entry.status === 'already-there' ? `already there as sources/${entry.name}` : `sources/${entry.name}${entry.renamed ? ' (renamed)' : ''}`;
        console.log(`✔ ${entry.from} → ${how}${source ? ` · ${STATUS[source.readable.status]}${source.readable.path && source.readable.status !== 'native' ? ` → ${source.readable.path}` : ''}` : ''}`);
      }
      return 0;
    } finally {
      await disposeTranscriber();
    }
  })
});

const read = defineCommand({
  name: 'sources read',
  flags: { 'no-refresh': 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [file, ...extra] } = courseAndArguments(positionals);
    if (!file || extra.length) { console.error('Usage: elabora sources read [dir] <file> [--no-refresh] [--json]'); return 2; }
    const json = !!flags.json;
    try {
      const reading = await readSource(dir, file, { refresh: !flags['no-refresh'], install: true, onProgress: progress(json) });
      if (json) { printJson(reading); return 0; }
      if (reading.text !== null) process.stdout.write(reading.text.endsWith('\n') ? reading.text : `${reading.text}\n`);
      else if (reading.file) console.log(`${reading.source.name} is read as it is: ${reading.file}${reading.source.readable.notes.length ? `\n${reading.source.readable.notes.join('\n')}` : ''}`);
      else console.log(`${reading.source.name}: ${STATUS[reading.source.readable.status]}.${reading.source.readable.notes.length ? ` ${reading.source.readable.notes.join(' ')}` : ''}`);
      return 0;
    } finally {
      await disposeTranscriber();
    }
  })
});

const refresh = defineCommand({
  name: 'sources refresh',
  flags: { force: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: names } = courseAndArguments(positionals);
    const json = !!flags.json;
    try {
      const sources = await makeSourcesReadable(dir, { ...(names.length ? { names } : {}), force: flags.force, install: true, onProgress: progress(json) });
      if (json) { printJson({ sources }); return 0; }
      if (!sources.length) console.log('No sources.');
      for (const entry of sources) console.log(line(entry));
      return 0;
    } finally {
      await disposeTranscriber();
    }
  })
});

const remove = defineCommand({
  name: 'sources remove',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [file, ...extra] } = courseAndArguments(positionals);
    if (!file || extra.length) { console.error('Usage: elabora sources remove [dir] <file> [--json]'); return 2; }
    const result = await removeSource(dir, file);
    if (flags.json) { printJson({ ok: true, ...result }); return 0; }
    console.log(`✔ Deleted for good: ${result.removed.join(', ')}.`);
    return 0;
  })
});

export const sourceCommands: CommandGroup = {
  title: 'The author\'s sources (never published)',
  help: HELP,
  commands: [list, add, read, refresh, remove],
  subcommandUsage: { sources: `Usage: elabora sources list|add|read|refresh|remove\n\n${HELP}` }
};
