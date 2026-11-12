import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { ROOT } from '../helpers.ts';

// The command line before a server without teams (elabora-cloud C80: GET /v1 says teams: false, as
// Elabora's hosting does today, or nothing): said in words, an error, never the server's refusal.
const BIN = path.join(ROOT, 'bin/elabora.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-cli-teams-'));
const key = path.join(temp, 'key');
fs.writeFileSync(key, `eas_${'a'.repeat(43)}`, { mode: 0o600 });
let said: Record<string, unknown> = {};
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/v1') return response.end(JSON.stringify({ service: 'elabora-cloud', protocol: 10, ...said }));
  if (request.url === '/v1/teams') return response.end(JSON.stringify({ teams: [], invitations: [] }));
  response.statusCode = 503;
  response.end(JSON.stringify({ error: { code: 'not-configured', message: 'Not configured.' } }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => { server.close(); fs.rmSync(temp, { recursive: true, force: true }); });
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const elabora = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: temp, env: { ...process.env, ELABORA_CLOUD_URL: api, ELABORA_CLOUD_KEY_FILE: key } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('cloud teams and cloud project before a server without teams: said in words, an error; with them, the teams', async () => {
  for (const answer of [{ teams: false }, {}]) {
    said = answer;
    for (const args of [['cloud', 'teams'], ['cloud', 'project', 'clone', 'copy', '--team', 'tm_a', '--project', 'prj_a'], ['cloud', 'project', 'create', '.', '--team', 'tm_a']]) {
      const run = await elabora(args);
      assert.equal(run.status, 1, `${args.join(' ')}: an error (${JSON.stringify(answer)})`);
      assert.match(run.stderr, /has no teams yet/, args.join(' '));
      assert.doesNotMatch(run.stderr, /503|not-configured|Not configured/, args.join(' '));
    }
  }
  said = { teams: true };
  const run = await elabora(['cloud', 'teams']);
  assert.deepEqual([run.status, run.stdout.trim()], [0, 'No team yet.']);
});
