import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  CloudError, accountStatus, chooseHandle, cloudUrl, createReview, defaultPublicationName, deleteReview, isPublicationName, keepInvitation, listReviews,
  isVersionId, otherApiCredentials, publicationVersions, publishBuiltFolder, publishCourse, regenerateLink, replyToComment, resolveCredential, reviewComments, serviceInfo, setCommentState,
  setReviewState, signOut, startSignIn, statusOf, verifySignIn, withdrawVersion, connect, courseReviews, isReviewId, maskSecret, readKeyFile,
  createAiKey, listAiKeys, readAiKey, revokeAiKey, systemName
} from '@elabora/node/cloud/index';
import type { CloudReview, PublishCheck, PublishProgress, PublishResult, ResolvedComment, ResolvedComments } from '@elabora/node/cloud/index';
import type { WebNavigation, WebProgress } from '@elabora/node/build';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { defineCommand, errorMessage, printJson } from './command.ts';
import { pendingMediaJobs, waitForMediaJobs } from './media.ts';
import type { CommandGroup, ExitCode } from './command.ts';

// Elabora's hosting from the command line (docs/decisions.md D43): the author signs in by e-mail code
// (or keeps a tester's invitation key), publishes a module, shares it for review and reads the
// reviewers' comments placed in the course's sources. Publishing, sharing, answering and resolving
// are the author's gestures: here and in the app, never MCP tools. Tokens and keys are read from
// files or the input, never from arguments, and never printed.

const ACCOUNT_HELP = `  account login --email <address> [--device <name>] [--language fr|en] [--handle <name>] [--json]
                                                      Signs in to Elabora's hosting: a code is sent to the address and
                                                      read from the input (never an argument); the session is kept
                                                      readable by you only in Elabora's local data. At the first sign-in,
                                                      --handle (or the input) chooses the account's address, once.
                                                      The device is named « Elabora CLI · macOS » (or Windows, Linux),
                                                      never after your computer; --device names it as you like
  account login --invitation <file>|- --space <space> [--json]
                                                      Keeps a tester's invitation key instead (from a file, or the input
                                                      with -), after checking it opens its space
  account handle <name> [--json]                      Chooses the account's address once: https://<name>.elabora.page/
  account status [--json]                             Who is signed in (the token masked, where it is kept), the space,
                                                      the account's limits and usage
  account logout [--json]                             Ends the session on the server and forgets it here (an invitation
                                                      key or an AI key is only forgotten)
  account ai-key create [--name <name>] [--replace-session] [--json]
                                                      Makes a read-only key for your AI with your session and keeps it
                                                      readable by you only: it lists reviews and reads their comments,
                                                      nothing else (agents' read tools take it first). --replace-session:
                                                      forget the session file then, so that what agents can reach here
                                                      only reads (sign in again to publish or answer)
  account ai-key list [--json]                        The account's AI keys (never a key), the one kept here marked
  account ai-key revoke <aik_…> [--json]              Revokes an AI key at once (and forgets it here if kept)`;

const PUBLISH_HELP = `  publish [dir] [--private] [--name <publication>] [--image <file>] [--index] [--progress local|none]
          [--navigation authored|free] [--languages all] [--review-origin <origin>] [--json]
                                                      Builds the course for the web and publishes it in your space; only
                                                      the files the space lacks are sent (a second publication of the
                                                      same content sends nothing). Public: https://<space>.elabora.page/
                                                      <name>/ (default name: the course id), noindex unless --index.
                                                      --private: a review build (<id>-review by default) that only a
                                                      review shows; a new version goes to its open reviews, even with
                                                      red checks (listed: they stop the web, not reviewers).
                                                      --languages all: one package of every approved language, which
                                                      learners switch in the player (D59; public only). A folder
                                                      elabora build --target web wrote is published as it is
  publication versions <publication> [--json]         The versions the hosting keeps of a publication (the current one
                                                      marked): older ones stay at their pinned addresses
  publication withdraw <publication> <version> --yes [--json]
                                                      Takes one older version down for good while the publication goes
                                                      on: its pinned address answers 404, a review that showed it lists
                                                      it as withdrawn (its comments stay), the files only it used are
                                                      deleted. The current version is refused: publish a newer one first`;

