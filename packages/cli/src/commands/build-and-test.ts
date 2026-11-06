import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proofMarkdown } from '@elabora/core/compile/proof';
import { listProfiles } from '@elabora/core/lms/profiles';
import { DELIVERY_FORMATS, formatReason, isDeliveryFormat } from '@elabora/core/lms/formats';
import { screenOrder } from '@elabora/core/project/load';
import type { BuildReport } from '@elabora/core/compile/report';
import type { UpdateReport } from '@elabora/core/update-impact';
import { stringifyJSON } from '@elabora/core/util/json';
import { build, WEB_DEFAULTS, WEB_NAVIGATION, WEB_PROGRESS } from '@elabora/node/build';
import { buildLanguagePackages, languagePackagesOf } from '@elabora/node/language-packages';
import type { BuildResult, WebBuildOptions } from '@elabora/node/build';
import type { PackageRun, PackageTestResult } from '@elabora/node/emulator/run';
import type { FitResult, FitSize } from '@elabora/node/fit';
import type { Shot } from '@elabora/node/capture';
import { OBJECTS_AT_NOTE } from '@elabora/node/look-client';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { writeFileAtomic } from '@elabora/node/util/fs';
import { readZip } from '@elabora/node/zip';
import { isPresetName } from '@elabora/core/media/presets';
import { isFinished } from '@elabora/node/media/jobs';
import { defineCommand, errorMessage, languagesFlag, notACourseMessage, printDiagnostics, printJson, unknownProfileMessage } from './command.ts';
import { mediaProgress } from '../media-progress.ts';
import { look } from './look.ts';
import { pendingMediaJobs, waitForMediaJobs } from './media.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  build [dir] [--profile a,b|all] [--release] [--out <dir>] [--dir] [--debug] [--media-quality high|medium|low] [--languages all|<a,b>] [--packages one|each] [--no-wait] [--json]
        [--format scorm12|scorm2004|cmi5|xapi] [--lrs-key <key> --lrs-secret <secret>] [--target web] [--progress local|none]
        [--navigation authored|free] [--noindex] [--url <address>] [--image <file>] [--review-origin <origin>]…
                                                      Validate, then make the package for the LMS and its proof dossier in
                                                      dist/ (deterministic: same files, same bytes). Media ship at
                                                      delivery.mediaQuality (default high: the masters); lower qualities
                                                      ship renditions, encoded once and cached. Waits for running media
                                                      jobs (--no-wait: fails while they run).
                                                      The format: the module's (course.json delivery.format), else the best
                                                      for its LMSs (delivery.lms), else SCORM 1.2, which every LMS takes;
                                                      --format says it for this build. xAPI needs an LRS: the LMS's, or
                                                      delivery.lrs with its key (--lrs-key and --lrs-secret, else
                                                      ELABORA_LRS_KEY and ELABORA_LRS_SECRET), which the package carries.
                                                      --languages en,fr: the package's languages (default: course.json
                                                      delivery.languages, else the course's own), which learners switch
                                                      from the player's « Langue », keeping their progress (D59). Each is
                                                      put in as it is: a translation not approved or with texts still to
                                                      translate goes in with a warning (D71). --languages all: the
                                                      course's own and each translation ready and approved.
                                                      --packages each: one package per language instead (default:
                                                      course.json delivery.languagePackages), for LMSs that manage the
                                                      language versions of a course themselves (Docebo, SuccessFactors).
                                                      --target web: a module for any web server, outside an LMS (a folder to
                                                      serve and its ZIP, <course>-<version>-web). --progress local (default:
                                                      kept in the browser, resumed at the next visit) or none (nothing kept);
                                                      --navigation authored (default: the course's rules) or free (every
                                                      screen open); --noindex keeps search engines out; --url: the address
                                                      of its index.html (canonical, sharing previews); --image: a PNG, JPEG or
                                                      WebP shown when the link is shared. A showcase: --progress none
                                                      --navigation free; a publication: the defaults.
                                                      --review-origin (repeatable): a module for the Revue, shown in an
                                                      iframe by a page of that origin (https://revue.elabora.studio; http
                                                      on localhost for development): it carries the review bridge
                                                      (elabora-review/1, docs/review-bridge.md) and talks to that page
                                                      only; progress none, navigation free and noindex by default
  test [dir] [--package <zip>] [--profile a,b|all] [--format <format>] [--mode iframe,popup…] [--browser chromium,electron,chrome,msedge,playwright,firefox,webkit] [--parallel 4] [--no-a11y] [--json]
                                                      Build, then run the package in the LMS emulator (profiles × launch modes
                                                      × browsers), in the package's format (--package: any package, its format
                                                      read from its files). 4 runs side by side by default; fewer on a loaded machine
  preview [dir] [--port 4807] [--profile <id>] [--navigation authored|free]
                                                      Serve the course on this computer, alone and in the LMS emulator; pages
                                                      reload when its files change. Free objects show in agent apps' in-app
                                                      browsers. The emulator plays the course's LMS (--profile: another one);
                                                      --navigation free opens every screen, whatever the course's rules
  look [dir] [--screen <id>,…|all] [--size 1600x900,375x812] [--state initial|answered] [--step <n>] [--layer <id>]
       [--at <moment> | --sheet] [--scroll <px|N%|block>,…] [--block <id> [--scale 2] [--act <action>]…] [--viewport] [--motion]
       [--language <code>] [--controls] [--select <css>] [--out shot.jpg | --out-dir <dir>] [--json] | --url | --stop
                                                      Capture a screen while designing, in under a second: a look server kept warm
                                                      for the course (one browser, no build) renders it from its files as they are,
                                                      with the player's header and footer; free objects keep running across edits
                                                      that leave them alone. JPEG (PNG: --out x.png), in .elabora/look/ by default.
                                                      Says whether a slide fits. --url: a page that follows the looks and the files,
                                                      for a browser pane. --stop: stop the server (it stops itself after 15 idle
                                                      minutes).
                                                      --at: a timed screen at a moment, the window with its bar: l2 (a line starts,
                                                      its caption shown), l2:end, l2:imprimante (a word), l2:imprimante+0.3s,
                                                      1.5s@2, step2:end, 12.5 (seconds). --sheet: a contact sheet, one capture per
                                                      mark of its timeline (start, each block that comes or goes, each cue, each
                                                      step's end), captioned with the anchor and what happens; on a screen without a
                                                      timeline, the page down its length (0, 25, 50, 75, 100 % or --scroll's). With
                                                      --layer, a layer that has its own timeline: --at and --sheet are on it.
                                                      --scroll: the window there, animations on (px, % of the page, or a block's id);
                                                      several: a sheet down the page. --block: a close-up of the block (PNG up to 2
                                                      Mpx, else JPEG; in view unless --scroll says where), --scale 2 drawn twice as
                                                      large. With --scroll, --block or --motion it says what moves: each block in
                                                      the window (or the block) visible, clipped or outside, its animations and
                                                      transitions, their timeline and progress, and the scroll-driven ones that
                                                      CANNOT FINISH (the page ends before their range). --act (repeatable) drives
                                                      the free object of --block from inside its frame before the capture:
                                                      click:<text>, click:role=<role>[name=<n>], key:<key>, drag:x,y->x,y (0-1 across
                                                      the object); it reports the object's state and events, and the object keeps
                                                      that state until the screen changes. On a dialogue block, choose:<option>
                                                      (one per decision met, retries included, as dialogue play) shows its thread
                                                      at rest after those choices, its end in the window: notes, the next options,
                                                      or the debrief. On a screen with free objects it says each control the
                                                      page covers (a click on its middle would not reach it); --controls lists
                                                      every control with its box in the window, instead of looking for them.
                                                      --select <css>: the computed styles of what it matches (a layout's title, an
                                                      ornament) and its parent's layout
  screenshot [dir] [--screen <id>,…|all] [--size 1600x900,375x812] [--state initial,answered] [--step <n>] [--layer <id>]
             [--at 0,2000,4000|l1,l2:end | --scroll 0,25%,50%,1800] [--motion] [--viewport] [--language <code> [--allow-missing]]
             [--from <screen>] [--out shot.png | --out-dir <dir>]
                                                      Render screens to PNG once images and free objects are ready. answered: every
                                                      activity shows its tallest feedback. --at: filmstrip of the animations (ms),
                                                      or of a narrated screen as each line starts (l2) or ends (l2:end), with
                                                      --layer of that layer's own timeline; with --from <screen>, the passage from
                                                      that screen (times from the move, animations on: continuity, the backdrop);
                                                      --scroll: filmstrip down the page (px or % of it: scroll-driven animations and
                                                      objects). One contact sheet. Several shots share one build and one browser;
                                                      --out names one image, so several shots are refused with it (exit code 2):
                                                      --out-dir gets one file each
  fit [dir] [--screen <id>,…] [--reference 1600x900] [--minimum 1280x720] [--phone 375x812|none] [--language <code> [--allow-missing]] [--fresh] [--json]
                                                      Measure every slide (all steps shown) at the fit sizes: what scrolls, by how
                                                      much, and what moves once its activities are answered. In scroll presentation:
                                                      the length of each page and the contrast of its text, down the whole page.
                                                      On a phone (375×812 unless sizes are given): the contrast of the text down
                                                      the page and the player's bars that go onto two lines. --language: the
                                                      translation (--allow-missing: a draft, missing texts in the source language).
                                                      A screen unchanged since its last measure (its files, the theme, components,
                                                      objects, Elabora, the browser) keeps its last fit (--fresh measures every
                                                      screen again)
  inspect <package.zip>                               Read any SCORM package: manifest, files, size
  diff <old.report.json> <new.report.json> [--profile a,b]
                                                      What an update does to learners in progress, LMS by LMS
  profiles [--json]                                   List the LMS profiles the emulator plays (ids for --profile)`;

const buildCommand = defineCommand({
  name: 'build',
  flags: {
    profile: 'list', release: 'boolean', out: 'string', dir: 'boolean', debug: 'boolean', 'media-quality': 'string', languages: 'string', packages: 'string', 'no-wait': 'boolean', json: 'boolean',
    target: 'string', format: 'string', 'lrs-key': 'string', 'lrs-secret': 'string', progress: 'string', navigation: 'string', noindex: 'boolean', url: 'string', image: 'string', 'review-origin': 'list'
  },
  async run({ positionals: [dir = '.'], flags }) {
    const quality = flags['media-quality'];
    if (quality !== undefined && !isPresetName(quality)) { console.error(`--media-quality is high, medium or low (not "${quality}").`); return 2; }
    const languages = languagesFlag(flags.languages);
    if (languages === null) { console.error(`--languages is all or a list of language tags such as en,fr (not "${flags.languages}").`); return 2; }
    if (flags.packages !== undefined && flags.packages !== 'one' && flags.packages !== 'each') { console.error(`--packages is one or each (not "${flags.packages}").`); return 2; }
    if (flags.packages === 'each' && flags.target === 'web') { console.error('--packages each: one LMS package per language; a module for the web holds every language in one.'); return 2; }
    // --format: the package's format for the LMS (default: the module's, course.json delivery.format,
    // else the best for its LMSs); --target web: a module for the web; --target <format> says --format.
    const target = flags.target;
    if (target !== undefined && target !== 'web' && !isDeliveryFormat(target)) { console.error(`--target is web or a format, ${DELIVERY_FORMATS.join(', ')} (not "${target}").`); return 2; }
    const format = flags.format ?? (target !== 'web' ? target : undefined);
    if (format !== undefined && !isDeliveryFormat(format)) { console.error(`--format is ${DELIVERY_FORMATS.join(', ')} (not "${format}").`); return 2; }
    if (format !== undefined && target === 'web') { console.error('--format: a module for the web has no LMS format.'); return 2; }
    const webFlags = (['progress', 'navigation', 'url', 'image', 'review-origin'] as const).filter((name) => flags[name] !== undefined).map((name) => `--${name}`).concat(flags.noindex ? ['--noindex'] : []);
    if (target !== 'web' && webFlags.length) { console.error(`${webFlags.join(', ')}: for --target web only.`); return 2; }
    if (target === 'web' && flags.profile) { console.error('--profile: LMS profiles are for SCORM packages; a module for the web reports to no LMS.'); return 2; }
    const { progress: kept, navigation } = flags;
    if (kept !== undefined && !WEB_PROGRESS.some((value) => value === kept)) { console.error(`--progress is local or none (not "${kept}").`); return 2; }
    if (navigation !== undefined && !WEB_NAVIGATION.some((value) => value === navigation)) { console.error(`--navigation is authored or free (not "${navigation}").`); return 2; }
    const profileError = await unknownProfileMessage(flags.profile);
    if (profileError) { console.error(profileError); return 2; }
    // A folder without a course: one line (--json keeps its findings, for scripts).
    const missing = flags.json ? null : notACourseMessage(dir);
    if (missing) { console.error(missing); return 1; }
    // A review build takes the review's defaults (progress none, navigation free, noindex) for what
    // is not said.
    const origins = flags['review-origin'];
    const web: WebBuildOptions | undefined = target === 'web' ? {
      ...(kept !== undefined || !origins ? { progress: WEB_PROGRESS.find((value) => value === kept) ?? WEB_DEFAULTS.progress } : {}),
      ...(navigation !== undefined || !origins ? { navigation: WEB_NAVIGATION.find((value) => value === navigation) ?? WEB_DEFAULTS.navigation } : {}),
      ...(flags.noindex || !origins ? { noindex: flags.noindex } : {}),
      ...(flags.url !== undefined ? { url: flags.url } : {}), ...(flags.image !== undefined ? { image: path.resolve(flags.image) } : {}),
      ...(origins ? { review: { origins } } : {})
    } : undefined;
    // Media being imported or optimised: the package needs them.
    const pending = pendingMediaJobs(dir);
    if (pending.length) {
      if (flags['no-wait']) {
        console.error(`✘ ${pending.length} media job(s) still running: ${pending.map((job) => job.output).join(', ')}. Wait for them (elabora media status --wait), or build without --no-wait.`);
        return 1;
      }
      await waitForMediaJobs(dir, pending.map((job) => job.id));
    }
    const progress = mediaProgress();
    // One package per language (delivery.languagePackages "each", or --packages each; D71): LMS packages only.
    const each = target !== 'web' && (flags.packages ?? languagePackagesOf(dir)) === 'each';
    if (each) {
      const made = await buildLanguagePackages(dir, {
        profiles: flags.profile, release: flags.release, out: flags.out, emit: flags.dir ? 'both' : 'zip', debug: flags.debug,
        ...(format ? { target: format } : {}), ...(quality ? { mediaQuality: quality } : {}), ...(languages ? { languages } : {}),
        onMedia: ({ job }) => (isFinished(job.status) ? progress.complete(job) : progress.progress(job))
      });
      const ok = made.every((one) => one.result.ok);
      if (flags.json) printJson({ ok, packages: made.map(({ language, result, translation }) => ({ language, ok: result.ok, summary: result.summary, zip: result.zipPath, dir: result.dirPath, report: result.reportPath, package: result.report?.package, budget: result.report?.budget, ...(translation ? { translation: { units: translation.units, untranslated: translation.untranslated, plan: translation.plan } } : {}), diagnostics: result.diagnostics })) });
      else {
        for (const { language, result } of made) {
          console.log(`\n${language}`);
          printDiagnostics(result.diagnostics);
          if (result.ok && result.zipPath && result.report) console.log(`✔ ${result.zipPath}\n  ${result.report.package.files} files, ${(result.report.package.bytes / 1024).toFixed(0)} KB`);
          else console.log(`✘ Build stopped: ${result.summary.errors} error(s).`);
        }
        console.log(`\n${ok ? '✔' : '✘'} ${made.filter((one) => one.result.ok).length}/${made.length} packages, one per language: ${made.map((one) => one.language).join(', ')}.`);
      }
      return ok ? 0 : 1;
    }
    const result = await build(dir, {
      profiles: flags.profile, release: flags.release, out: flags.out, emit: flags.dir || web ? 'both' : 'zip', debug: flags.debug, ...(web ? { target: 'web' as const, web } : format ? { target: format } : {}),
      ...(flags['lrs-key'] !== undefined || flags['lrs-secret'] !== undefined ? { lrs: { key: flags['lrs-key'] ?? '', secret: flags['lrs-secret'] ?? '' } } : {}),
      ...(quality ? { mediaQuality: quality } : {}),
      ...(languages ? { languages } : {}),
      onMedia: ({ job }) => (isFinished(job.status) ? progress.complete(job) : progress.progress(job))
    });
    if (flags.json) printJson({ ok: result.ok, summary: result.summary, zip: result.zipPath, dir: result.dirPath, report: result.reportPath, package: result.report?.package, media: result.report?.media, budget: result.report?.budget, ...(result.report?.web ? { web: result.report.web } : {}), diagnostics: result.diagnostics });
    else {
      printDiagnostics(result.diagnostics);
      const { report, zipPath, reportPath } = result;
      const tracking = report?.web
        ? `\n  folder to serve: ${result.dirPath}\n  progress ${report.web.progress}, navigation ${report.web.navigation}${report.web.noindex ? ', noindex' : ''}${report.web.url ? `, at ${report.web.url}` : ''}${report.web.review ? `\n  review bridge for ${report.web.review.origins.join(', ')}` : ''}`
        : `\n  ${report?.delivery ? `${report.delivery.name}, ${formatReason(report.delivery)}\n  ` : ''}suspend_data worst case ${report?.budget.suspendDataWorstCase} / ${report?.budget.suspendDataLimit}`;
      if (result.ok && report && zipPath) console.log(`\n✔ ${zipPath}\n  ${report.package.files} files, ${(report.package.bytes / 1024).toFixed(0)} KB, sha256 ${report.package.sha256.slice(0, 16)}…${report.media ? `\n  media at the ${report.media.quality} quality: ${report.media.files.length} file(s)${report.media.files.some((f) => f.rendition) ? `, ${report.media.files.filter((f) => f.rendition).length} rendition(s)` : ''}` : ''}${tracking}\n  proof dossier: ${reportPath.replace(/\.report\.json$/, '.proof.md')}`);
      else console.log(`\n✘ Build stopped: ${result.summary.errors} error(s).`);
    }
    return result.ok ? 0 : 1;
  }
});

// The fit of slides measured during a test, as the build report records it.
type PackageTestWithFit = PackageTestResult & { fit?: FitResult };

const test = defineCommand({
  name: 'test',
  flags: { package: 'string', profile: 'list', mode: 'list', browser: 'list', parallel: 'string', 'no-a11y': 'boolean', out: 'string', format: 'string', json: 'boolean' },
  async run({ positionals: [dir = '.'], flags }) {
    const profileError = await unknownProfileMessage(flags.profile);
    if (profileError) { console.error(profileError); return 2; }
    const missing = flags.package || flags.json ? null : notACourseMessage(dir);
    if (missing) { console.error(missing); return 1; }
    const { testPackage, TIMED_OUT } = await import('@elabora/node/emulator/run');
    const runLine = (run: PackageRun) => `${run.ok ? '✔' : '✘'} ${run.profile.padEnd(15)} ${run.launch.padEnd(14)} ${run.browser}${run.retried ? ' (run again alone after a timeout)' : ''}${run.ok ? '' : `\n    ${run.failures.map((f) => `${f.code}: ${f.message}`).join('\n    ')}`}`;
    const onRun = flags.json ? undefined : (run: PackageRun) => console.log(runLine(run));
    const parallel = Number(flags.parallel) || undefined;
    const report = (result: PackageTestWithFit, reportPath: string | null) => {
      if (flags.json) printJson({ ok: result.ok, runs: result.runs, accessibility: result.accessibility, fit: result.fit, diagnostics: result.diagnostics });
      else {
        if (result.accessibility) console.log(`axe-core: ${result.accessibility.violations} violation(s) on ${result.accessibility.screens} screen states.`);
        for (const d of result.diagnostics.filter((d) => d.code === 'E_GATE_A11Y' || d.code === 'W_RENDER_OVERFLOW')) console.log(`  ${d.code === 'W_RENDER_OVERFLOW' ? 'warning W_RENDER_OVERFLOW ' : ''}${d.message}`);
        if (result.fit?.mode === 'slides') for (const size of result.fit.sizes.filter((size) => size.role !== 'phone')) console.log(`Slides at ${size.size.replace('x', '×')} (${size.role}): ${size.screens.filter((s) => !s.overflow).length}/${size.screens.length} fit.`);
        else if (result.fit?.mode === 'scroll') console.log(`Pages (scroll presentation): text contrast measured down ${result.fit.sizes[0]?.screens.length ?? 0} page(s).`);
        for (const d of result.diagnostics.filter((d) => ['W_SLIDE_OVERFLOW', 'I_SLIDE_OVERFLOW_MINIMUM', 'W_SLIDE_SHIFT', 'W_TEXT_CONTRAST_MEASURED', 'W_PLAYER_BAR_WRAPS', 'W_SCROLL_ANIMATION_UNFINISHED'].includes(d.code))) console.log(`  ${d.severity} ${d.code} ${d.message}`);
        console.log(`\n${result.ok ? '✔' : '✘'} ${result.runs.filter((run) => run.ok).length}/${result.runs.length} runs passed.${reportPath ? ` Results added to ${path.basename(reportPath)}.` : ''}`);
        // Runs that waited too long fail on a loaded machine more than in the course.
        const late = result.runs.filter((run) => !run.ok && run.failures.some((failure) => TIMED_OUT.test(failure.message)));
        if (late.length) console.log(`  ${late.length} run(s) failed on a timeout${result.runs.some((run) => run.retried) ? ', run again alone' : ''} (load average ${os.loadavg()[0].toFixed(1)} on ${os.availableParallelism()} cores): try again when the machine is quieter before looking for a cause in the course.`);
      }
      return result.ok ? 0 : 1;
    };
    if (flags.package) {
      return report(await testPackage({ zip: path.resolve(flags.package), profiles: flags.profile, browsers: flags.browser, modes: flags.mode, accessibility: false, onRun, parallel }), null);
    }
    const format = flags.format;
    if (format !== undefined && !isDeliveryFormat(format)) { console.error(`--format is ${DELIVERY_FORMATS.join(', ')} (not "${format}").`); return 2; }
    const built = await build(dir, { profiles: flags.profile, emit: 'both', out: flags.out, ...(format ? { target: format } : {}) });
    if (!built.ok || !built.dirPath || !built.zipPath) {
      printDiagnostics(built.diagnostics, { json: flags.json });
      console.log('✘ Build failed: fix the errors before testing.');
      return 1;
    }
    const { dirPath, reportPath } = built;
    if (!flags.json) console.log(`Built ${path.basename(built.zipPath)}${built.report.delivery ? ` (${built.report.delivery.name}, ${formatReason(built.report.delivery)})` : ''}. Running it in the LMS emulator…`);
    // The LMSs the build targeted: --profile, else course.json delivery.lms, else the unknown LMS.
    const tested = await testPackage({ dir: dirPath, profiles: flags.profile ?? built.report.profiles.map((profile) => profile.id), browsers: flags.browser, modes: flags.mode, accessibility: !flags['no-a11y'], onRun, parallel });
    const result: PackageTestWithFit = { ...tested, diagnostics: [...tested.diagnostics] };
    // Slides: measured at the fit sizes of the course (reference and minimum). Pages of a scroll
    // presentation: the contrast of their text, down each page.
    const { measureFit, fitDiagnostics } = await import('@elabora/node/fit');
    const fit = await measureFit(null, { pkgDir: dirPath });
    if (fit.ok) { result.fit = fit; result.diagnostics.push(...fitDiagnostics(fit)); }
    const buildReport: BuildReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    buildReport.tests = {
      at: new Date().toISOString(),
      runs: result.runs.map((run) => ({ profile: run.profile, launch: run.launch, browser: run.browser, browserVersion: run.browserVersion, ok: run.ok, checks: run.checks, failures: run.failures })),
      accessibility: result.accessibility ?? null,
      fit: result.fit?.mode !== 'slides' ? undefined : result.fit.sizes.flatMap((size) => (size.role === 'phone' ? [] : [{ role: size.role, size: size.size, screens: size.screens.length, fit: size.screens.filter((s) => !s.overflow).length, overflow: size.screens.filter((s) => s.overflow).map((s) => ({ screen: s.screen ?? '', px: s.overflow })) }]))
    };
    writeFileAtomic(reportPath, stringifyJSON(buildReport));
    writeFileAtomic(reportPath.replace(/\.report\.json$/, '.proof.md'), proofMarkdown(buildReport));
    return report(result, reportPath);
  }
});

const previewCommand = defineCommand({
  name: 'preview',
  flags: { port: 'string', profile: 'string', navigation: 'string' },
  async run({ positionals: [dir = '.'], flags }) {
    const { navigation } = flags;
    if (navigation !== undefined && !WEB_NAVIGATION.some((value) => value === navigation)) { console.error(`--navigation is authored or free (not "${navigation}").`); return 2; }
    const profileError = await unknownProfileMessage(flags.profile === undefined ? undefined : [flags.profile], { all: false });
    if (profileError) { console.error(profileError); return 2; }
    const missing = notACourseMessage(dir);
    if (missing) { console.error(missing); return 1; }
    const { preview } = await import('@elabora/node/preview');
    // The preview shows the course with the errors that only stop a delivery (accessibility, plan
    // coverage, package limits): they are still said.
    const codes = (result: BuildResult) => result.diagnostics.filter((d) => d.severity === 'error' && !d.waived).map((d) => d.code).join(', ');
    const onRebuild = (result: BuildResult) => console.log(result.ok ? `↻ rebuilt${codes(result) ? ` (errors to fix before a delivery: ${codes(result)})` : ''}` : `✘ ${result.summary.errors} error(s): ${codes(result)}`);
    const port = Number(flags.port) || 4807;
    let session: Awaited<ReturnType<typeof preview>>;
    try {
      session = await preview(dir, { port, ...(flags.profile ? { profile: flags.profile } : {}), navigation: WEB_NAVIGATION.find((value) => value === navigation) ?? 'authored', onRebuild });
    } catch (error) {
      // Another preview (or any server) holds the port: say so, and how to pick another.
      if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error;
      console.error(`✘ Port ${port} is in use. Pick another one: elabora preview ${dir} --port ${port + 1}`);
      return 1;
    }
    if (session.result.summary.errors) printDiagnostics(session.result.diagnostics);
    console.log(`Preview (standalone): ${session.urls.standalone}\nPreview in the LMS emulator: ${session.urls.lms}\nWatching for changes. Ctrl+C to stop.`);
    await new Promise(() => {});
    return 0;
  }
});

const screenshot = defineCommand({
  name: 'screenshot',
  flags: { screen: 'list', size: 'list', width: 'string', height: 'string', state: 'list', step: 'string', layer: 'string', at: 'list', scroll: 'list', motion: 'boolean', viewport: 'boolean', language: 'string', 'allow-missing': 'boolean', from: 'string', out: 'string', 'out-dir': 'string' },
  async run({ positionals: [dir = '.'], flags }) {
    // Every combination of screens × sizes × states, in one build and one browser.
    const { capture } = await import('@elabora/node/capture');
    const sizes = flags.size?.map((size) => size.split('x').map(Number)) || [[Number(flags.width) || 1600, Number(flags.height) || 900]];
    let screens: (string | undefined)[] = flags.screen || [undefined];
    if (screens[0] === 'all') screens = screenOrder(loadProjectFromDir(dir)).map((entry) => entry.id);
    const states = flags.state || ['initial'];
    // Times in ms, or narration lines (l2, l2:end).
    const at = flags.at?.map((value) => (/^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value.trim()));
    if (flags.from && !at?.length) { console.error('✘ --from films a passage: give --at the moments to capture (ms from the move), e.g. --at 0,300,600,900.'); return 2; }
    const shots: Shot[] = [];
    for (const screen of screens) for (const [width, height] of sizes) for (const state of states) {
      shots.push({ screen, width, height, state, step: flags.step ? Number(flags.step) : undefined, layer: flags.layer, at, scroll: flags.scroll, motion: flags.motion || !!flags.from, fullPage: !flags.viewport, ...(flags.from ? { from: flags.from } : {}) });
    }
    // --out names the file of one shot. For several, the files would go where --out says nothing of:
    // into screenshots/ of the folder the command runs in (the course's, for an agent), unasked.
    if (shots.length > 1 && flags.out) { console.error(`✘ --out names one image, and ${shots.length} shots were asked (${screens.length} screen(s) × ${sizes.length} size(s) × ${states.length} state(s)): give --out-dir <dir>, which gets one file per shot (<screen>-<width>x<height>.png).`); return 2; }
    if (flags.out && flags['out-dir']) { console.error('✘ Give --out (one image) or --out-dir (a folder), not both.'); return 2; }
    if (flags['allow-missing'] && !flags.language) { console.error('✘ --allow-missing goes with --language <code>.'); return 2; }
    const { withCourseLanguage } = await import('@elabora/node/translate');
    let result: Awaited<ReturnType<typeof capture>>;
    try {
      result = await withCourseLanguage(dir, { language: flags.language, allowMissing: flags['allow-missing'] }, (root) => capture(root, shots));
    } catch (error) {
      console.error(`✘ ${errorMessage(error)}`);
      return 2;
    }
    if (!result.shots) { printDiagnostics(result.diagnostics); return 1; }
    // A filmstrip shows the screen's own animations; free objects run on their own clock.
    if (at && result.shots.some((taken) => taken.ok && taken.objects?.length)) console.log(`note: ${OBJECTS_AT_NOTE}`);
    const many = shots.length > 1 || !!flags['out-dir'];
    const outDir = path.resolve(flags['out-dir'] || 'screenshots');
    if (many) fs.mkdirSync(outDir, { recursive: true });
    for (const [index, taken] of result.shots.entries()) {
      const shot = shots[index];
      if (!taken.ok) { console.log(`✘ ${shot.screen || '(first screen)'} ${shot.width}×${shot.height}: ${taken.error}`); continue; }
      const name = `${taken.screen}-${taken.width}x${taken.height}${taken.state !== 'initial' ? `-${taken.state}` : ''}${shot.step ? `-step${shot.step}` : ''}${shot.layer ? `-${shot.layer}` : ''}${taken.scroll ? '-scroll' : taken.frames ? '-film' : ''}.png`;
      const file = many ? path.join(outDir, name) : path.resolve(flags.out || `${taken.screen}.png`);
      fs.writeFileSync(file, taken.png);
      console.log(`✔ ${file}${taken.answered ? ` (answered: ${taken.answered.join(', ') || 'no activity'})` : ''}${taken.scroll ? ` (${taken.scroll.length} frames down the page at ${taken.scroll.join(', ')} px)` : taken.frames ? ` (${taken.frames.length} frames at ${taken.frames.map((frame) => frame.label ?? `${frame.ms / 1000} s`).join(', ')})` : ''}${taken.consoleErrors.length ? `\n  console errors:\n    ${taken.consoleErrors.join('\n    ')}` : ''}`);
    }
    return result.ok ? 0 : 1;
  }
});

const fit = defineCommand({
  name: 'fit',
  flags: { screen: 'list', reference: 'string', minimum: 'string', phone: 'string', language: 'string', 'allow-missing': 'boolean', fresh: 'boolean', json: 'boolean' },
  async run({ positionals: [dir = '.'], flags }) {
    const { measureFit, fitDiagnostics } = await import('@elabora/node/fit');
    const { withCourseLanguage } = await import('@elabora/node/translate');
    if (flags['allow-missing'] && !flags.language) { console.error('✘ --allow-missing goes with --language <code>.'); return 2; }
    if (flags.phone && flags.phone !== 'none' && !/^[1-9]\d{2,3}x[1-9]\d{2,3}$/.test(flags.phone)) { console.error(`✘ --phone is a size (375x812) or none, not "${flags.phone}".`); return 2; }
    const phone = flags.phone === 'none' ? false : flags.phone;
    let result: FitResult;
    try {
      result = await withCourseLanguage(dir, { language: flags.language, allowMissing: flags['allow-missing'] }, (root) => measureFit(root, { sizes: fitSizes(flags.reference, flags.minimum), screens: flags.screen, fresh: flags.fresh, phone }));
    } catch (error) {
      if (flags.json) printJson({ ok: false, error: errorMessage(error) }); else console.error(`✘ ${errorMessage(error)}`);
      return 2;
    }
    if (!result.ok) {
      if (result.error) { if (flags.json) printJson({ ok: false, error: result.error }); else console.error(`✘ ${result.error}`); return 2; }
      printDiagnostics(result.diagnostics, { json: flags.json });
      return 1;
    }
    const diagnostics = fitDiagnostics(result);
    if (flags.json) { printJson({ ...result, diagnostics }); return 0; }
    const slides = result.mode === 'slides';
    if (!slides) console.log('Presentation is scroll: screens are pages of any length, nothing has to fit. Measured: the length of each page and the contrast of its text, down the whole page.\n');
    const width = Math.max(...result.sizes.flatMap((size) => size.screens.map((s) => (s.screen ?? '').length)));
    for (const size of result.sizes) {
      const fitting = size.screens.filter((s) => !s.overflow).length;
      if (size.role === 'phone') {
        const faint = size.screens.filter((s) => s.contrast?.length || s.wrapped?.length).length;
        console.log(`${size.size.replace('x', '×')} (phone): ${faint ? `${faint} screen(s) to look at` : `text readable and bars on one line on ${size.screens.length} screens`}`);
        for (const s of size.screens) {
          if (!s.contrast?.length && !s.wrapped?.length) continue;
          console.log(`  ✘ ${(s.screen ?? '').padEnd(width)}${s.wrapped?.length ? `  bar on two lines: ${s.wrapped.join(', ')}` : ''}`);
          for (const c of s.contrast || []) console.log(`    ✘ ${''.padEnd(width)}  contrast ${c.ratio}:1 < ${c.need}:1 — ${c.block ? `${c.block}: ` : ''}"${c.text}"`);
        }
        continue;
      }
      console.log(slides ? `${size.size.replace('x', '×')} (${size.role}): ${fitting}/${size.screens.length} screens fit` : `${size.size.replace('x', '×')} (${size.role}): ${size.screens.length} pages`);
      for (const s of size.screens) {
        const reused = s.reused ? ` (unchanged since ${s.reused}: reused)` : '';
        if (!slides) console.log(`  ${s.contrast?.length || s.unfinished?.length ? '✘' : '✔'} ${(s.screen ?? '').padEnd(width)}  ${s.windows <= 1 ? 'one window' : `${s.windows} windows long`}${reused}`);
        else console.log(`  ${s.overflow ? (size.role === 'reference' ? '✘' : '·') : '✔'} ${(s.screen ?? '').padEnd(width)}  ${s.overflow ? `+${s.overflow} px${s.below.length ? `, below the fold: ${s.below.join(', ')}` : ''}` : `fits, ${s.spare} px to spare`}${reused}`);
        for (const u of s.unfinished || []) console.log(`    ✘ ${''.padEnd(width)}  animation "${u.name}" ${u.atEnd === null ? 'never starts' : `stops at ${Math.round(u.atEnd * 100)} %`} at the end of the page — ${u.block ? `${u.block}: ` : ''}${u.target}`);
        for (const c of s.contrast || []) console.log(`    ✘ ${''.padEnd(width)}  contrast ${c.ratio}:1 < ${c.need}:1 — ${c.block ? `${c.block}: ` : ''}"${c.text}"${c.scrolled ? ' (as the page scrolls)' : ''}`);
        if (s.shift) console.log(`    ${size.role === 'reference' ? '✘' : '·'} ${''.padEnd(width)}  answering moves it: ${[...s.shift.grew.map((g) => `${g.block} ${g.px > 0 ? '+' : ''}${g.px} px`), ...(s.shift.moved.length ? [`${s.shift.moved.length} block(s) move`] : [])].join(', ')}${s.shift.overflow > s.overflow ? `, then scrolls by ${s.shift.overflow} px` : ''}`);
      }
    }
    const reused = result.sizes.flatMap((size) => size.screens).filter((s) => s.reused).length;
    if (reused) console.log(`\n${reused} measure(s) reused: those screens are unchanged since then. --fresh measures them again.`);
    return 0;
  }
});

const inspect = defineCommand({
  name: 'inspect',
  flags: { json: 'boolean' },
  run({ positionals: [file], flags }) {
    if (!file) { console.error('Usage: elabora inspect <package.zip>'); return 2; }
    const { files, meta } = readZip(fs.readFileSync(file));
    const manifest = files.get('imsmanifest.xml')?.toString('utf8');
    const names = [...files.keys()];
    const info = {
      file, files: meta.length, bytes: fs.statSync(file).size, uncompressedBytes: meta.reduce((sum, entry) => sum + entry.size, 0),
      manifestAtRoot: !!manifest,
      scorm: manifest ? (/<schemaversion>\s*([^<]+)/.exec(manifest)?.[1]?.trim() || 'unknown') : null,
      launch: manifest ? /href="([^"]+)"/.exec(manifest.slice(manifest.indexOf('<resource')))?.[1] : null,
      title: manifest ? /<title>([^<]*)<\/title>/.exec(manifest)?.[1] : null,
      masteryScore: manifest ? /<adlcp:masteryscore>(\d+)/.exec(manifest)?.[1] || null : null,
      tool: files.has('elabora/player.js') ? 'Elabora' : files.has('story.html') || names.some((name) => name.startsWith('story_content/')) ? 'Articulate Storyline' : names.some((name) => name.startsWith('scormcontent/')) ? 'Articulate Rise' : 'unknown',
      nonPortableNames: names.filter((name) => !/^[A-Za-z0-9._/-]+$/.test(name)).slice(0, 20),
      largest: meta.sort((a, b) => b.size - a.size).slice(0, 5).map((entry) => ({ name: entry.name, size: entry.size }))
    };
    if (flags.json) printJson(info);
    else for (const [key, value] of Object.entries(info)) console.log(`${key.padEnd(18)} ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    return manifest ? 0 : 1;
  }
});

