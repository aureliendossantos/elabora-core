// ELABORA_CLOUD_URL=<test server> ELABORA_CLOUD_KEY_FILE=<a session's token file> \
//   node scripts/cloud-sync-trial.ts --team <id> [--example coffee-in-brief] [--rounds 12] [--burst 100] [--keep]
//
// A real trial of a project in the cloud (docs/architecture/sync.md, D83), on a test server only:
// an example of the core (CC0) becomes a project of the team (elabora cloud project create), a second
// folder clones it, and two `elabora cloud project sync --watch` keep them in sync while, at once, a
// person edits the first through the command line, an agent edits the second through the MCP
// tools, and files of both are written by hand (an agent's own tools, from a read made earlier).
// One copy is stopped a while and started again (offline, then back). Then: an agent's burst of
// changes, timed from its first change to the moment the other folder holds them all.
// It affirms that both folders end the same (JSON by value, other files byte for byte), both
// validate with no error the project did not have, and the room's head is the same for both.
// It goes through the network: it belongs to no test suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '@elabora/cli/mcp';
import { projectsApi } from '@elabora/node/cloud/projects';
import { validateDir } from '@elabora/node/project-reader';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/elabora.js');
const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const team = flag('team');
const example = flag('example') ?? 'coffee-in-brief';
const rounds = Number(flag('rounds') ?? 12);
const burst = Number(flag('burst') ?? 100);
if (!team) { console.error('Usage: node scripts/cloud-sync-trial.ts --team <id> (ELABORA_CLOUD_URL and ELABORA_CLOUD_KEY_FILE set)'); process.exit(2); }
const api = projectsApi(); // refuses Elabora's hosting
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-cloud-trial-'));
const A = path.join(work, 'A');
const B = path.join(work, 'B');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const elabora = (cli: string[], env: Record<string, string> = {}) => execFileSync(process.execPath, [BIN, ...cli], { env: { ...process.env, ...env }, encoding: 'utf8' });

console.log(`Test server ${new URL(api).host}, team ${team}, ${example}, in ${work}`);
fs.cpSync(path.join(ROOT, 'examples', example), A, { recursive: true, filter: (source) => !source.includes(`${path.sep}.elabora`) });
const created = JSON.parse(elabora(['cloud', 'project', 'create', A, '--team', team, '--name', `Essai ${new Date().toISOString()}`, '--json']));
console.log(`project ${created.project}: ${created.files} files in ${created.changes} change(s)`);
elabora(['cloud', 'project', 'clone', B, '--team', team, '--project', created.project, '--json']);