const REVIEW_HELP = `  review create [dir] [--name <publication>] [--version <v>] [--title <t>] [--note <text>] [--link-out <file>]
                [--json]                              Shares a private publication for review: prints the reviewers'
                                                      link once (or writes it to --link-out, readable by you only).
                                                      --note: a word to reviewers, under « <your name> vous invite à
                                                      relire ce module » on the review page (500 characters)
  review list [dir] [--all] [--json]                  The course's reviews (--all: the space's): state, versions, open
                                                      and resolved comments, reviewers
  review link <review> [--link-out <file>] [--json]   A new link for reviewers: the old one stops at once
  review close <review> [--read-only] [--json]        Closes a review (nothing shown any more), or makes it read-only
  review open <review> [--json]                       Opens a closed or read-only review again, under the same link
  review delete <review> --yes [--json]               Deletes a review, its comments and reviewers, and its private
                                                      publication when no other review shows it
  review comments [dir] [--review <review>] [--since <rev>] [--state open|resolved] [--screen <id>] [--json]
                                                      The reviewers' comments placed in the course: the screen (key,
                                                      title, source file), the block (id, type, pointer), the step,
                                                      layer, narration line and word, the version commented and whether
                                                      a newer one or the screen's source changed since, the author, the
                                                      text, the state and the replies. --since <rev>: only what changed
  review reply <review> <comment> [text] [--name <n>] [--json]
                                                      Answers a thread (#4 or cm_…) as the author (the text, or the
                                                      input); --name: the name shown (default: the account's)
  review resolve <review> <comment> [--json]          Marks a thread resolved
  review reopen <review> <comment> [--json]           Opens a resolved thread again

  The API is https://api.elabora.studio (ELABORA_CLOUD_URL elsewhere). A tester's key in a file also serves
  with ELABORA_CLOUD_KEY_FILE and ELABORA_CLOUD_SPACE.`;

// ── Input, output, failures ────────────────────────────────────────────

// Lines read from the input one at a time, a prompt on stderr before each (the code, a handle).
function lineReader(): { ask(prompt: string): Promise<string | null>; close(): void } {
  let reader: ReturnType<typeof createInterface> | null = null;
  let lines: AsyncIterator<string> | null = null;
  return {
    async ask(prompt) {
      process.stderr.write(prompt);
      reader ??= createInterface({ input: process.stdin, terminal: false });
      lines ??= reader[Symbol.asyncIterator]();
      const next = await lines.next();
      if (!process.stdin.isTTY) process.stderr.write('\n');
      return next.done ? null : next.value.trim();
    },
    close() { reader?.close(); }
  };
}

async function readAllInput(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += (chunk as Buffer).toString('utf8');
  return text;
}

const kilobytes = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

// The API's refusals as their messages say, with what helps to act on them; with --json, the error as
// JSON on stdout. Exit code 1.
async function cloudFailures(json: boolean, run: () => Promise<ExitCode>): Promise<ExitCode> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof CloudError)) {
      if (json) printJson({ ok: false, error: { message: errorMessage(error) } });
      else console.error(`✘ ${errorMessage(error)}`);
      return 1;
    }
    const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
    const lines = [error.message];
    if (error.code.startsWith('quota-') && typeof details.limit === 'number' && typeof details.used === 'number') {
      lines.push(error.code === 'quota-storage' ? `  ${kilobytes(details.used)} used of ${kilobytes(details.limit)}${typeof details.adding === 'number' ? `, ${kilobytes(details.adding)} to add` : ''}.` : `  ${details.used} of ${details.limit}.`);
    }
    if (error.code === 'noindex-required') lines.push('  Publish without --index: your account may not ask search engines to index it.');
    if (error.code === 'visibility-fixed') lines.push('  A publication stays public or private: give another --name.');
    if (error.code === 'not-private') lines.push('  Only a private publication is reviewed: elabora publish --private, then review create.');
    if (Array.isArray(details.problems)) for (const problem of details.problems.slice(0, 10)) lines.push(`  · ${String(problem)}`);
    if (error.retryAfter) lines.push(`  Try again in ${error.retryAfter} s.`);
    if (json) printJson({ ok: false, error: { status: error.status, code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}), ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) } });
    else console.error(`✘ ${lines.join('\n')}`);
    return 1;
  }
}

// The course a command runs in: the first positional when it is a course folder, else the current one.
function courseOf(positionals: readonly string[]): { dir: string | null; rest: string[] } {
  const [first, ...rest] = positionals;
  if (first !== undefined && fs.existsSync(path.join(first, 'course.json'))) return { dir: first, rest };
  return { dir: fs.existsSync('course.json') ? '.' : null, rest: [...positionals] };
}

// A secret written to a file only its owner reads; never over another file.
function writeLinkFile(file: string, link: string): string {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${link}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(target, 0o600);
  return target;
}

// ── account ────────────────────────────────────────────────────────────

