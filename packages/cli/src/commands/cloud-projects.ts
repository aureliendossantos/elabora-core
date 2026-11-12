import path from 'node:path';
import { CloudError } from '@elabora/node/cloud/client';
import { cloneProject, cloudSessionOptions, createProject, listTeams, projectsApi, projectsClient, pushFolder, readLink, teamsOffered } from '@elabora/node/cloud/projects';
import { defineCommand, errorMessage, printJson } from './command.ts';
import type { CommandGroup, ExitCode } from './command.ts';

// Projects in the cloud from the command line (docs/architecture/sync.md, D83): a folder linked to a
// project of a team, kept in sync with its room by a session of the engine. On the account's server
// (ELABORA_CLOUD_URL or --api, else Elabora's hosting) once it says it has teams (GET /v1, elabora-cloud
// C80): a test server for now. A server without them is said so in words, never by its refusal.

const HELP = `  cloud teams [--api <origin>] [--json]               Your teams on the server, with their ids
  cloud project create [dir] --team <id> [--name <n>] [--api <origin>] [--json]
                                                      A new project of the team from the course's files, the folder
                                                      linked to it (the media first, then the files; course.json last)
  cloud project push [dir] --team <id> --project <id> [--api <origin>] [--json]
                                                      The course's files into an empty project, the folder linked to it
  cloud project clone <dir> --team <id> --project <id> [--api <origin>] [--json]
                                                      A project into a new folder, linked to it
  cloud project sync [dir] [--watch] [--json]         Sends the changes made in the folder (by you, by agents through
                                                      Elabora's tools, by programs writing its files) and writes the
                                                      others'. Without --watch: until nothing waits, then stops. With
                                                      it: until stopped (Ctrl-C); offline, changes wait and go when the
                                                      server is back`;

async function failures(json: boolean, run: () => Promise<ExitCode>): Promise<ExitCode> {
  try {
    return await run();
  } catch (error) {
    const message = errorMessage(error);
    if (json) printJson({ ok: false, error: { message, ...(error instanceof CloudError ? { code: error.code } : {}) } });
    else console.error(`✘ ${message}`);
    return 1;
  }
}

// The server's address, once it says it has teams; otherwise said in words, an error.
async function teamsApi(flag: string | undefined): Promise<string> {
  const api = projectsApi(flag);
  if (!(await teamsOffered(api))) throw new CloudError(0, 'E_CLOUD_NO_TEAMS', `${new URL(api).host} has no teams yet: they are on a test server for now (give its address: --api or ELABORA_CLOUD_URL).`);
  return api;
}

