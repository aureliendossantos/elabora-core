import path from 'node:path';
import { listProfiles as lmsProfiles } from '@elabora/core/lms/profiles';
import { build as buildCourse } from '@elabora/node/build';
import { withCourseLanguage } from '@elabora/node/translate';
import { MediaQueue, readJobs, isFinished } from '@elabora/node/media/jobs';
import { agentFindings, defineTool, errorResult, objectSchema, textResult, LANGUAGE, PROFILES } from './tool.ts';

// Packages: LMS profiles, building and testing in the LMS emulator.

export const listProfiles = defineTool({
  name: 'elabora_list_profiles',
  readOnly: true,
  description: 'Executable LMS profiles (SuccessFactors, Workday, Cornerstone, Docebo, Moodle, Totara, 360Learning, Rise Up, SCORM Cloud, Teach Up, unknown) with their documented constraints.',
  inputSchema: objectSchema({}),
  handler: () => textResult(lmsProfiles().map((p) => ({ id: p.id, name: p.name, documentedAt: p.documentedAt, launch: p.launch.modes, suspendDataMax: p.datamodel?.suspendDataMax, update: p.update?.family, toMeasure: p.toMeasure, notes: p.notes })))
});

const TRANSLATION = {
  language: { ...LANGUAGE, description: 'Build/test this translation from the source course; outputs go into the source course dist/. Omit for the source language.' },
  allowMissing: { type: 'boolean', description: 'With language: explicitly make a draft; missing/stale texts stay in the source language and unplaced word anchors move to line starts.' }
} as const;

const WEB = {
  type: 'object',
  additionalProperties: false,
  description: 'Settings of the web target (target "web" only). A publication: the defaults. A showcase: { progress: "none", navigation: "free" }. A review link: { review: { origins: ["https://revue.elabora.studio"] } }.',
  properties: {
    progress: { enum: ['local', 'none'], description: 'local (default): kept in the browser, the learner resumes at the next visit. none: nothing kept, a reload starts again.' },
    navigation: { enum: ['authored', 'free'], description: 'authored (default): the course\'s navigation rules and locks. free: every screen open from the outline and Next, nothing to complete first.' },
    noindex: { type: 'boolean', description: 'Ask search engines not to index the module (a review, a private link).' },
    url: { type: 'string', description: 'Absolute address where the module\'s index.html will be served (https://…): canonical link and sharing previews.' },
    image: { type: 'string', description: 'Sharing image shown when the link is shared (PNG, JPEG or WebP, 1200×630 reads well): a path in the course folder (assets/…) or absolute. Needs url for previews.' },
    review: {
      type: 'object', additionalProperties: false, required: ['origins'],
      description: 'A module for the Revue: it carries the review bridge (elabora-review/1, docs/review-bridge.md) and talks only to review pages of these origins, which show it in an iframe. Defaults then: progress none, navigation free, noindex.',
      properties: { origins: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Origins of the review pages: https://revue.elabora.studio; http://localhost:<port> for development. No path.' } }
    }
  }
} as const;

export const build = defineTool({
  name: 'elabora_build',
  description: 'Validate and compile the SCORM 1.2 package and its proof dossier into dist/. Waits for media jobs under way. mediaQuality (default: course.json delivery.mediaQuality, else high) ships renditions of the media below high, to fit LMS size limits (E_PACKAGE_TOO_LARGE gives the size at each quality). target "web": a module for a plain web server instead, without LMS (a folder to serve and its ZIP, dist/<course>-<version>-web), with the settings of web; profiles are refused there.',
  inputSchema: objectSchema({ ...TRANSLATION, profiles: PROFILES, release: { type: 'boolean' }, mediaQuality: { enum: ['high', 'medium', 'low'] }, target: { enum: ['scorm12', 'web'], description: 'scorm12 (default): a package for LMSs. web: a module for a plain web server.' }, web: WEB, languages: { enum: ['all'], description: 'all: one package of every language (D59): the course\'s own and each translation that is ready and approved, which learners switch in place (the player\'s language item). Not with language.' } }),
  async handler(args, { root }) {
    const web = args.target === 'web';
    if (!web && args.web) return errorResult({ error: 'web settings are for target "web".' });
    if (web && args.profiles) return errorResult({ error: 'profiles are for SCORM packages: a module for the web reports to no LMS.' });
    if (args.languages && args.language) return errorResult({ error: 'languages "all" builds the course with its translations: leave language out.' });
    const pending = readJobs(root).filter((job) => job.type !== 'rendition' && !isFinished(job.status));
    if (pending.length) await new MediaQueue(root).wait(pending.map((job) => job.id));
    return withCourseLanguage(root, args, async (dir, translation) => {
      const result = await buildCourse(dir, { profiles: args.profiles, release: args.release, ...(translation ? { out: path.join(root, 'dist') } : {}), ...(args.mediaQuality ? { mediaQuality: args.mediaQuality } : {}), ...(web ? { target: 'web' as const, web: args.web ?? {} } : {}), ...(args.languages ? { languages: 'all' as const } : {}) });
      return textResult({
        ok: result.ok, zip: result.zipPath, ...(web ? { dir: result.dirPath, web: result.report?.web } : { budget: result.report?.budget }), report: result.reportPath, package: result.report?.package,
        ...(translation ? { translation: { language: translation.language, units: translation.units, untranslated: translation.untranslated, unplaced: translation.unplaced, plan: translation.plan } } : {}),
        media: result.report?.media && { quality: result.report.media.quality, files: result.report.media.files.length }, summary: result.summary, diagnostics: agentFindings(result.diagnostics)
      });
    });
  }
});

export const testPackage = defineTool({
  name: 'elabora_test_package',
  description: 'Build, then run the package in the LMS emulator for the given profiles (launch topologies, close and resume, status, accessibility). Slow.',
  inputSchema: objectSchema({ ...TRANSLATION, profiles: PROFILES, modes: { type: 'array', items: { enum: ['iframe', 'popup', 'popup-chain', 'nested-iframe', 'new-tab'] } } }),
  async handler(args, { root }) {
    const packageTests = await import('@elabora/node/emulator/run');
    return withCourseLanguage(root, args, async (dir, translation) => {
      const built = await buildCourse(dir, { profiles: args.profiles, emit: 'both', ...(translation ? { out: path.join(root, 'dist') } : {}) });
      if (!built.ok || !built.dirPath) return errorResult({ error: 'Build failed', diagnostics: built.diagnostics.filter((d) => d.severity === 'error') });
      const result = await packageTests.testPackage({ dir: built.dirPath, profiles: args.profiles ?? built.report.profiles.map((profile) => profile.id), modes: args.modes, accessibility: true, unloadVariants: false });
      return textResult({ ok: result.ok, ...(translation ? { language: translation.language } : {}), runs: result.runs.map((run) => ({ profile: run.profile, launch: run.launch, browser: run.browser, browserVersion: run.browserVersion, ok: run.ok, failures: run.failures })), accessibility: result.accessibility && { screens: result.accessibility.screens, violations: result.accessibility.details } });
    });
  }
});