const login = defineCommand({
  name: 'account login',
  flags: { email: 'string', invitation: 'string', space: 'string', device: 'string', language: 'string', handle: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    if (positionals.length || (!flags.email === !flags.invitation)) { console.error('Usage: elabora account login --email <address> [--device <name>] [--language fr|en] [--handle <name>] [--json], or --invitation <file>|- --space <space>'); return 2; }
    const api = cloudUrl();
    if (flags.invitation) {
      if (!flags.space) { console.error('✘ --space names the space the invitation key opens (it was given with the key).'); return 2; }
      const key = flags.invitation === '-' ? (await readAllInput()).trim() : readKeyFile(flags.invitation);
      const kept = await keepInvitation(key, flags.space, { api });
      if (flags.json) printJson({ ok: true, kind: 'invitation', space: flags.space, key: maskSecret(key), file: kept.file, publications: kept.publications });
      else console.log(`✔ Invitation key ${maskSecret(key)} kept for the space ${flags.space} (${kept.publications} publication(s) there), readable by you only: ${kept.file}`);
      return 0;
    }
    const email = flags.email!;
    const info = await serviceInfo(api);
    await startSignIn(email, { language: flags.language, api });
    console.error(`If this address may sign in, a code of ${info.accounts.codeLength} digits is on its way to it (valid ${Math.round(info.accounts.codeSeconds / 60)} minutes).${info.accounts.signup === 'closed' ? ' Access is by invitation for now.' : ''}`);
    const input = lineReader();
    try {
      for (;;) {
        const code = await input.ask('Code: ');
        if (!code) { console.error('✘ No code read: elabora account login again when the e-mail has come.'); return 1; }
        try {
          const signedIn = await verifySignIn(email, code, { ...(flags.device ? { device: flags.device } : {}), language: flags.language, api });
          let account = signedIn.account;
          if (signedIn.next === 'choose-handle') {
            const handle = flags.handle ?? await input.ask('Choose your space\'s address, https://<name>.elabora.page/ (it never changes; empty: later with elabora account handle): ');
            if (handle) account = await chooseHandle(handle, { api });
          }
          if (flags.json) printJson({ ok: true, kind: 'session', account, file: signedIn.file, next: account.handle ? null : 'choose-handle' });
          else {
            console.log(`✔ Signed in as ${account.email}${account.space ? `, space ${account.space.url}` : ''}. Session kept ${signedIn.file ? `readable by you only: ${signedIn.file}` : 'in the app\'s store'}`);
            if (!account.handle) console.log('  Choose your space\'s address before publishing: elabora account handle <name>');
          }
          return 0;
        } catch (error) {
          if (error instanceof CloudError && error.code === 'invalid-code') {
            const left = (error.details as { attemptsLeft?: number } | undefined)?.attemptsLeft;
            if (left) { console.error(`✘ Wrong code: ${left} tr${left > 1 ? 'ies' : 'y'} left.`); continue; }
          }
          if (error instanceof CloudError && error.code === 'code-expired') { console.error('✘ This code has expired or was used: elabora account login again for a new one.'); return 1; }
          throw error;
        }
      }
    } finally { input.close(); }
  })
});

const handle = defineCommand({
  name: 'account handle',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const [name, ...extra] = positionals;
    if (!name || extra.length) { console.error('Usage: elabora account handle <name> [--json]'); return 2; }
    const account = await chooseHandle(name);
    if (flags.json) printJson({ ok: true, account });
    else console.log(`✔ Your space is ${account.space?.url ?? name}. It never changes.`);
    return 0;
  })
});

const status = defineCommand({
  name: 'account status',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    if (positionals.length) { console.error('Usage: elabora account status [--json]'); return 2; }
    const api = cloudUrl();
    const others = otherApiCredentials(api);
    if (!resolveCredential(api)) {
      if (flags.json) printJson({ signedIn: false, api, others });
      else console.log(`Not signed in to ${api}: elabora account login --email <address>.${others.map((other) => `\n  (a ${other.kind} is kept for ${other.api})`).join('')}`);
      return 0;
    }
    const view = await accountStatus(api);
    if (flags.json) { printJson({ signedIn: true, api, ...view, others }); return 0; }
    const where = view.credential.source === 'environment' ? `ELABORA_CLOUD_KEY_FILE (${view.credential.file})` : view.credential.file;
    if (view.account) {
      console.log(`Signed in as ${view.account.email}${view.account.displayName ? ` (${view.account.displayName})` : ''}, ${view.account.space ? `space ${view.account.space.url}` : 'no address yet (elabora account handle <name>)'}`);
      console.log(`  Session ${view.credential.masked}${view.credential.device ? ` « ${view.credential.device} »` : ''}, kept in ${where}`);
      if (view.limits && view.usage) {
        console.log(`  Storage ${kilobytes(view.usage.storageBytes)} of ${kilobytes(view.limits.storageBytes)} · public publications ${view.usage.publicPublications} of ${view.limits.publicPublications} · open reviews ${view.usage.openReviews} of ${view.limits.openReviews}${view.limits.indexing ? ' · may be indexed' : ' · noindex only'}`);
      }
      const kept = readAiKey();
      if (kept && kept.api === api) console.log(`  A read-only AI key « ${kept.name} » is kept too: agents' read tools use it.`);
    } else if (view.reviews !== null) {
      console.log(`Read-only AI key ${view.credential.masked}${view.credential.device ? ` « ${view.credential.device} »` : ''} for the space ${view.space} (${view.reviews} review(s)), kept in ${where}`);
      console.log('  It lists reviews and reads their comments, nothing else: publishing, sharing, answering and resolving need your session (elabora account login --email <address>).');
    } else console.log(`Invitation key ${view.credential.masked} for the space ${view.space} (${view.publications} publication(s)), kept in ${where}`);
    return 0;
  })
});

