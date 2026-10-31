#!/usr/bin/env node
// Elabora's extension for Claude (the desktop app): starts the MCP server of the Elabora installed on
// this computer (elabora mcp) on the folders the author picked. It carries no copy of Elabora, so the
// tools, rules and skills are always those of the author's own version. Plain Node with no
// dependency: Claude runs it with the Node it ships.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Where the app installs its command line (the same places as a course's AGENTS.md gives). On Windows,
// the app's own Electron runs the CLI as Node, as resources\bin\elabora.cmd does: a .cmd cannot be
// started without a shell. ELABORA_COMMAND names another elabora (a checkout, a test).
function candidates() {
  if (process.env.ELABORA_COMMAND) {
    const command = process.env.ELABORA_COMMAND;
    // A checkout's Node entry point has no executable shebang on Windows.
    return /\.[cm]?js$/i.test(command) ? [{ command: process.execPath, args: [command] }] : [{ command, args: [] }];
  }
  const home = os.homedir();
  if (process.platform === 'win32') {
    const dir = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'elabora');
    return [{ command: path.join(dir, 'Elabora.exe'), args: [path.join(dir, 'resources', 'app', 'cli', 'elabora.js')], env: { ELECTRON_RUN_AS_NODE: '1' } }];
  }
  const apps = ['/Applications/Elabora.app', path.join(home, 'Applications', 'Elabora.app')];
  return apps.map((app) => ({ command: path.join(app, 'Contents', 'Resources', 'bin', 'elabora'), args: [] }));
}

const found = candidates().find((each) => [each.command, ...each.args].every((file) => fs.existsSync(file)));
if (!found) {
  process.stderr.write(`Elabora was not found on this computer (looked for ${candidates().map((each) => each.command).join(', ')}). Install Elabora from https://elabora.studio, open it once, then restart Claude.\n`);
  process.exit(1);
}

// The folders picked in the extension's settings, each a course or a folder of courses. With none,
// a folder without courses, so that the server offers only its documentation and says why.
const folders = process.argv.slice(2).filter(Boolean);
const env = { ...process.env, ...found.env };
delete env.NODE_OPTIONS; // Claude's Node settings are not Elabora's
const child = spawn(found.command, [...found.args, 'mcp', ...(folders.length ? folders : [__dirname])], { stdio: 'inherit', env, windowsHide: true });
child.on('error', (error) => { process.stderr.write(`Elabora could not start: ${error.message}\n`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
