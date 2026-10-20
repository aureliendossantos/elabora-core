import { installDownload, optionalDownloads, uninstallDownload } from '@elabora/node/downloads/index';
import type { DownloadView } from '@elabora/node/downloads/index';
import { defineCommand, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';

// Optional downloads (D38): the models Elabora downloads once per computer on first use, never in a
// course: listed, installed and removed here as in Elabora settings.

const HELP = `  downloads list [--kind <kind>] [--language <lang>] [--json]
                                                      What Elabora downloads once per computer on first use (never in a
                                                      course): the local voices and the word aligners, by language, what
                                                      each is for and what happens without it, on this computer (its size
                                                      on disk) or not (the size to download), being downloaded now (by
                                                      the app, a command or an agent) or in use
  downloads install <id> [--force] [--json]           Downloads one now (voices-fr, aligner-en…), with its progress; --force
                                                      removes it first and downloads it again (a reinstall)
  downloads uninstall <id> [--json]                   Removes one from this computer, refused while it is in use (lines
                                                      said, words placed) or being downloaded; what modules already
                                                      contain stays, and the next use downloads it again

  elabora voice models, voice install and voice uninstall are the local voices' part of these (voice uninstall <lang>
  is downloads uninstall voices-<lang>).`;

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

function state(view: DownloadView): string {
  if (view.supported === false) return `unavailable on Intel Macs${view.installed ? `; ${megabytes(view.size)} on disk (elabora downloads uninstall ${view.id})` : ''}`;
  if (view.installing) return `downloading: ${Math.floor((view.installing.received / Math.max(1, view.installing.total)) * 100)} % (${megabytes(view.installing.received)} of ${megabytes(view.installing.total)})`;
  if (view.installed) return `on this computer: ${megabytes(view.size)}${view.inUse ? ', in use now' : ''} (elabora downloads uninstall ${view.id})`;
  return `not on this computer: ${megabytes(view.download)} downloaded on first use (elabora downloads install ${view.id})`;
}

const list = defineCommand({
  name: 'downloads list',
  flags: { kind: 'string', language: 'string', json: 'boolean' },
  run({ positionals, flags }) {
    if (positionals.length) { console.error('Usage: elabora downloads list [--kind <kind>] [--language <lang>] [--json]'); return 2; }
    const views = optionalDownloads({ ...(flags.kind ? { kind: flags.kind } : {}), ...(flags.language ? { language: flags.language } : {}) });
    if (flags.json) { printJson({ downloads: views }); return 0; }
    if (!views.length) { console.log('No optional download.'); return 0; }
    let kind = '';
    for (const view of views) {
      if (view.kind !== kind) {
        kind = view.kind;
        console.log(`${kind === views[0].kind ? '' : '\n'}${view.title}: ${view.serves}\n  Without it: ${view.without}`);
      }
      console.log(`  ${view.id.padEnd(12)} ${view.contents?.length ? `${view.contents.map((item) => item.name).join(', ')} · ` : ''}${state(view)}`);
    }
    return 0;
  }
});

// Progress on stderr: one line rewritten in a terminal, else a line every 25 %.
function progressLine(id: string): { report(received: number, total: number): void; done(): void } {
  const terminal = !!process.stderr.isTTY;
  let shown = -1;
  return {
    report(received, total) {
      const percent = Math.floor((received / Math.max(1, total)) * 100);
      if (terminal) { process.stderr.write(`\r  downloading ${id} (${megabytes(total)}) ${percent}%`); return; }
      if (Math.floor(percent / 25) !== shown) { shown = Math.floor(percent / 25); console.error(`  downloading ${id} (${megabytes(total)}) ${percent}%`); }
    },
    done() { if (terminal) process.stderr.write('\n'); }
  };
}

const install = defineCommand({
  name: 'downloads install',
  flags: { force: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const [id, ...extra] = positionals;
    if (!id || extra.length) { console.error('Usage: elabora downloads install <id> [--force] [--json]'); return 2; }
    const progress = progressLine(id);
    let view: DownloadView;
    try {
      view = await installDownload(id, { force: flags.force, onProgress: (p) => progress.report(p.received, p.total) });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      if (!flags.json || !code) throw error;
      printJson({ ok: false, code, error: (error as Error).message });
      return 1;
    } finally {
      progress.done();
    }
    if (flags.json) printJson({ ok: true, download: view });
    else console.log(`✔ ${id} ${flags.force ? 'downloaded again' : 'ready'} on this computer (${megabytes(view.size)}).`);
    return 0;
  })
});

// What a removal says, for the voices' alias too.
export async function uninstallCommand(id: string, json: boolean | undefined): Promise<0 | 1> {
  let result;
  try {
    result = await uninstallDownload(id);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    if (!json || !code) throw error;
    printJson({ ok: false, code, error: (error as Error).message });
    return 1;
  }
  if (json) { printJson({ ok: true, ...result }); return 0; }
  console.log(result.freed
    ? `✔ ${id} is removed from this computer (${megabytes(result.freed)} freed). What modules already contain stays; the next use downloads it again.`
    : `✔ ${id} was not on this computer.`);
  return 0;
}

const uninstall = defineCommand({
  name: 'downloads uninstall',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const [id, ...extra] = positionals;
    if (!id || extra.length) { console.error('Usage: elabora downloads uninstall <id> [--json]'); return 2; }
    return uninstallCommand(id, flags.json);
  })
});

export const downloadCommands: CommandGroup = {
  title: 'Optional downloads (models downloaded once per computer)',
  help: HELP,
  commands: [list, install, uninstall],
  subcommandUsage: { downloads: `Usage: elabora downloads list|install|uninstall\n\n${HELP}` }
};