const logout = defineCommand({
  name: 'account logout',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    if (positionals.length) { console.error('Usage: elabora account logout [--json]'); return 2; }
    const api = cloudUrl();
    const credential = resolveCredential(api);
    if (!credential) { if (flags.json) printJson({ ok: true, signedIn: false }); else console.log('Not signed in.'); return 0; }
    const shown = statusOf(credential);
    const result = await signOut(api);
    if (flags.json) printJson({ ok: true, ...result });
    else if (credential.source === 'environment') console.log(`ELABORA_CLOUD_KEY_FILE gives the ${credential.kind}: ${result.endedOnServer ? 'the session is ended; ' : ''}unset it to stop using ${shown.masked}.`);
    else console.log(`✔ ${credential.kind === 'session' ? `Signed out${result.endedOnServer ? '' : ' here (the server could not be told)'}` : credential.kind === 'ai' ? `AI key ${shown.masked} forgotten here (it still works elsewhere until revoked: elabora account ai-key revoke, or in the app)` : `Invitation key ${shown.masked} forgotten`}.`);
    return 0;
  })
});

const AI_KEY_USAGE = 'Usage: elabora account ai-key create [--name <name>] [--replace-session] [--json] | list [--json] | revoke <aik_…> [--json]';

const aiKey = defineCommand({
  name: 'account ai-key',
  flags: { name: 'string', 'replace-session': 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const [action, id, ...extra] = positionals;
    if (action === 'create' && !id) {
      const created = await createAiKey(flags.name ?? `AI · ${systemName()}`, { forgetSessionFile: flags['replace-session'] });
      if (flags.json) { printJson({ ok: true, ...created }); return 0; }
      console.log(`✔ Read-only AI key « ${created.aiKey.name} » (${created.aiKey.id}) for the space ${created.space}, kept readable by you only: ${created.file}`);
      console.log(created.forgotSession ? '  The session file is forgotten: agents here can only read reviews. Sign in again to publish or answer.' : '  Agents\' read tools use it first. Your session stays for your own commands (--replace-session forgets it).');
      return 0;
    }
    if (action === 'list' && !id) {
      const { aiKeys, limit } = await listAiKeys();
      if (flags.json) { printJson({ ok: true, aiKeys, limit }); return 0; }
      if (!aiKeys.length) console.log('No AI key: elabora account ai-key create.');
      for (const key of aiKeys) console.log(`${key.id}  « ${key.name} »  created ${key.createdAt.slice(0, 10)}, ${key.lastUsedAt ? `last used ${key.lastUsedAt.slice(0, 10)}` : 'never used'}${key.here ? '  (kept here)' : ''}`);
      if (aiKeys.length) console.log(`${aiKeys.length} of ${limit}.`);
      return 0;
    }
    if (action === 'revoke' && id && !extra.length) {
      const result = await revokeAiKey(id);
      if (flags.json) printJson({ ok: true, ...result });
      else console.log(`✔ AI key ${id} revoked${result.forgotten ? ' and forgotten here' : ''}.`);
      return 0;
    }
    console.error(AI_KEY_USAGE);
    return 2;
  })
});

// ── publish ────────────────────────────────────────────────────────────

function publishProgress(): { report(progress: PublishProgress): void; done(): void } {
  const terminal = !!process.stderr.isTTY;
  let shown = '';
  return {
    report(progress) {
      const label = progress.phase === 'build' ? 'building for the web' : progress.phase === 'hash' ? 'reading the files' : progress.phase === 'commit' ? 'switching to the new version'
        : `sending ${kilobytes(progress.totalBytes ?? 0)} ${Math.floor(((progress.sentBytes ?? 0) / Math.max(1, progress.totalBytes ?? 1)) * 100)}%`;
      const line = `  ${label}`;
      if (terminal) { process.stderr.write(`\r${line}`.padEnd(Math.min(process.stderr.columns || 80, 100) - 1)); return; }
      // Agents and logs: a line per phase, and every 25 % of what is sent.
      const step = line.replace(/\d+%$/, (percent) => `${Math.floor(Number(percent.slice(0, -1)) / 25) * 25}%`);
      if (step !== shown) { shown = step; console.error(line); }
    },
    done() { if (terminal) process.stderr.write(`\r${' '.repeat(Math.min(process.stderr.columns || 80, 100) - 1)}\r`); }
  };
}

function printPublished(result: PublishResult & { checks?: PublishCheck[] }): void {
  const what = result.visibility === 'private' ? `privately as ${result.name}` : result.url ?? result.name;
  if (result.unchanged) console.log(`✔ Unchanged: ${what} already serves version ${result.version}; nothing sent.`);
  else console.log(`✔ Published ${what} (version ${result.version}): ${result.files} files, ${kilobytes(result.bytes)}; sent ${result.sentFiles} (${kilobytes(result.sentBytes)})${result.multipartFiles ? `, ${result.multipartFiles} in parts` : ''}.`);
  if (result.visibility === 'public' && result.pinnedUrl) console.log(`  This version stays at ${result.pinnedUrl}`);
  for (const review of result.reviews) console.log(`  ${review.added ? 'Sent to' : 'Already in'} review ${review.id} « ${review.title} »${review.number ? ` as version ${review.number}` : ''}.`);
  if (result.visibility === 'private' && !result.reviews.length) console.log(`  Only a review shows it: elabora review create --name ${result.name}`);
  // Reviewers see the course as it is: the red checks stop the web and the package, not them (D43).
  if (result.checks?.length) {
    console.log(`  ${result.checks.length} check(s) still fail: reviewers see it anyway, the web and the package wait for them.`);
    for (const check of result.checks.slice(0, 10)) console.log(`   · ${check.code}${check.target ? ` (${check.target})` : ''}: ${check.message}`);
    if (result.checks.length > 10) console.log(`   … elabora validate lists them all.`);
  }
}