const syncs = new Map<string, ChildProcess>();
const startSync = (dir: string) => {
  const child = spawn(process.execPath, [BIN, 'cloud', 'project', 'sync', dir, '--watch'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(work, `${path.basename(dir)}.log`), { flags: 'a' });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  syncs.set(dir, child);
};
const stopSync = async (dir: string) => {
  const child = syncs.get(dir);
  if (!child) return;
  syncs.delete(dir);
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGINT');
  await gone;
};
startSync(A);
startSync(B);
await sleep(3000);

const linkHead = (dir: string): { head: number; waiting: number } => {
  const link = JSON.parse(fs.readFileSync(path.join(dir, '.elabora/cloud-project.json'), 'utf8'));
  return { head: link.head, waiting: link.waiting.length };
};

// The agent: Elabora's MCP tools on folder B.
const server = createMcpServer(B);
const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const agent = new Client({ name: 'trial-agent', version: '1' });
await agent.connect(clientSide);
const tool = async (name: string, argumentsOf: Record<string, unknown>) => {
  const result = await agent.callTool({ name, arguments: argumentsOf });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content).slice(0, 300)}`);
  return JSON.parse((result.content as { text: string }[])[0].text);
};

const screensOf = (dir: string) => fs.readdirSync(path.join(dir, 'screens')).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
const textBlocks = (dir: string, screen: string): string[] => JSON.parse(fs.readFileSync(path.join(dir, 'screens', `${screen}.json`), 'utf8')).blocks.filter((block: { type: string }) => block.type === 'text').map((block: { id: string }) => block.id);
const pick = <T>(list: readonly T[], n: number): T => list[n % list.length];

// ── concurrent edits ──
let stale: { file: string; text: string } | null = null;
for (let round = 0; round < rounds; round++) {
  const screens = screensOf(A);
  const screen = pick(screens, round);
  const jobs: Promise<unknown>[] = [];
  // A person, on the command line, in A.
  const blocksA = textBlocks(A, screen);
  if (blocksA.length) jobs.push(Promise.resolve().then(() => elabora(['tools', 'call', 'elabora_update_block', A, '--args', JSON.stringify({ block: pick(blocksA, round), props: { markdown: `Person, round ${round}.` } })], { ELABORA_AUTHOR: 'human' })));
  // An agent, through the MCP tools, in B.
  jobs.push(round % 3 === 2
    ? tool('elabora_add_block', { screen: pick(screens, round + 1), block: { type: 'text', props: { markdown: `Agent, round ${round}.` } } })
    : tool('elabora_update_screen', { id: pick(screens, round + 2), title: `Agent title ${round}` }));
  // A file written by an agent's own tools: in B from what it read two rounds before (stale), in A now.
  if (round % 2 === 0) {
    const file = path.join(B, 'screens', `${pick(screens, round + 3)}.json`);
    if (stale) {
      const doc = JSON.parse(stale.text);
      const block = doc.blocks.find((candidate: { type: string }) => candidate.type === 'text');
      if (block) block.props = { ...block.props, markdown: `File edit (from an older read), round ${round}.` };
      fs.writeFileSync(stale.file, `${JSON.stringify(doc, null, 2)}\n`);
    }
    stale = { file, text: fs.readFileSync(file, 'utf8') };
  } else {
    const file = path.join(A, 'theme', 'theme.css');
    if (fs.existsSync(file)) fs.appendFileSync(file, `\n/* round ${round} */\n`);
  }
  await Promise.all(jobs);
  // Offline, then back: B stops for a few rounds.
  if (round === Math.floor(rounds / 3)) await stopSync(B);
  if (round === Math.floor((2 * rounds) / 3)) startSync(B);
  await sleep(400);
}
if (!syncs.has(B)) startSync(B);

const settle = async (label: string) => {
  const started = Date.now();
  for (let stable = 0; stable < 3;) {
    await sleep(1000);
    const [a, b] = [linkHead(A), linkHead(B)];
    stable = a.head === b.head && !a.waiting && !b.waiting ? stable + 1 : 0;
    if (Date.now() - started > 180_000) throw new Error(`${label}: the copies did not settle (A ${JSON.stringify(a)}, B ${JSON.stringify(b)})`);
  }
  return Date.now() - started;
};
await settle('the edits');

// ── an agent's burst ──
const screens = screensOf(B);
const burstStart = Date.now();
for (let n = 0; n < burst; n++) await tool('elabora_update_screen', { id: pick(screens, n), title: `Burst ${n}` });
const madeIn = Date.now() - burstStart;
const target = `Burst ${burst - 1}`;
for (;;) {
  const title = JSON.parse(fs.readFileSync(path.join(A, 'screens', `${pick(screens, burst - 1)}.json`), 'utf8')).title;
  if (title === target && !linkHead(B).waiting) break;
  if (Date.now() - burstStart > 600_000) throw new Error('the burst did not reach A');
  await sleep(200);
}
const drained = Date.now() - burstStart;
await settle('the burst');
await agent.close();
for (const dir of [...syncs.keys()]) await stopSync(dir);

// ── what the trial affirms ──
const problems: string[] = [];
const listing = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name === '.elabora' || entry.name === '.DS_Store') continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child); else out.push(child);
    }
  };
  walk('');
  return out.sort();
};
const [inA, inB] = [listing(A), listing(B)];
for (const rel of new Set([...inA, ...inB])) {
  if (!inA.includes(rel) || !inB.includes(rel)) { problems.push(`${rel}: only in ${inA.includes(rel) ? 'A' : 'B'}`); continue; }
  const [a, b] = [fs.readFileSync(path.join(A, rel)), fs.readFileSync(path.join(B, rel))];
  const same = rel.endsWith('.json') ? JSON.stringify(JSON.parse(a.toString('utf8'))) === JSON.stringify(JSON.parse(b.toString('utf8'))) : a.equals(b);
  if (!same) problems.push(`${rel}: differs`);
}
for (const dir of [A, B]) {
  const errors = validateDir(dir).diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) problems.push(`${path.basename(dir)}: ${errors.length} error(s): ${errors.slice(0, 3).map((d) => d.code).join(', ')}`);
}
const [headA, headB] = [linkHead(A), linkHead(B)];
if (headA.head !== headB.head) problems.push(`heads differ: A ${headA.head}, B ${headB.head}`);
const report = { project: created.project, files: inA.length, head: headA.head, rounds, burst, burstMadeMs: madeIn, burstDrainedMs: drained, perChangeMs: Math.round(drained / burst), problems };
console.log(JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2));
if (!args.includes('--keep')) for (const dir of [A, B]) fs.rmSync(dir, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
