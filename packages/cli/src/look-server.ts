import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lookFolder } from '@elabora/node/look-client';

// The elabora command line, as Node runs it (the TypeScript sources).
const CLI_ENTRY = fileURLToPath(new URL('../bin/elabora.ts', import.meta.url));

// Starts the look server of a course in the background (@elabora/node look.ts): the command line
// again, `elabora look <dir> --serve`, detached, so it outlives the command or the MCP server that
// started it; it stops after 15 minutes without a look. What it prints goes to <data>/look/server.log.
export function startLookServer(root: string): void {
  fs.mkdirSync(lookFolder(root), { recursive: true });
  const log = fs.openSync(path.join(lookFolder(root), 'server.log'), 'a');
  try {
    spawn(process.execPath, [CLI_ENTRY, 'look', root, '--serve'], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  } finally {
    fs.closeSync(log);
  }
}