const publish = defineCommand({
  name: 'publish',
  flags: { private: 'boolean', name: 'string', image: 'string', index: 'boolean', progress: 'string', navigation: 'string', languages: 'string', 'review-origin': 'list', json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const [dir = '.', ...extra] = positionals;
    if (extra.length) { console.error('Usage: elabora publish [dir] [--private] [--name <publication>] [--image <file>] [--index] [--progress local|none] [--navigation authored|free] [--languages all] [--review-origin <origin>] [--json]'); return 2; }
    if (flags.languages !== undefined && flags.languages !== 'all') { console.error(`--languages is all (not "${flags.languages}"): one package of every approved language.`); return 2; }
    if (flags.languages && flags.private) { console.error('✘ --languages: a review shows one language per build; publish the review without it.'); return 2; }
    if (flags.name !== undefined && !isPublicationName(flags.name)) { console.error(`✘ --name: lowercase letters, digits and hyphens, 1 to 64 characters (not "${flags.name}").`); return 2; }
    const progressValue = flags.progress;
    if (progressValue !== undefined && progressValue !== 'local' && progressValue !== 'none') { console.error(`--progress is local or none (not "${progressValue}").`); return 2; }
    const navigation = flags.navigation;
    if (navigation !== undefined && navigation !== 'authored' && navigation !== 'free') { console.error(`--navigation is authored or free (not "${navigation}").`); return 2; }
    const visibility = flags.private ? 'private' : 'public';
    const progress = publishProgress();
    try {
      let result: PublishResult & { checks?: PublishCheck[] };
      let languages: string[] | undefined;
      if (fs.existsSync(path.join(dir, 'course.json'))) {
        // Media being imported or optimised: the module needs them.
        const pending = pendingMediaJobs(dir);
        if (pending.length) await waitForMediaJobs(dir, pending.map((job) => job.id));
        const published = await publishCourse(dir, {
          visibility, ...(flags.name ? { name: flags.name } : {}), ...(flags.image ? { image: path.resolve(flags.image) } : {}), index: flags.index,
          ...(progressValue ? { progress: progressValue as WebProgress } : {}), ...(navigation ? { navigation: navigation as WebNavigation } : {}), ...(flags.languages === 'all' ? { languages: 'all' as const } : {}),
          ...(flags['review-origin'] ? { reviewOrigins: flags['review-origin'] } : {}), onProgress: (p) => progress.report(p)
        });
        result = published;
        languages = published.report.languages;
      } else if (fs.existsSync(path.join(dir, 'index.html'))) {
        if (flags.image || flags.index || progressValue || navigation || flags.languages || flags['review-origin']) { console.error('✘ A built folder is published as it is: --image, --index, --progress, --navigation, --languages and --review-origin are for a course folder (build it with --languages all).'); return 2; }
        if (!flags.name) { console.error('✘ --name: the publication\'s name, for a folder already built.'); return 2; }
        result = await publishBuiltFolder(dir, { name: flags.name, visibility, onProgress: (p) => progress.report(p) });
      } else { console.error(`✘ ${path.resolve(dir)} is neither a course (course.json) nor a module built for the web (index.html).`); return 1; }
      progress.done();
      if (flags.json) printJson({ ok: true, ...('report' in result ? { ...result, report: undefined, ...(languages ? { languages } : {}) } : result) });
      else {
        printPublished(result);
        if (languages) console.log(`  In ${languages.join(', ')}: learners switch languages in the player.`);
      }
      return 0;
    } finally { progress.done(); }
  })
});

// ── review ─────────────────────────────────────────────────────────────

const reviewLine = (review: CloudReview) => `${review.id} « ${review.title} » · ${review.state} · ${review.publication} v${review.latest}${review.versions.length > 1 ? ` (${review.versions.length} versions)` : ''} · ${review.comments.open} open, ${review.comments.resolved} resolved · ${review.reviewers} reviewer${review.reviewers === 1 ? '' : 's'}`;

function checkReview(id: string | undefined, usage: string): string | null {
  if (!id) { console.error(usage); return null; }
  if (!isReviewId(id)) { console.error(`✘ ${JSON.stringify(id)} is not a review id (rv_…, as elabora review list gives them).`); return null; }
  return id;
}

function printLink(link: string, linkOut: string | undefined, json: boolean, extra: Record<string, unknown>): void {
  if (linkOut) {
    const file = writeLinkFile(linkOut, link);
    if (json) printJson({ ok: true, ...extra, linkWrittenTo: file });
    else console.log(`  The reviewers' link is in ${file} (readable by you only).`);
    return;
  }
  if (json) { printJson({ ok: true, ...extra, link }); return; }
  console.log(`  Link for reviewers, shown this once (elabora review link gives a new one and stops this one):\n  ${link}`);
}

