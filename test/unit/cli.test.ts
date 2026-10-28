import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CODES } from '@elabora/core/diagnostics/codes';
import { listProfiles } from '@elabora/core/lms/profiles';
import { projectMarkdown } from '@elabora/core/project/markdown';
import { ELABORA_VERSION } from '@elabora/node/bundles';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { createMcpServer } from '@elabora/cli/mcp';
import { AGENT_GUIDE } from '@elabora/cli/agent-guide';
import { listAgentTools, callAgentTool } from '@elabora/cli/agent-tools';
import type { Block } from '@elabora/format';
import * as edit from '@elabora/node/edit';
import { ROOT, copyExample, readJSON, writeJSON } from '../helpers.ts';

// The command line and the MCP server as agents and skills call them: a public interface. The help
// and the MCP tool catalogue are compared with what they were (test/fixtures: change them only with
// the interface, see docs/architecture.md, Conventions); the data commands with what the libraries
// compute, on copies of the example courses.

const BIN = path.join(ROOT, 'bin/elabora.js');
const HELP = fs.readFileSync(path.join(ROOT, 'test/fixtures/cli-help.txt'), 'utf8').replace('<version>', ELABORA_VERSION);
const COURSES = ['diagnostic-reseau', 'planetary-gearset', 'orbital-rendezvous'].map((name) => ({ name, dir: copyExample(path.join(ROOT, 'examples', name)) }));
after(() => { for (const { dir } of COURSES) fs.rmSync(dir, { recursive: true, force: true }); });

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

// author: who the edits are journaled as (ELABORA_AUTHOR); input: what the command reads on stdin.
function elabora(args: string[], cwd = ROOT, { author = 'human', input = '' }: { author?: string; input?: string } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ELABORA_AUTHOR: author } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function connectMcp(dir: string, name = 'test'): Promise<Client> {
  const server = createMcpServer(dir);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name, version: '1' });
  await client.connect(clientSide);
  return client;
}

// The JSON body of a tool result (its first content is the text).
async function callJSON(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: 'text'; text: string }[];
  return JSON.parse(first.text);
}

// JSON as a command prints it: without undefined values.
const asPrinted = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test('elabora --help, help and no command print the reference', async () => {
  for (const run of await Promise.all([elabora(['--help']), elabora(['help']), elabora([])])) {
    assert.deepEqual(run, { status: 0, stdout: HELP, stderr: '' });
  }
});

test('an unknown command lists the commands on stderr, with the near ones, and exits with 2', async () => {
  const [nope, near] = await Promise.all([elabora(['nope']), elabora(['objct'])]);
  assert.equal(nope.status, 2);
  assert.match(nope.stderr, /^Unknown command "nope"\.\nCommands: init, .*validate, .*object map.*\.\nelabora --help prints the reference/s);
  assert.ok(nope.stderr.length < 4000, 'not the whole reference');
  assert.match(near.stderr, /^Unknown command "objct"\. Maybe: object new, object map, object test, object replay\./);
});

test('validate --json gives the validation of each example', async () => {
  const runs = await Promise.all(COURSES.map(({ dir }) => elabora(['validate', dir, '--json'])));
  for (const [index, { name, dir }] of COURSES.entries()) {
    const result = validateDir(dir);
    const { budget } = result.context;
    assert.equal(runs[index].status, result.ok ? 0 : 1, name);
    assert.deepEqual(JSON.parse(runs[index].stdout), asPrinted({ ok: result.ok, summary: result.summary, budget, diagnostics: result.diagnostics }), name);
  }
  // The folder defaults to the current one.
  const [first] = COURSES;
  assert.equal((await elabora(['validate', '--json'], first.dir)).stdout, runs[0].stdout);
});

test('project prints the Markdown view of each example, for agents and for the client', async () => {
  const runs = await Promise.all(COURSES.flatMap(({ dir }) => [elabora(['project', dir]), elabora(['project', dir, '--client'])]));
  for (const [index, { name, dir }] of COURSES.entries()) {
    const project = loadProjectFromDir(dir);
    assert.deepEqual(runs[2 * index], { status: 0, stdout: `${projectMarkdown(project, { audience: 'agent' })}\n`, stderr: '' }, name);
    assert.deepEqual(runs[2 * index + 1], { status: 0, stdout: `${projectMarkdown(project, { audience: 'client' })}\n`, stderr: '' }, name);
  }
});

test('codes --json and profiles --json print the catalogues', async () => {
  const [codes, profiles] = await Promise.all([elabora(['codes', '--json']), elabora(['profiles', '--json'])]);
  assert.equal(codes.status, 0);
  assert.deepEqual(JSON.parse(codes.stdout), asPrinted(CODES));
  assert.equal(profiles.status, 0);
  assert.deepEqual(JSON.parse(profiles.stdout), asPrinted(listProfiles()));
});

test('flags: unknown ones and missing values are refused; --help shows the command group', async () => {
  const [unknown, missing, valued, help] = await Promise.all([
    elabora(['validate', '--jsn']), elabora(['build', '--out']), elabora(['codes', '--json=yes']), elabora(['validate', '--help'])
  ]);
  const project = `Project\n${HELP.split('\nProject\n')[1].split('\n\n')[0]}\n`;
  // The command's own usage, not its whole group.
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /^Unknown option --jsn for "elabora validate"\.\n\nUsage:\n {2}validate \[dir\]/);
  assert.match(unknown.stderr, /\(elabora validate --help: its whole group\)\n$/);
  assert.ok(!/\n {2}project /.test(unknown.stderr), 'only validate');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^--out needs a value for "elabora build"\.\n\nUsage:\n {2}build \[dir\]/);
  assert.ok(!/\n {2}test \[dir\]/.test(missing.stderr), 'only build');
  assert.equal(valued.status, 2);
  assert.match(valued.stderr, /^--json takes no value for "elabora codes"\.\n\nUsage:\n {2}codes/);
  assert.deepEqual(help, { status: 0, stdout: project, stderr: '' });
});