const diff = defineCommand({
  name: 'diff',
  flags: { profile: 'list', json: 'boolean' },
  async run({ positionals: [oldReport, newReport], flags }) {
    const { diffReports } = await import('@elabora/core/update-impact');
    if (!oldReport || !newReport) { console.error('Usage: elabora diff <old.report.json> <new.report.json>'); return 2; }
    const readReport = (file: string): UpdateReport => JSON.parse(fs.readFileSync(file, 'utf8'));
    const impact = diffReports(readReport(oldReport), readReport(newReport), { profiles: flags.profile });
    if (flags.json) printJson(impact);
    else {
      console.log(`${impact.from.version} → ${impact.to.version}. Manifest structure ${impact.manifest.sameStructure ? 'unchanged' : 'CHANGED'}${impact.manifest.masteryChanged ? ', mastery score changed' : ''}.`);
      const { note, removed, renamed } = impact.learnerState;
      console.log(`Learner state: ${note}${removed.length ? ` Removed: ${removed.join(', ')}.` : ''}${renamed.length ? ` Renamed: ${renamed.map(({ from, to }) => `${from} → ${to}`).join(', ')}.` : ''}`);
      for (const verdict of impact.perProfile) console.log(`  ${verdict.verdict.padEnd(14)} ${verdict.name} — ${verdict.why}`);
    }
    return impact.perProfile.some((verdict) => verdict.verdict === 'progress-lost') ? 1 : 0;
  }
});

const profiles = defineCommand({
  name: 'profiles',
  flags: { json: 'boolean' },
  run({ flags }) {
    const all = listProfiles();
    if (flags.json) printJson(all);
    else for (const p of all) console.log(`${p.id.padEnd(15)} ${p.name} — launch ${p.launch.modes.join('/')}, suspend_data 1.2 ≤ ${p.datamodel?.suspendDataMax?.scorm12 ?? '?'}, update: ${p.update?.family ?? '?'}${p.toMeasure.length ? ` (to measure: ${p.toMeasure.length})` : ''}`);
    return 0;
  }
});

// The fit sizes given on the command line (the others keep the course's), or the course's.
export function fitSizes(reference: string | undefined, minimum: string | undefined): FitSize[] | undefined {
  const sizes: FitSize[] = [];
  if (reference) sizes.push({ role: 'reference', size: reference });
  if (minimum) sizes.push({ role: 'minimum', size: minimum });
  return sizes.length ? sizes : undefined;
}

export const buildAndTestCommands: CommandGroup = { title: 'Build and test', help: HELP, commands: [buildCommand, test, previewCommand, look, screenshot, fit, inspect, diff, profiles] };