const create = defineCommand({
  name: 'review create',
  flags: { name: 'string', version: 'string', title: 'string', note: 'string', 'link-out': 'string', json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const { dir, rest } = courseOf(positionals);
    if (rest.length) { console.error('Usage: elabora review create [dir] [--name <publication>] [--version <v>] [--title <t>] [--note <text>] [--link-out <file>] [--json]'); return 2; }
    const courseId = dir ? loadProjectFromDir(dir).course?.id : undefined;
    const publication = flags.name ?? (courseId ? defaultPublicationName(courseId, 'private') : undefined);
    if (!publication) { console.error('✘ --name: the private publication to review (or run in its course folder).'); return 2; }
    if (flags['link-out'] && fs.existsSync(path.resolve(flags['link-out']))) { console.error(`✘ ${path.resolve(flags['link-out'])} exists: not overwritten.`); return 1; }
    let created;
    try {
      created = await createReview(publication, { ...(flags.version ? { version: flags.version } : {}), ...(flags.title ? { title: flags.title } : {}), ...(flags.note ? { note: flags.note } : {}) });
    } catch (error) {
      if (error instanceof CloudError && error.code === 'not-published') throw new CloudError(error.status, error.code, `${error.message} Publish it first: elabora publish --private${flags.name ? ` --name ${flags.name}` : ''}.`);
      throw error;
    }
    const { review, link } = created;
    if (!flags.json) console.log(`✔ Review ${review.id} « ${review.title} » shares ${review.publication}, version ${review.latest}.${review.note ? `\n  Your note to reviewers: « ${review.note} »` : ''}`);
    printLink(link, flags['link-out'], flags.json, { review });
    return 0;
  })
});

const list = defineCommand({
  name: 'review list',
  flags: { all: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const { dir, rest } = courseOf(positionals);
    if (rest.length) { console.error('Usage: elabora review list [dir] [--all] [--json]'); return 2; }
    const courseId = !flags.all && dir ? loadProjectFromDir(dir).course?.id : undefined;
    let reviews: CloudReview[];
    let space: string;
    if (courseId) {
      const connection = await connect(undefined, { readOnly: true });
      space = connection.space;
      reviews = (await courseReviews(connection, courseId)).reviews;
    } else ({ space, reviews } = await listReviews());
    if (flags.json) { printJson({ space, course: courseId ?? null, reviews }); return 0; }
    if (!reviews.length) { console.log(courseId ? `No review of ${courseId} in the space ${space}: elabora publish --private, then elabora review create.` : `No review in the space ${space}.`); return 0; }
    for (const review of reviews) console.log(reviewLine(review));
    return 0;
  })
});

const link = defineCommand({
  name: 'review link',
  flags: { 'link-out': 'string', json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const id = checkReview(positionals[0], 'Usage: elabora review link <review> [--link-out <file>] [--json]');
    if (!id || positionals.length > 1) return 2;
    if (flags['link-out'] && fs.existsSync(path.resolve(flags['link-out']))) { console.error(`✘ ${path.resolve(flags['link-out'])} exists: not overwritten.`); return 1; }
    const { review, link: url } = await regenerateLink(id);
    if (!flags.json) console.log(`✔ New link for ${review.id} « ${review.title} »: the old one no longer opens it; reviewers keep their names.`);
    printLink(url, flags['link-out'], flags.json, { review });
    return 0;
  })
});

const close = defineCommand({
  name: 'review close',
  flags: { 'read-only': 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const id = checkReview(positionals[0], 'Usage: elabora review close <review> [--read-only] [--json]');
    if (!id || positionals.length > 1) return 2;
    const review = await setReviewState(id, flags['read-only'] ? 'read-only' : 'closed');
    if (flags.json) printJson({ ok: true, review });
    else console.log(flags['read-only'] ? `✔ ${review.id} is read-only: reviewers see the module and the comments, and write nothing more.` : `✔ ${review.id} is closed: its link shows nothing (elabora review open ${review.id} opens it again).`);
    return 0;
  })
});

const open = defineCommand({
  name: 'review open',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const id = checkReview(positionals[0], 'Usage: elabora review open <review> [--json]');
    if (!id || positionals.length > 1) return 2;
    const review = await setReviewState(id, 'open');
    if (flags.json) printJson({ ok: true, review });
    else console.log(`✔ ${review.id} is open again, under the same link.`);
    return 0;
  })
});

const remove = defineCommand({
  name: 'review delete',
  flags: { yes: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const id = checkReview(positionals[0], 'Usage: elabora review delete <review> --yes [--json]');
    if (!id || positionals.length > 1) return 2;
    if (!flags.yes) { console.error(`Deleting ${id} removes its comments, its reviewers and its link, and its private publication when no other review shows it. Nothing can bring them back. Again with --yes.`); return 2; }
    const result = await deleteReview(id);
    if (flags.json) printJson({ ok: true, ...result });
    else console.log(`✔ Review ${id} deleted with ${result.commentsDeleted} comment(s)${result.content ? `; ${result.review.publication} is unpublished` : ''}.`);
    return 0;
  })
});