test('MCP: the tool catalogue is unchanged and the skills are served', async () => {
  const client = await connectMcp(COURSES[0].dir);
  const { tools } = await client.listTools();
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/mcp-tools.json'), 'utf8'));
  assert.deepEqual(tools.map(({ name, annotations, inputSchema }) => ({ name, annotations, inputSchema })), expected);
  const { resources } = await client.listResources();
  assert.ok(resources.some((resource) => resource.uri === 'elabora://skills/elabora-course-authoring'), JSON.stringify(resources));
  await client.close();
});

test('history groups changes by batch of AI work; undo keeps what changed since; mark labels the next batch', async () => {
  const dir = copyExample();
  const agent = 'agent:claude-code';
  assert.deepEqual(await elabora(['mark', dir, 'Ajoute un quiz']), { status: 0, stdout: '✔ The next batch of AI work is labelled "Ajoute un quiz".\n', stderr: '' });
  assert.equal((await elabora(['component', 'new', dir, 'my-card'], ROOT, { author: agent })).status, 0);
  assert.equal((await elabora(['block', 'duplicate', dir, 'chemin-intro'], ROOT, { author: agent })).status, 0);
  // A person edits the copy meanwhile: undoing the batch keeps it.
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.blocks.find((block: Block) => block.id === 'chemin-intro-copy').props.markdown = 'Rewritten by hand.';
  writeJSON(dir, 'screens/chemin.json', screen);

  const history = await elabora(['history', dir]);
  assert.equal(history.status, 0);
  const [batch] = edit.historyBatches(dir, 20);
  assert.match(history.stdout, new RegExp(`· Claude Code · "Ajoute un quiz" · 2 change\\(s\\) · batch ${batch.id}\n +\\d+  created component my-card\n +\\d+  duplicated block chemin-intro\n`));
  assert.deepEqual(JSON.parse((await elabora(['history', dir, '--json'])).stdout), asPrinted(edit.historyBatches(dir, 20)));

  const undone = await elabora(['undo', dir, '--batch']);
  assert.equal(undone.status, 0, undone.stderr);
  assert.match(undone.stdout, new RegExp(`^✔ Undid batch ${batch.id} "Ajoute un quiz": 2 change\\(s\\)`));
  assert.match(undone.stdout, /\n  kept: screens\/chemin\.json blocks\[chemin-intro-copy\]: changed since\n$/);
  assert.ok(!fs.existsSync(path.join(dir, 'components/my-card/component.json')));
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks.find((block: Block) => block.id === 'chemin-intro-copy').props.markdown, 'Rewritten by hand.');
  // Undoing the undo redoes.
  const last = edit.history(dir).at(-1);
  assert.equal(last?.op, 'undo_batch');
  assert.match((await elabora(['undo', dir, '--change', String(last?.id)])).stdout, new RegExp(`^✔ Undid change ${last?.seq} \\(undo_batch\\)`));
  assert.ok(fs.existsSync(path.join(dir, 'components/my-card/component.json')));

  // A Claude Code UserPromptSubmit hook: the prompt comes as JSON on stdin; nothing is printed.
  const hook = await elabora(['mark', dir, '--stdin'], ROOT, { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'Raccourcis l\'intro' }) });
  assert.deepEqual(hook, { status: 0, stdout: '', stderr: '' });
  assert.equal((await elabora(['undo', dir, '--change', '1', '--batch'])).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP: writes are journaled as the client, return their change, and undo by change or batch', async () => {
  const dir = copyExample();
  const client = await connectMcp(dir, 'test-agent');
  const before = readJSON(dir, 'screens/chemin.json');
  const written = await callJSON(client, 'elabora_update_block', { block: 'chemin-intro', props: { markdown: 'Nouveau texte.' } });
  assert.deepEqual(Object.keys(written.change), ['id', 'seq', 'batch']);
  assert.deepEqual(edit.history(dir).at(-1)?.author, { kind: 'agent', name: 'test-agent' });
  const batches = await callJSON(client, 'elabora_history');
  assert.deepEqual(batches.at(-1).authors, [{ kind: 'agent', name: 'test-agent' }]);

  const undone = await callJSON(client, 'elabora_undo', { batch: true });
  assert.deepEqual([undone.undone, undone.skipped], [[written.change.seq], []]);
  assert.deepEqual(readJSON(dir, 'screens/chemin.json'), before);
  const redone = await callJSON(client, 'elabora_undo', { change: undone.change.seq });
  assert.equal(redone.undone, undone.change.seq);
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks[0].props.markdown, 'Nouveau texte.');
  const both = await client.callTool({ name: 'elabora_undo', arguments: { change: 1, batch: true } });
  assert.equal(both.isError, true);
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('media captions and MCP elabora_set_captions give a video its captions, as E_VIDEO_CAPTIONS_MISSING says: SubRip converted, one change, a video only', async () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push(
    { id: 'chemin-film', type: 'video', props: { asset: 'video/film.mp4', title: 'Le film', transcript: 'Marc imprime.' } },
    { id: 'chemin-suite', type: 'video', props: { asset: 'video/suite.mp4', title: 'La suite', transcript: 'Marc attend.' } }
  );
  writeJSON(dir, 'screens/chemin.json', s);
  const srt = path.join(fs.mkdtempSync(path.join(path.dirname(dir), 'elabora-srt-')), 'film.srt');
  fs.writeFileSync(srt, '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nMarc clique sur Imprimer.\r\n');
  const missing = () => validateDir(dir).diagnostics.filter((d) => d.code === 'E_VIDEO_CAPTIONS_MISSING').map((d) => d.target);
  const captionsOf = (block: string) => readJSON(dir, 'screens/chemin.json').blocks.find((candidate: Block) => candidate.id === block).props.captions;
  assert.deepEqual(missing(), ['chemin-film', 'chemin-suite']);
  assert.match(CODES.E_VIDEO_CAPTIONS_MISSING.fix, /elabora media captions \. <block> <file\.vtt\|\.srt>`, MCP elabora_set_captions/);

  // The command line: the file converted under assets/captions/, the block naming it, undoable.
  const run = await elabora(['media', 'captions', dir, 'chemin-film', srt, '--json']);
  assert.equal(run.status, 0, run.stderr);
  const printed = JSON.parse(run.stdout);
  assert.deepEqual([printed.ok, printed.block, printed.captions, printed.files.sort()], [true, 'chemin-film', 'captions/chemin-film.vtt', ['assets/captions/chemin-film.vtt', 'screens/chemin.json']]);
  assert.equal(fs.readFileSync(path.join(dir, 'assets/captions/chemin-film.vtt'), 'utf8'), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nMarc clique sur Imprimer.\n');
  assert.equal(captionsOf('chemin-film'), 'captions/chemin-film.vtt');
  assert.deepEqual(missing(), ['chemin-suite']);
  assert.equal(edit.history(dir).at(-1)?.op, 'set_captions');
  // Again: nothing changes. Refused: a block that is not a video, a file that is not there, a missing argument.
  const [again, text, absent, usage] = await Promise.all([
    elabora(['media', 'captions', dir, 'chemin-film', srt]), elabora(['media', 'captions', dir, 'chemin-intro', srt]),
    elabora(['media', 'captions', dir, 'chemin-film', path.join(dir, 'nothing.srt')]), elabora(['media', 'captions', dir, 'chemin-film'])
  ]);
  assert.deepEqual(again, { status: 0, stdout: '✔ chemin-film already has these captions (assets/captions/chemin-film.vtt): nothing changed.\n', stderr: '' });
  assert.deepEqual([text.status, text.stderr], [1, '✘ Block "chemin-intro" is a text block: captions go on a video.\n']);
  assert.deepEqual([absent.status, absent.stderr], [1, `✘ No file ${path.join(dir, 'nothing.srt')}.\n`]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^Usage: elabora media captions \[dir\] <block> <file\.vtt\|\.srt>/);

  // MCP: the text itself, or a file by its absolute path, as the client; undone by its change.
  const client = await connectMcp(dir, 'test-agent');
  const written = await callJSON(client, 'elabora_set_captions', { block: 'chemin-suite', text: 'WEBVTT\n\n00:00.000 --> 00:01.000\nMarc attend.' });
  assert.deepEqual([written.op, written.captions, written.files.sort()], ['set_captions', 'captions/chemin-suite.vtt', ['assets/captions/chemin-suite.vtt', 'screens/chemin.json']]);
  assert.deepEqual(edit.history(dir).at(-1)?.author, { kind: 'agent', name: 'test-agent' });
  assert.deepEqual(missing(), []);
  const named = await callJSON(client, 'elabora_set_captions', { block: 'chemin-suite', file: srt, name: 'La suite (FR)' });
  assert.equal(named.captions, 'captions/la-suite-fr.vtt');
  assert.equal(captionsOf('chemin-suite'), 'captions/la-suite-fr.vtt');
  await callJSON(client, 'elabora_undo', { change: named.change.seq });
  assert.equal(captionsOf('chemin-suite'), 'captions/chemin-suite.vtt');
  assert.ok(!fs.existsSync(path.join(dir, 'assets/captions/la-suite-fr.vtt')));
  for (const args of [{ block: 'chemin-suite' }, { block: 'chemin-suite', file: srt, text: 'WEBVTT' }, { block: 'chemin-intro', file: srt }, { block: 'chemin-suite', text: 'Pas de sous-titres.' }]) {
    const refused = await client.callTool({ name: 'elabora_set_captions', arguments: args });
    assert.equal(refused.isError, true, JSON.stringify(args));
  }
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.dirname(srt), { recursive: true, force: true });
});

test('MCP: words found and replaced, a screen duplicated, a variable renamed and kept while used', async () => {
  const dir = copyExample();
  const client = await connectMcp(dir, 'test-agent');
  const found = await callJSON(client, 'elabora_find_text', { query: 'pare-feu' });
  const title = found.find((match: { unit: string }) => match.unit === 'block.chemin-roles.items.pare-feu.title');
  assert.equal(title?.screen, 'chemin');
  const replaced = await callJSON(client, 'elabora_replace_text', { find: 'pare-feu', replace: 'firewall', units: [title.unit] });
  assert.deepEqual([replaced.replaced, replaced.units], [1, [title.unit]]);
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks.find((block: Block) => block.id === 'chemin-roles').props.items.find((item: { id: string }) => item.id === 'pare-feu').title, 'Le firewall');
  const copy = await callJSON(client, 'elabora_duplicate_screen', { id: 'chemin' });
  assert.equal(copy.screen, 'chemin-copy');
  await callJSON(client, 'elabora_rename_variable', { from: 'indiceVu', to: 'aideVue' });
  assert.ok(readJSON(dir, 'course.json').variables.some((variable: { id: string }) => variable.id === 'aideVue'));
  const used = await client.callTool({ name: 'elabora_remove_variable', arguments: { id: 'aideVue' } });
  assert.equal(used.isError, true, 'an event still uses it');
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP: a language as a bilingual table, texts translated into it in one change', async () => {
  const dir = copyExample();
  const client = await connectMcp(dir, 'test-agent');
  const table = await callJSON(client, 'elabora_translation_table', { language: 'en', screen: 'chemin' });
  assert.deepEqual([table.source, table.exists, table.progress.translated], ['fr', false, 0]);
  const rule = table.rows.find((row: { unit: string }) => row.unit === 'plan.text.TXT-2');
  assert.deepEqual([rule?.block, rule?.field, rule?.status], ['chemin-regle', 'markdown', 'to-translate']);
  const translated = await callJSON(client, 'elabora_translate_text', { language: 'en', texts: [{ unit: 'screen.chemin.title', target: 'The path of a print job' }, { unit: 'block.chemin-regle.title', target: 'Rule SUP-NET-04' }] });
  assert.deepEqual([translated.op, translated.language, translated.units], ['translate_text', 'en', ['screen.chemin.title', 'block.chemin-regle.title']]);
  assert.ok(translated.undo, 'one change to undo');
  const after = await callJSON(client, 'elabora_translation_table', { language: 'en', todo: true });
  assert.equal(after.exists, true);
  assert.equal(after.progress.translated, 2);
  assert.equal(after.rows.length, after.progress.units - 2, 'what asks for something');
  assert.ok(!after.rows.some((row: { unit: string }) => row.unit === 'screen.chemin.title'));
  const unknown = await client.callTool({ name: 'elabora_translate_text', arguments: { language: 'en', texts: [{ unit: 'nothing.here', target: 'x' }] } });
  assert.equal(unknown.isError, true);
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI agent operations: MCP discovery, read results, validation and errors agree', async () => {
  const dir = copyExample();
  const client = await connectMcp(dir, 'test-agent');
  try {
    const listed = await elabora(['tools', 'list', '--json']);
    assert.equal(listed.status, 0);
    assert.deepEqual(JSON.parse(listed.stdout), asPrinted(await client.listTools()));
    const args = { language: 'en', screen: 'chemin' };
    const read = await elabora(['tools', 'call', 'elabora_translation_table', dir, '--from', '-', '--raw'], ROOT, { input: JSON.stringify(args) });
    assert.equal(read.status, 0);
    assert.deepEqual(JSON.parse(read.stdout), asPrinted(await client.callTool({ name: 'elabora_translation_table', arguments: args })));
    for (const [name, args] of [['elabora_translate_text', { language: 'en', texts: [] }], ['elabora_nothing', {}]] as const) {
      const run = await elabora(['tools', 'call', name, dir, '--from', '-', '--raw'], ROOT, { input: JSON.stringify(args) });
      assert.equal(run.status, 1);
      assert.deepEqual(JSON.parse(run.stdout), asPrinted(await client.callTool({ name, arguments: args })));
    }
    const malformed = await elabora(['tools', 'call', 'elabora_overview', dir, '--from', '-', '--raw'], ROOT, { input: '{' });
    assert.equal(malformed.status, 2);
    assert.equal(JSON.parse(malformed.stdout).isError, true);
    const flag = await elabora(['tools', 'call', 'elabora_overview', dir, '--jsn', '--raw']);
    assert.equal(flag.status, 2);
    assert.match(JSON.parse(flag.stdout).content[0].text, /Unknown option/);
    const missing = await elabora(['tools', 'call', 'elabora_overview', path.join(dir, 'absent'), '--raw']);
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stdout).content[0].text, /no course.json/);
    // Without --raw: the tool's own JSON, arguments inline, and errors as { error }.
    const plain = await elabora(['tools', 'call', 'elabora_translation_table', dir, '--args', JSON.stringify(args)]);
    assert.equal(plain.status, 0);
    assert.deepEqual(JSON.parse(plain.stdout), await callJSON(client, 'elabora_translation_table', args));
    const both = await elabora(['tools', 'call', 'elabora_overview', dir, '--args', '{}', '--from', '-'], ROOT, { input: '{}' });
    assert.equal(both.status, 2);
    assert.match(JSON.parse(both.stdout).error, /not both/);
    const unknown = await elabora(['tools', 'call', 'elabora_nothing', dir]);
    assert.equal(unknown.status, 1);
    assert.equal(typeof JSON.parse(unknown.stdout).error, 'string');
    const overview = await elabora(['tools', 'call', 'elabora_overview', dir]);
    assert.equal(overview.status, 0);
    assert.match(overview.stdout, /^# /);
  } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI agent edits are journaled, visible to MCP and undoable; read-only refuses writes', async () => {
  const dir = copyExample();
  const client = await connectMcp(dir, 'test-agent');
  try {
    const argsFile = path.join(dir, '.elabora', 'agent-arguments.json');
    fs.mkdirSync(path.dirname(argsFile), { recursive: true });
    fs.writeFileSync(argsFile, JSON.stringify({ language: 'en', texts: [{ unit: 'screen.chemin.title', target: 'Print path' }] }));
    const refused = await elabora(['tools', 'call', 'elabora_translate_text', dir, '--from', argsFile, '--read-only']);
    assert.equal(refused.status, 1);
    assert.equal(fs.existsSync(path.join(dir, 'translations/en.xlf')), false);
    const run = await elabora(['tools', 'call', 'elabora_translate_text', dir, '--from', argsFile], ROOT, { author: 'agent:shell-test' });
    assert.equal(run.status, 0);
    const editResult = JSON.parse(run.stdout);
    assert.ok(editResult.change.id);
    assert.equal((await callJSON(client, 'elabora_translation_table', { language: 'en' })).progress.translated, 1);
    await callJSON(client, 'elabora_undo', { change: editResult.change.id });
    assert.equal(fs.existsSync(path.join(dir, 'translations/en.xlf')), false);
    const listed = await elabora(['tools', 'list', '--json', '--read-only']);
    assert.ok(JSON.parse(listed.stdout).tools.every((tool: any) => tool.annotations.readOnlyHint));
    assert.ok(!JSON.parse(listed.stdout).tools.some((tool: any) => tool.name === 'elabora_translate_text'));
  } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent translation workflow: readiness, validation and packaging stay scoped to the source', async () => {
  const dir = copyExample();
  const originalTitle = readJSON(dir, 'screens/chemin.json').title;
  const client = await connectMcp(dir, 'translation-agent');
  try {
    const before = await callJSON(client, 'elabora_translation_status', { language: 'en' });
    assert.deepEqual(before.languages, [{ language: 'en', exists: false, ready: false }]);
    const status = await elabora(['translate', 'status', dir, '--to', 'en', '--json']);
    assert.equal(status.status, 1, 'JSON status has the same readiness exit code as text');
    assert.deepEqual(JSON.parse(status.stdout), [{ language: 'en', exists: false }]);
    const table = await callJSON(client, 'elabora_translation_table', { language: 'en' });
    const one = { unit: 'screen.chemin.title', target: 'The print path' };
    await callJSON(client, 'elabora_translate_text', { language: 'en', texts: [one] });
    const incomplete = await client.callTool({ name: 'elabora_build', arguments: { language: 'en' } });
    assert.equal(incomplete.isError, true, 'missing texts require an explicit draft');
    const draft = await callJSON(client, 'elabora_validate', { language: 'en', allowMissing: true });
    assert.ok(draft.translation.untranslated > 0);
    const texts = table.rows.map((row: { unit: string; source: string }) => row.unit === one.unit ? one : { unit: row.unit, target: row.source });
    await callJSON(client, 'elabora_translate_text', { language: 'en', texts });
    const ready = await callJSON(client, 'elabora_translation_status', {});
    assert.equal(ready.languages[0].ready, true);
    assert.equal(ready.languages[0].plan, 'not approved');
    const valid = await callJSON(client, 'elabora_validate', { language: 'en' });
    assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));
    const release = await client.callTool({ name: 'elabora_build', arguments: { language: 'en', release: true } });
    assert.equal(release.isError, true, 'a failed build sets the protocol failure flag');
    const built = await callJSON(client, 'elabora_build', { language: 'en' });
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    assert.equal(built.translation.language, 'en');
    assert.equal(built.translation.untranslated, 0);
    assert.equal(path.dirname(built.zip), path.join(dir, 'dist'));
    assert.ok(fs.statSync(built.zip).size > 0);
    assert.equal(readJSON(dir, 'course.json').language, 'fr', 'source language unchanged');
    assert.equal(readJSON(dir, 'screens/chemin.json').title, originalTitle);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.elabora', 'translations')), [], 'derived copies removed after successful and refused calls');
    const source = readJSON(dir, 'screens/chemin.json');
    writeJSON(dir, 'screens/chemin.json', { ...source, title: 'Un nouveau titre' });
    assert.equal((await callJSON(client, 'elabora_translation_status', { language: 'en' })).languages[0].ready, false);
  } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent guide agrees across transports and references available operations', async () => {
  const tools = listAgentTools();
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, 'unique operation names');
  for (const workflow of AGENT_GUIDE.workflows) {
    for (const name of workflow.tools) assert.ok(tools.some((tool) => tool.name === name), `${workflow.id}: ${name}`);
  }
  const cli = await elabora(['tools', 'guide', '--json']);
  assert.equal(cli.status, 0);
  assert.deepEqual(JSON.parse(cli.stdout), asPrinted(AGENT_GUIDE));
  const dir = copyExample();
  const client = await connectMcp(dir);
  try { assert.deepEqual(await callJSON(client, 'elabora_agent_guide'), asPrinted(AGENT_GUIDE)); }
  finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('host tool selection constrains both discovery and calls, intersects read-only and is fixed per connection', async () => {
  const dir = copyExample();
  const selected = ['elabora_translation_table'];
  const server = createMcpServer(dir, { tools: selected });
  selected.push('elabora_translate_text'); // The host must reconnect to change a live selection.
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'limited-plugin', version: '1' });
  await client.connect(clientSide);
  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['elabora_translation_table']);
    const read = await callJSON(client, 'elabora_translation_table', { language: 'en' });
    assert.equal(read.exists, false);
    assert.equal((await client.callTool({ name: 'elabora_translate_text', arguments: { language: 'en', texts: [{ unit: 'screen.chemin.title', target: 'Print' }] } })).isError, true);
    assert.equal(fs.existsSync(path.join(dir, 'translations/en.xlf')), false);
    assert.deepEqual(listAgentTools({ tools: selected, readOnly: true }).map((tool) => tool.name), ['elabora_translation_table']);
    assert.deepEqual(listAgentTools({ tools: [] }), []);
    assert.throws(() => createMcpServer(dir, { tools: ['elabora_typo'] }), /Unknown agent tools/);
    const embedded = await callAgentTool('elabora_translate_text', {}, { root: dir, author: { kind: 'agent', name: 'plugin' } }, { tools: [] });
    assert.equal(embedded.isError, true);
    const preview = await elabora(['tools', 'list', '--tools', 'elabora_translation_table', '--json']);
    assert.deepEqual(JSON.parse(preview.stdout), asPrinted(await client.listTools()));
  } finally { await client.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('translation CLI writes share the journal and human approval guard with embedded commands', async () => {
  const dir = copyExample();
  const client = await connectMcp(dir);
  try {
    const exported = await elabora(['translate', 'export', dir, '--to', 'en', '--json'], ROOT, { author: 'agent:translator' });
    assert.equal(exported.status, 0, exported.stderr);
    const result = JSON.parse(exported.stdout);
    assert.ok(result.change.id);
    assert.equal(edit.history(dir).at(-1)?.op, 'export_translation');
    await callJSON(client, 'elabora_undo', { change: result.change.id });
    assert.equal(fs.existsSync(path.join(dir, 'translations/en.xlf')), false);
    const table = await callJSON(client, 'elabora_translation_table', { language: 'en' });
    await callJSON(client, 'elabora_translate_text', { language: 'en', texts: table.rows.map((row: { unit: string; source: string }) => ({ unit: row.unit, target: row.source })) });
    const refused = await elabora(['translate', 'approve', dir, '--to', 'en', '--by', 'Invented approver', '--json'], ROOT, { author: 'agent:translator' });
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).ok, false);
    assert.match(JSON.parse(refused.stdout).error, /Only a person/);
    assert.equal(fs.existsSync(path.join(dir, 'translations/en.approval.json')), false);
    const human = await elabora(['translate', 'approve', dir, '--to', 'en', '--by', 'Actual approver', '--json'], ROOT, { author: 'human:Actual approver' });
    assert.equal(human.status, 0, human.stderr);
    assert.equal(JSON.parse(human.stdout).by, 'Actual approver');
    const approval = edit.history(dir).at(-1)!;
    assert.equal(approval.op, 'approve_translation');
    await callJSON(client, 'elabora_undo', { change: approval.seq });
    assert.equal(fs.existsSync(path.join(dir, 'translations/en.approval.json')), false);
    const failedBuild = await elabora(['translate', 'build', dir, '--to', 'de', '--out', path.join(dir, 'dist', 'de'), '--json']);
    assert.equal(failedBuild.status, 1);
    assert.equal(JSON.parse(failedBuild.stdout).ok, false);
  } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('external MCP clients connect over stdio with the CLI-selected read-only catalogue', async () => {
  const dir = copyExample();
  const client = new Client({ name: 'external-plugin', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', dir, '--read-only', '--tools', 'elabora_translation_table,elabora_translate_text'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['elabora_translation_table']);
    assert.equal((await callJSON(client, 'elabora_translation_table', { language: 'en' })).exists, false);
    const refused = await client.callTool({ name: 'elabora_translate_text', arguments: { language: 'en', texts: [{ unit: 'screen.chemin.title', target: 'Print' }] } });
    assert.equal(refused.isError, true);
    assert.equal(fs.existsSync(path.join(dir, 'translations/en.xlf')), false);
  } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migrate says a course in the current format needs nothing and refuses a newer one; rename gives an element another id', async () => {
  const dir = copyExample();
  assert.equal((await elabora(['migrate', dir])).stdout, '✔ The course is in elabora/0.1 already: nothing to migrate.\n');
  const course = readJSON(dir, 'course.json');
  writeJSON(dir, 'course.json', { ...course, format: 'elabora/9.0' });
  const newer = await elabora(['migrate', dir]);
  assert.equal(newer.status, 1);
  assert.match(newer.stderr, /elabora\/9\.0, newer than the one this version of Elabora reads \(elabora\/0\.1\)/);
  writeJSON(dir, 'course.json', course);

  const renamed = await elabora(['rename', dir, 'evaluation', 'quiz-final']);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.match(renamed.stdout, /^✔ Renamed screen evaluation to quiz-final: 2 reference\(s\) and 4 file\(s\) \(course\.json, elabora\.lock\.json, screens\/evaluation\.json, screens\/quiz-final\.json\)\. elabora undo reverts it\.\n$/);
  const history = await elabora(['history', dir]);
  assert.match(history.stdout, / +1 {2}renamed evaluation to quiz-final\n/);
  const taken = await elabora(['rename', dir, 'bilan', 'quiz-final']);
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /^✘ Id "quiz-final" is already used in the course/);
  assert.equal((await elabora(['rename', 'bilan'], dir)).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP: elabora_rename renames as the client', async () => {
  const dir = copyExample();
  const client = await connectMcp(dir, 'test-agent');
  const result = await callJSON(client, 'elabora_rename', { from: 'simulation-bravo', to: 'simulation-felicitations' });
  assert.deepEqual(result.renamed, { kind: 'block', from: 'simulation-bravo', to: 'simulation-felicitations', screen: 'simulation', references: 2 });
  assert.equal(result.formatMigration, undefined);
  assert.equal(readJSON(dir, 'screens/simulation.json').events[1].do[0].block, 'simulation-felicitations');
  assert.deepEqual(edit.history(dir).map((entry) => [entry.op, entry.author]), [['rename', { kind: 'agent', name: 'test-agent' }]]);
  const refused = await client.callTool({ name: 'elabora_rename', arguments: { from: 'bilan', to: 'Bilan' } });
  assert.equal(refused.isError, true);
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP: prepare a narrated screen with pronunciations and undo the script without touching the plan', async () => {
  const dir = copyExample();
  const client = await connectMcp(dir, 'narration-author');
  const plan = fs.readFileSync(path.join(dir, 'plan.json'), 'utf8');
  try {
    const speakers = [{ id: 'guide', name: 'Guide' }];
    const course = await callJSON(client, 'elabora_update_course', {
      speakers, pronunciations: { fr: [{ text: 'IP', say: 'i pé' }] }, narration: { advance: 'learner', seek: 'seen' }
    });
    assert.ok(course.ok, JSON.stringify(course));
    const voice = await callJSON(client, 'elabora_voice_set', { speaker: 'guide', voice: 'claire' });
    assert.ok(voice.ok, JSON.stringify(voice));
    const settings = readJSON(dir, 'course.json');
    assert.deepEqual(settings.speakers[0].voices.fr, { provider: 'pocket-tts', voice: 'claire' });
    assert.deepEqual(settings.pronunciations, { fr: [{ text: 'IP', say: 'i pé' }] });
    assert.deepEqual(settings.narration, { advance: 'learner', seek: 'seen' });
    const narration = { lines: [{ id: 'l1', speaker: 'guide', text: 'Vérifiez la connexion IP du poste.' }] };
    const script = await callJSON(client, 'elabora_update_screen', { id: 'accueil', narration });
    assert.ok(script.ok, JSON.stringify(script));
    assert.deepEqual(readJSON(dir, 'screens/accueil.json').narration, narration);
    const timeline = await callJSON(client, 'elabora_timeline', { screen: 'accueil' });
    assert.equal(timeline.steps[0].lines[0].audio, 'missing');
    const invalid = await callJSON(client, 'elabora_update_screen', { id: 'accueil', narration: { lines: [{ id: 'l1' }] } });
    assert.ok(invalid.error, JSON.stringify(invalid));
    assert.deepEqual(readJSON(dir, 'screens/accueil.json').narration, narration, 'invalid script is refused before writing');
    const removed = await callJSON(client, 'elabora_update_screen', { id: 'accueil', narration: null });
    assert.ok(removed.ok, JSON.stringify(removed));
    assert.equal(readJSON(dir, 'screens/accueil.json').narration, undefined);
    await callJSON(client, 'elabora_undo', { change: removed.change.seq });
    assert.deepEqual(readJSON(dir, 'screens/accueil.json').narration, narration);
    assert.equal(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'), plan);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshot: --out names one image; several shots are refused before anything is built or written, and --out-dir is the way', async () => {
  const dir = COURSES[0].dir;
  const cwd = fs.mkdtempSync(path.join(path.dirname(dir), 'elabora-cwd-'));
  try {
    const screens = loadProjectFromDir(dir).screens.size;
    assert.ok(screens > 1);
    const several = await elabora(['screenshot', dir, '--screen', 'all', '--out', path.join(cwd, 'shot.png')], cwd);
    assert.equal(several.status, 2);
    assert.equal(several.stdout, '');
    assert.match(several.stderr, new RegExp(`^✘ --out names one image, and ${screens} shots were asked \\(${screens} screen\\(s\\) × 1 size\\(s\\) × 1 state\\(s\\)\\): give --out-dir <dir>`));
    const both = await elabora(['screenshot', dir, '--screen', 'accueil', '--out', 'a.png', '--out-dir', 'shots'], cwd);
    assert.deepEqual([both.status, both.stdout, both.stderr], [2, '', '✘ Give --out (one image) or --out-dir (a folder), not both.\n']);
    assert.deepEqual(fs.readdirSync(cwd), [], 'nothing written where the command ran');
    assert.ok(!fs.existsSync(path.join(dir, 'screenshots')), 'nor in the course');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('elabora init keeps what the author already said: audience, business goal, duration, presentation, LMS and notes (D51)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-init-brief-'));
  try {
    const dir = path.join(root, 'c');
    const made = await elabora(['init', dir, '--id', 'incident', '--title', 'Incident réseau', '--audience', 'Techniciens support', '--business-goal', 'Moins de tickets transférés',
      '--duration', '10-20', '--presentation', 'slides', '--lms', 'moodle,totara', '--notes', '- Ton : direct.']);
    assert.equal(made.status, 0, made.stderr);
    const plan = readJSON(dir, 'plan.json');
    assert.deepEqual([plan.audience.role, plan.businessGoal, plan.duration], ['Techniciens support', 'Moins de tickets transférés', { min: 10, max: 20 }]);
    assert.deepEqual([readJSON(dir, 'course.json').presentation, readJSON(dir, 'course.json').delivery], [{ mode: 'slides' }, { lms: ['moodle', 'totara'] }]);
    assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').endsWith('\n- Ton : direct.\n'));
    assert.equal((await elabora(['init', path.join(root, 'd'), '--id', 'long', '--title', 'Long', '--duration', '30+'])).status, 0);
    assert.deepEqual(readJSON(path.join(root, 'd'), 'plan.json').duration, { min: 30 });
    const refused = await elabora(['init', path.join(root, 'e'), '--id', 'refus', '--title', 'Refus', '--duration', 'vingt minutes']);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--duration: minutes as 10-20, 5 or 30\+/);
    assert.equal(fs.existsSync(path.join(root, 'e')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP and CLI: the agent writes the plan at any time; a person makes and validates its versions; a text kept « à l\'identique » is the author\'s (D52)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-versions-'));
  const dir = path.join(root, 'c');
  try {
    assert.equal((await elabora(['init', dir, '--id', 'grande-sante', '--title', 'La grande santé'])).status, 0);
    const client = await connectMcp(dir, 'claude-code');
    try {
      assert.match((await callJSON(client, 'elabora_get_plan')).versions.summary, /^no version yet/);
      const plan = { ...readJSON(dir, 'plan.json'), objectives: [{ id: 'OBJ-1', statement: 'Expliquer ce que Nietzsche appelle la grande santé à partir d’un extrait.' }], items: [{ id: 'ITEM-1', kind: 'intro', title: 'La maladie comme épreuve', objectives: ['OBJ-1'], lockedTexts: [{ id: 'TXT-1', text: 'Ce qui ne me tue pas me rend plus fort.', verbatim: true }] }] };
      const written = await client.callTool({ name: 'elabora_write_plan', arguments: { plan } });
      assert.notEqual(written.isError, true, JSON.stringify(written.content));
      assert.equal(readJSON(dir, 'plan.json').items[0].title, 'La maladie comme épreuve');
      await callJSON(client, 'elabora_set_plan_voiceover', { item: 'ITEM-1', lines: [{ text: 'Ce qui ne me tue pas me rend plus fort.' }] });
      assert.equal(readJSON(dir, 'plan.json').items[0].voiceover[0].text, 'Ce qui ne me tue pas me rend plus fort.');
      // No tool makes or validates a version.
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).filter((name) => /version|approve|validate_plan/.test(name)), []);
      // The CLI: a patch, the status; versions refused to an agent, a person's.
      fs.writeFileSync(path.join(root, 'patch.json'), JSON.stringify([{ op: 'add', path: '/spacing', value: ['J+2'] }]));
      const patched = await elabora(['plan', 'write', dir, '--patch', path.join(root, 'patch.json')], ROOT, { author: 'agent:claude-code' });
      assert.equal(patched.status, 0, patched.stderr);
      assert.match(patched.stdout, /^✔ Plan PLAN-[A-Z0-9-]+: 1 objective\(s\), 1 item\(s\)\..* Versions: no version yet/);
      const agentVersion = await elabora(['plan', 'version', dir], ROOT, { author: 'agent:claude-code' });
      assert.notEqual(agentVersion.status, 0);
      assert.match(agentVersion.stderr, /Only a person makes a version of the plan/);
      const v1 = await elabora(['plan', 'version', dir, '--note', 'Premier envoi']);
      assert.equal(v1.status, 0, v1.stderr);
      assert.match(v1.stdout, /^✔ V1 made \(hash sha256:[0-9a-f]{64}\)\. Send it: elabora plan export \. --version V1/);
      const approved = await elabora(['plan', 'approve', dir, '--by', 'L’auteur', '--reference', 'Relu le 16 octobre']);
      assert.equal(approved.status, 0, approved.stderr);
      assert.match(approved.stdout, /^✔ V1 validated by L’auteur\. Versions: V1 validated by L’auteur on \d{4}-\d{2}-\d{2}\./);
      // Validated, the agent still writes; the diff and the status say what changed.
      const changed = await callJSON(client, 'elabora_write_plan', { patch: [{ op: 'replace', path: '/items/0/title', value: 'La maladie, une épreuve' }] });
      assert.ok(changed.change);
      const diff = await callJSON(client, 'elabora_plan_diff');
      assert.deepEqual([diff.from, diff.to, diff.changes.map((change: { key: string }) => change.key)], [1, null, ['item:ITEM-1']]);
      const verbatim = await client.callTool({ name: 'elabora_write_plan', arguments: { patch: [{ op: 'replace', path: '/items/0/lockedTexts/0/text', value: 'Ce qui ne me tue pas me fortifie.' }] } });
      assert.equal(verbatim.isError, true);
      assert.match((verbatim.content as { text: string }[])[0].text, /TXT-1 is kept « à l'identique ».*Ask the author/);
      const validated = await callJSON(client, 'elabora_validate', { release: true });
      assert.ok(validated.diagnostics.some((d: { code: string }) => d.code === 'W_PLAN_MODIFIED_SINCE_VALIDATION'));
      assert.ok(!validated.diagnostics.some((d: { code: string }) => d.code === 'E_PLAN_NOT_APPROVED'));
      assert.match((await elabora(['plan', 'status', dir])).stdout, /V1 validated by L’auteur on \d{4}-\d{2}-\d{2} · 1 change\(s\) since\n  V1  made \d{4}-\d{2}-\d{2} · validated by L’auteur on .* \(Relu le 16 octobre\) · « Premier envoi »/);
      assert.match((await elabora(['plan', 'diff', dir])).stdout, /^From V1 to the working copy: 1 change\(s\): 0 added, 0 removed, 1 changed\.\n  item:ITEM-1  changed « La maladie, une épreuve » \(fields title\)\n$/);
      const noted = await elabora(['plan', 'note', dir, 'item:ITEM-1', '--text', 'Plus clair.']);
      assert.equal(noted.status, 0, noted.stderr);
      const reverted = await elabora(['plan', 'revert', dir, 'item:ITEM-1']);
      assert.equal(reverted.status, 0, reverted.stderr);
      assert.match(reverted.stdout, /^✔ item:ITEM-1 is as in V1 again\./);
      assert.equal(readJSON(dir, 'plan.json').items[0].title, 'La maladie comme épreuve');
    } finally {
      await client.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bundled skills are discoverable and readable through CLI and MCP on demand', async () => {
  const listing = await elabora(['tools', 'skills', '--json']);
  assert.equal(listing.status, 0);
  const skills: { name: string; references: string[] }[] = JSON.parse(listing.stdout).skills;
  for (const name of ['elabora-course-authoring', 'elabora-narration', 'elabora-translation', 'elabora-importing', 'elabora-visual-design']) {
    assert.ok(skills.some((entry) => entry.name === name), name);
  }
  assert.ok(skills.find((entry) => entry.name === 'elabora-narration')?.references.includes('voice-and-timing'));
  const loaded = await elabora(['tools', 'skills', 'elabora-narration', 'voice-and-timing']);
  assert.equal(loaded.status, 0);
  assert.match(loaded.stdout, /elabora_voice_generate/);
  const invalid = await elabora(['tools', 'skills', 'elabora-narration', '../agent-guide']);
  assert.equal(invalid.status, 2, 'no traversal of bundled skills');
  const dir = copyExample();
  const client = await connectMcp(dir);
  try {
    const { resources } = await client.listResources();
    const uri = 'elabora://skills/elabora-narration/references/voice-and-timing';
    assert.ok(resources.some((resource) => resource.uri === uri));
    const resource = await client.readResource({ uri });
    assert.ok('text' in resource.contents[0], 'skill references are text resources');
    assert.equal(resource.contents[0].text, loaded.stdout);
    // A host that shows tools but not resources reads the same text through elabora_docs (D53).
    const viaDocs = await client.callTool({ name: 'elabora_docs', arguments: { page: 'skills/elabora-narration/voice-and-timing' } });
    assert.equal((viaDocs.content as { text: string }[])[0].text, loaded.stdout);
    const viaDocsOnce = await client.callTool({ name: 'elabora_docs', arguments: { page: 'skills/elabora-narration/references/voice-and-timing' } });
    assert.equal((viaDocsOnce.content as { text: string }[])[0].text, loaded.stdout);
    const skill = await elabora(['tools', 'skills', 'elabora-course-authoring']);
    const viaDocsSkill = await client.callTool({ name: 'elabora_docs', arguments: { page: 'skills/elabora-course-authoring' } });
    assert.equal((viaDocsSkill.content as { text: string }[])[0].text, skill.stdout);
    const cli = await elabora(['docs', 'skills/elabora-course-authoring']);
    assert.equal(cli.stdout, skill.stdout + '\n', 'the CLI docs command serves skills too');
  } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MCP instructions: the plan is written with elabora_write_plan, versions are the author\'s, skills have a route without resources', async () => {
  const client = await connectMcp(COURSES[0].dir);
  try {
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /elabora_write_plan[^.]*even after a validation/);
    assert.match(instructions, /no tool creates or validates a plan version/);
    assert.match(instructions, /personal data: quote only what the module needs/);
    assert.match(instructions, /Without resources, elabora_docs \{ page: "skills\/<name>/);
    assert.doesNotMatch(instructions, /1%/, 'the quota threshold has one source: the elabora-narration skill');
  } finally { await client.close(); }
});

test('look --act: actions keep their commas (a repeat flag) and are read before any browser', async () => {
  const { parseArguments } = await import('@elabora/cli/arguments');
  const { parseLookAction } = await import('@elabora/node/look-client');
  const { flags } = parseArguments(['--act', 'click:Greco, north-east', '--act=drag:0.2,0.5->0.8,0.5', '--scroll', '0,50%'], { act: 'repeat', scroll: 'list' });
  assert.deepEqual(flags, { act: ['click:Greco, north-east', 'drag:0.2,0.5->0.8,0.5'], scroll: ['0', '50%'] });
  assert.deepEqual(flags.act?.map(parseLookAction), [
    { kind: 'click', source: 'click:Greco, north-east', text: 'Greco, north-east' },
    { kind: 'drag', source: 'drag:0.2,0.5->0.8,0.5', from: [0.2, 0.5], to: [0.8, 0.5] }
  ]);
  assert.deepEqual(parseLookAction('click:role=button[name=Sail]'), { kind: 'click', source: 'click:role=button[name=Sail]', role: 'button', name: 'Sail' });
  assert.deepEqual(parseLookAction('key:Enter'), { kind: 'key', source: 'key:Enter', key: 'Enter' });
  assert.deepEqual(parseLookAction('choose:b'), { kind: 'choose', source: 'choose:b', option: 'b' });
  assert.match((parseLookAction('choose:Not an id') as { error: string }).error, /choose:<option> for a dialogue/);
  assert.match((parseLookAction('drag:0.2,0.5->1.4,0.5') as { error: string }).error, /^Action "drag:0\.2,0\.5->1\.4,0\.5": click:<text>/);
  const run = await elabora(['look', COURSES[0].dir, '--act', 'tap:here']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^Action "tap:here": /);
  assert.deepEqual(await elabora(['look', COURSES[0].dir, '--act', 'key:Enter']), { status: 2, stdout: '', stderr: '--act drives the free object of a block, or chooses in a dialogue block: give --block <id>.\n' });
});