const teams = defineCommand({
  name: 'cloud teams',
  flags: { api: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => failures(flags.json, async () => {
    if (positionals.length) { console.error('Usage: elabora cloud teams [--api <origin>] [--json]'); return 2; }
    const list = await listTeams(projectsClient(await teamsApi(flags.api ?? undefined)));
    if (flags.json) { printJson({ teams: list }); return 0; }
    if (!list.length) console.log('No team yet.');
    for (const team of list) console.log(`${team.id}  ${team.name}${team.role ? `  (${team.role})` : ''}`);
    return 0;
  })
});

const project = defineCommand({
  name: 'cloud project',
  flags: { api: 'string', team: 'string', project: 'string', name: 'string', watch: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => failures(flags.json, async () => {
    const [action, ...rest] = positionals;
    const dir = path.resolve(rest[0] ?? '.');
    const say = (text: string, value: unknown) => (flags.json ? printJson(value) : console.log(text));
    switch (action) {
      case 'create':
      case 'push': {
        const api = await teamsApi(flags.api ?? undefined);
        if (!flags.team || (action === 'push' && !flags.project)) { console.error(`Usage: elabora cloud project ${action} [dir] --team <id>${action === 'push' ? ' --project <id>' : ''}`); return 2; }
        const id = action === 'create' ? (await createProject(projectsClient(api), flags.team, flags.name ?? path.basename(dir))).id : flags.project as string;
        const pushed = await pushFolder(dir, { api, team: flags.team, project: id });
        say(`✔ ${pushed.files} file(s) in project ${id} (${pushed.changes} change(s), ${pushed.media} medium/media); ${dir} is linked to it.`, { ok: true, project: id, head: pushed.link.head, files: pushed.files, changes: pushed.changes, media: pushed.media });
        return 0;
      }
      case 'clone': {
        const api = await teamsApi(flags.api ?? undefined);
        if (!flags.team || !flags.project || !rest[0]) { console.error('Usage: elabora cloud project clone <dir> --team <id> --project <id>'); return 2; }
        const link = await cloneProject(dir, { api, team: flags.team, project: flags.project });
        say(`✔ Project ${link.project} at ${link.head} in ${dir}, linked to it.`, { ok: true, project: link.project, head: link.head, dir });
        return 0;
      }
      case 'sync':
        return sync(dir, flags.watch, flags.json);
      default:
        console.error(`Usage: elabora cloud project create|push|clone|sync\n\n${HELP}`);
        return 2;
    }
  })
});

async function sync(dir: string, watch: boolean, json: boolean): Promise<ExitCode> {
  if (!readLink(dir)) throw new CloudError(0, 'E_CLOUD_NOT_LINKED', `${dir} is not linked to a project (elabora cloud project create, push or clone).`);
  const cloud = cloudSessionOptions(dir);
  const { openProject } = await import('@elabora/engine/session');
  const session = await openProject(dir, { cloud: cloud ?? undefined, backups: { onOpen: false, prune: false }, media: { enabled: false } });
  const status = () => session.cloud ?? { online: false, head: 0, pending: 0 };
  session.subscribe((message) => {
    if (message.kind !== 'event') return;
    const event = message.event;
    if (event.type === 'cloudOutcome' && !json) console.error(`  ${'refused' in event.outcome ? `refused: ${event.outcome.refused.message}` : `${event.outcome.skipped.length} left out, ${event.outcome.overwrote.length} overwritten`} (${event.outcome.id})`);
    if (event.type === 'cloudReplaced' && !json) console.error(`  ${event.overwrote.map((overwrite) => `${overwrite.file} ${overwrite.path}`).join(', ')}: replaced by ${event.change.author.name ?? event.change.author.kind}${event.overwrote.some((overwrite) => overwrite.unsure) ? ' (perhaps)' : ''}`);
    if (event.type === 'merged' && !json) console.error(`  ${event.files.join(', ')}: merged with what was written meanwhile`);
    if (event.type === 'cloudRole' && !json) console.error(`  your role is now ${event.role}${event.role === 'viewer' ? ': changes made here wait until you write again' : ''}`);
    if (event.type === 'cloudEnded') {
      console.error(`✘ ${event.reason === 'removed' ? `You are no longer in team ${event.team}` : `Project ${event.project} was deleted`}: ${dir} is no longer linked, and keeps what it held.`);
      ended?.();
    }
    if (event.type === 'error') console.error(`✘ ${event.message}`);
  });
  let ended: (() => void) | null = null;
  if (watch) {
    if (!json) console.log(`Syncing ${dir} with project ${cloud?.link.project} (Ctrl-C to stop).`);
    await new Promise<void>((resolve) => {
      ended = resolve;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolve());
    });
  } else {
    // Until nothing waits, and the room has been quiet a moment (what it sends after hello is in).
    for (let quiet = 0; quiet < 2;) {
      await session.cloud?.settled();
      const head = status().head;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      quiet = status().head === head && !status().pending ? quiet + 1 : 0;
    }
  }
  const { head, pending } = status();
  await session.close({ media: 'cancel' });
  if (json) printJson({ ok: true, head, pending });
  else console.log(`✔ At ${head}${pending ? `, ${pending} change(s) waiting` : ''}.`);
  return 0;
}

export const cloudProjectCommands: CommandGroup = {
  title: 'Projects in the cloud (test server)',
  help: HELP,
  commands: [teams, project],
  subcommandUsage: { cloud: `Usage: elabora cloud teams|project\n\n${HELP}` }
};