// ── versions of a publication ──────────────────────────────────────────

const versionsOf = defineCommand({
  name: 'publication versions',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    if (positionals.length !== 1) { console.error('Usage: elabora publication versions <publication> [--json]'); return 2; }
    const { space, publication, versions } = await publicationVersions(positionals[0]!);
    if (flags.json) { printJson({ space, publication, versions }); return 0; }
    console.log(`${publication.name} · ${publication.visibility}${publication.url ? ` · ${publication.url}` : ''} · ${versions.length} version${versions.length === 1 ? '' : 's'} kept in the space ${space}`);
    for (const version of versions) console.log(`  ${version}${version === publication.version ? `  current, since ${day(publication.committedAt)}` : ''}`);
    return 0;
  })
});

const withdraw = defineCommand({
  name: 'publication withdraw',
  flags: { yes: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const [name, version] = positionals;
    if (!name || !version || positionals.length > 2) { console.error('Usage: elabora publication withdraw <publication> <version> --yes [--json]'); return 2; }
    if (!isVersionId(version)) { console.error(`✘ ${JSON.stringify(version)} is not a version (16 hexadecimal digits, as elabora publication versions gives them).`); return 2; }
    if (!flags.yes) { console.error(`Withdrawing ${version} takes it down for good: its pinned address answers 404 and the files only it used are deleted. A review that showed it keeps its comments and lists it as withdrawn. Again with --yes.`); return 2; }
    const result = await withdrawVersion(name, version);
    if (flags.json) printJson({ ok: true, ...result });
    else console.log(`✔ Version ${result.version} of ${result.name} withdrawn${result.reviews ? `; ${result.reviews} review${result.reviews === 1 ? '' : 's'} list${result.reviews === 1 ? 's' : ''} it as withdrawn` : ''}; ${result.blobsDeleted} file${result.blobsDeleted === 1 ? '' : 's'} deleted. The hosting's caches stop serving it within seconds; a browser that already has it may keep it.`);
    return 0;
  })
});

// ── comments, for people and their AI ──────────────────────────────────

const indent = (text: string, by: string) => text.split('\n').join(`\n${by}`);
const day = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function commentLines(comment: ResolvedComment): string[] {
  const { version, place } = comment;
  const out: string[] = [];
  const changes = [version.newerInReview ? `v${version.latest} is newer` : '', version.screenChanged === true ? 'the screen changed since' : version.screenChanged === false ? 'the screen is unchanged since' : ''].filter(Boolean);
  out.push(`#${comment.number} ${comment.state}${comment.deleted ? ' (deleted)' : ''} · on v${version.number} ${version.id}${version.course ? ` (course ${version.course})` : ''}${changes.length ? ` · ${changes.join(', ')}` : ''}`);
  if (place) {
    const screen = place.screen;
    out.push(`   screen  ${screen.id ? `${screen.id} « ${screen.title ?? ''} » → ${screen.file} (key ${screen.key})` : `key ${screen.key}: no screen has this key now (removed?)`}`);
    if (place.block) out.push(`   block   ${place.block.id} ${place.block.type ? `(${place.block.type}) at ${place.block.path}${place.block.layer ? ` in layer ${place.block.layer}` : ''}` : '— not in this screen now (renamed, moved or removed)'}`);
    const more = [
      // Step 0 without a label: the screen as it opens (every anchor says its step).
      place.step && (place.step.number > 0 || place.step.label) ? `step ${place.step.number}${place.step.label ? ` « ${place.step.label} »` : ''}` : '',
      place.layer ? `layer ${place.layer.id}${place.layer.title ? ` « ${place.layer.title} »` : ''}${place.layer.found ? '' : ' (not in this screen now)'}` : '',
      place.translation ? `in ${place.language} → ${place.translation}` : ''
    ].filter(Boolean);
    if (more.length) out.push(`   ${more.join(' · ')}`);
    if (place.line) {
      const word = place.line.word ? ` · word ${place.line.word.index ?? '?'}${place.line.word.text ? ` « ${place.line.word.text} »` : ''}${place.line.word.occurrence && place.line.word.occurrence > 1 ? ` (${place.line.word.occurrence}th time)` : ''}` : '';
      out.push(`   line    ${place.line.id}${place.line.speaker ? ` (${place.line.speaker})` : ''}${place.line.text ? `: « ${place.line.text.length > 90 ? `${place.line.text.slice(0, 89)}…` : place.line.text} »` : ' — not in the narration now'}${word}`);
    }
    const seen = [place.time !== null ? `at ${place.time} s` : '', place.point ? `point ${place.point.x}, ${place.point.y}` : '', place.frame ? `in a ${place.frame.width}×${place.frame.height} frame` : ''].filter(Boolean);
    if (seen.length) out.push(`   ${seen.join(' · ')}`);
  }
  out.push(`   ${comment.by.name} (${comment.by.kind}), ${day(comment.createdAt)}${comment.editedAt ? ', edited' : ''}: ${indent(comment.deleted ? '(deleted)' : comment.text, '     ')}`);
  for (const reply of comment.replies) out.push(`     ↳ ${reply.by.name} (${reply.by.kind}), ${day(reply.createdAt)}: ${indent(reply.deleted ? '(deleted)' : reply.text, '       ')}`);
  return out;
}

export function commentsText(result: ResolvedComments): string {
  const { review } = result;
  const lines = [`Review ${review.id} « ${review.title} » (${review.state}) · ${review.publication}, latest v${review.latest} · ${review.comments.open} open, ${review.comments.resolved} resolved`];
  if (result.course.id) lines.push(`Course ${result.course.id} ${result.course.version} in ${result.course.dir}`);
  lines.push('');
  if (!result.comments.length) lines.push(result.since !== null ? `Nothing new since rev ${result.since}.` : 'No comment yet.');
  for (const comment of result.comments) lines.push(...commentLines(comment), '');
  lines.push(`Only what changed next time: elabora review comments --review ${review.id} --since ${result.rev}`);
  return lines.join('\n');
}

const comments = defineCommand({
  name: 'review comments',
  flags: { review: 'string', since: 'string', state: 'string', screen: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const { dir, rest } = courseOf(positionals);
    if (rest.length) { console.error('Usage: elabora review comments [dir] [--review <review>] [--since <rev>] [--state open|resolved] [--screen <id>] [--json]'); return 2; }
    if (flags.review !== undefined && !isReviewId(flags.review)) { console.error(`✘ --review: a review id (rv_…), not "${flags.review}".`); return 2; }
    if (!flags.review && !dir) { console.error('✘ Run in a course folder (its reviews), or name one with --review rv_….'); return 2; }
    const since = flags.since === undefined ? undefined : Number(flags.since);
    if (since !== undefined && !(Number.isInteger(since) && since >= 0)) { console.error('✘ --since: the rev a previous answer gave (a whole number).'); return 2; }
    if (flags.state !== undefined && flags.state !== 'open' && flags.state !== 'resolved') { console.error(`--state is open or resolved (not "${flags.state}").`); return 2; }
    const results = await reviewComments({ ...(flags.review ? { review: flags.review } : {}), courseDir: dir, ...(since !== undefined ? { since } : {}), ...(flags.screen ? { screen: flags.screen } : {}), ...(flags.state ? { state: flags.state as 'open' | 'resolved' } : {}) });
    if (flags.json) { printJson({ reviews: results }); return 0; }
    if (!results.length) { console.log('No open review of this course: elabora review list --all shows the space\'s.'); return 0; }
    console.log(results.map(commentsText).join('\n\n'));
    return 0;
  })
});

const reply = defineCommand({
  name: 'review reply',
  flags: { name: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
    const [id, comment, ...words] = positionals;
    if (!checkReview(id, 'Usage: elabora review reply <review> <comment> [text] [--name <n>] [--json]') || !comment) { if (id && !comment) console.error('Usage: elabora review reply <review> <comment> [text] [--name <n>] [--json]'); return 2; }
    const text = (words.length ? words.join(' ') : process.stdin.isTTY ? '' : await readAllInput()).trim();
    if (!text) { console.error('✘ No text: give it after the comment, or on the input.'); return 2; }
    const answer = await replyToComment(id!, comment, text, flags.name ? { name: flags.name } : {});
    if (flags.json) printJson({ ok: true, comment: answer });
    else console.log(`✔ Answered in thread ${comment.startsWith('cm_') ? comment : `#${comment.replace(/^#/, '')}`} as ${answer.by.name}.`);
    return 0;
  })
});

function stateCommand(name: 'review resolve' | 'review reopen', state: 'resolved' | 'open') {
  return defineCommand({
    name,
    flags: { json: 'boolean' },
    run: ({ positionals, flags }) => cloudFailures(flags.json, async () => {
      const [id, comment, ...extra] = positionals;
      const usage = `Usage: elabora ${name} <review> <comment> [--json]`;
      if (!checkReview(id, usage) || !comment || extra.length) { if (id && (!comment || extra.length)) console.error(usage); return 2; }
      const answer = await setCommentState(id!, comment, state);
      if (flags.json) printJson({ ok: true, comment: answer });
      else console.log(`✔ Thread #${answer.number} is ${answer.state}.`);
      return 0;
    })
  });
}

export const accountCommands: CommandGroup = {
  title: 'Hosting: account (elabora.studio)',
  help: ACCOUNT_HELP,
  commands: [login, handle, status, logout, aiKey],
  subcommandUsage: { account: `Usage: elabora account login|handle|status|logout|ai-key\n\n${ACCOUNT_HELP}` }
};

export const publishCommands: CommandGroup = {
  title: 'Hosting: publishing and review',
  help: `${PUBLISH_HELP}\n${REVIEW_HELP}`,
  commands: [publish, versionsOf, withdraw, create, list, link, close, open, remove, comments, reply, stateCommand('review resolve', 'resolved'), stateCommand('review reopen', 'open')],
  subcommandUsage: {
    publication: `Usage: elabora publication versions|withdraw\n\n${PUBLISH_HELP}`,
    review: `Usage: elabora review create|list|link|close|open|delete|comments|reply|resolve|reopen\n\n${REVIEW_HELP}`
  }
};
