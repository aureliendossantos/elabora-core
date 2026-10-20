import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getProfile, listProfiles, lmsName, resolveProfiles, targetProfileIds } from '@elabora/core/lms/profiles';
import { packageBreaches, packageLimitFindings } from '@elabora/core/lms/package-limits';
import type { PackageContext, PackageFacts, PackageLimitDetails } from '@elabora/core/lms/package-limits';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { validateProject } from '@elabora/core/validate/index';
import { build } from '@elabora/node/build';
import { copyExample, readJSON, writeJSON, codes } from '../helpers.ts';

const MB = 1024 * 1024;
const facts = (zipMB: number, more: Partial<PackageFacts> = {}): PackageFacts => ({ zipBytes: zipMB * MB, unzippedBytes: zipMB * MB, files: 120, ...more });
const named = (breach: { lms: { id: string }[] }) => breach.lms.map((lms) => lms.id);

test('every package limit of a profile comes with a source; the unknown LMS assumes none', () => {
  for (const profile of listProfiles()) {
    const { maxZipMB, maxUnzippedMB, maxFiles, maxCompressionRatio } = profile.packaging ?? {};
    const limits = [maxZipMB, maxUnzippedMB, maxFiles, maxCompressionRatio].filter((value) => typeof value === 'number');
    if (profile.id === 'unknown') assert.deepEqual(limits, [], 'the unknown LMS has no package limit');
    else if (limits.length) assert.ok(profile.sources.length > 0, `${profile.id} gives package limits without a source`);
  }
  assert.equal(getProfile('teach-up').packaging.maxZipMB, 100);
  assert.equal(getProfile('successfactors').packaging.maxZipMB, null, 'set by the tenant: no published value');
  assert.equal(getProfile('workday').packaging.maxZipMB, 2048, 'the default for new tenants');
});

test('the LMSs a course targets: --profile, else delivery.lms, else the unknown LMS', () => {
  assert.deepEqual(targetProfileIds({ delivery: { lms: ['moodle'] } }, ['docebo']), ['docebo']);
  assert.deepEqual(targetProfileIds({ delivery: { lms: ['moodle', 'docebo'] } }), ['moodle', 'docebo']);
  assert.deepEqual(targetProfileIds({ delivery: {} }), ['unknown']);
  assert.deepEqual(targetProfileIds({ delivery: { lms: 'moodle' } } as never), ['unknown'], 'not a list: the schema reports it');
  assert.deepEqual(targetProfileIds(null, []), ['unknown']);
  assert.equal(lmsName(getProfile('teach-up')), 'Teach Up');
  assert.equal(lmsName(getProfile('scorm-cloud')), 'SCORM Cloud');
  assert.equal(lmsName(getProfile('moodle')), 'Moodle 4.5–5.2');
});

test('a chosen LMS refuses a package over its limit; with no LMS chosen, the documented LMSs that would are named', () => {
  assert.deepEqual(packageBreaches(resolveProfiles(['docebo']), facts(130)), []);
  const refused = packageBreaches(resolveProfiles(['teach-up', 'moodle']), facts(130));
  assert.deepEqual(refused.map((breach) => [breach.measure, breach.chosen, named(breach), breach.max]), [['zip', true, ['teach-up'], 100 * MB]]);

  const assumed = packageBreaches(resolveProfiles(['unknown']), facts(1500));
  assert.deepEqual(assumed.map((breach) => [breach.measure, breach.chosen, named(breach)]), [['zip', false, ['teach-up', 'docebo', 'rise-up']]], 'lowest limit first');
  assert.equal(assumed[0]!.max, 100 * MB);
  assert.deepEqual(packageBreaches(resolveProfiles(['unknown']), facts(90)), [], 'under every documented limit');

  // Every LMS (--profile all): the chosen ones refuse it; no documented LMS is left to warn about.
  const all = packageBreaches(resolveProfiles(['all']), facts(1500));
  assert.deepEqual(all.map((breach) => [breach.chosen, named(breach)]), [[true, ['teach-up', 'docebo', 'rise-up']]]);

  // Extracted size, files and compression ratio, measured the same way.
  const big = packageBreaches(resolveProfiles(['unknown']), facts(4500, { unzippedBytes: 4600 * MB, files: 60_000 }));
  assert.deepEqual(big.map((breach) => [breach.measure, named(breach)]), [
    ['zip', ['teach-up', 'docebo', 'rise-up', 'cornerstone', 'workday']],
    ['unzipped', ['360learning']],
    ['files', ['360learning']]
  ]);
  const ratio = packageBreaches(resolveProfiles(['360learning']), facts(2, { unzippedBytes: 500 * MB }));
  assert.deepEqual(ratio.map((breach) => [breach.measure, breach.chosen, Math.round(breach.value)]), [['compressionRatio', true, 250]]);
});

const context = (fits: boolean): PackageContext => ({
  quality: 'high',
  qualities: [
    { quality: 'high', bytes: 130 * MB, estimated: false },
    { quality: 'medium', bytes: (fits ? 70 : 129) * MB, estimated: true },
    { quality: 'low', bytes: (fits ? 40 : 128) * MB, estimated: true }
  ],
  heaviest: [
    { path: 'assets/video/talk.mp4', asset: 'assets/video/talk.mp4', bytes: 127 * MB, kind: 'video', seconds: 1497 },
    { path: 'assets/audio/dog.m4a', asset: 'assets/audio/dog.m4a', bytes: 2.8 * MB, kind: 'audio', seconds: 180 },
    { path: 'elabora/player.js', bytes: 0.2 * MB, kind: 'other' }
  ],
  shrinking: []
});

test('a package too large says its size, who refuses it, the quality that fits and its heaviest files', () => {
  const [chosen] = packageLimitFindings(packageBreaches(resolveProfiles(['teach-up']), facts(130)), context(true), facts(130));
  const details = chosen!.fields.details as unknown as PackageLimitDetails;
  assert.equal(chosen!.code, 'E_PACKAGE_TOO_LARGE');
  assert.equal(chosen!.fields.measured, '130.0 MB');
  assert.equal(chosen!.fields.limit, '100 MB');
  assert.equal(chosen!.fields.profile, 'teach-up');
  assert.equal(details.fits, 'medium');
  assert.deepEqual(details.lms, [{ id: 'teach-up', name: 'Teach Up', max: 100 * MB }]);
  assert.deepEqual(details.files?.map((file) => file.path), ['assets/video/talk.mp4', 'assets/audio/dog.m4a'], 'files under 1 % of the package left out');
  assert.match(chosen!.fields.message!, /^The package weighs 130\.0 MB at the high media quality; Teach Up accepts 100 MB\. Other qualities: medium about 70\.0 MB \(estimated\), low about 40\.0 MB \(estimated\)\. Build with --media-quality medium, or set delivery\.mediaQuality to "medium" in course\.json\. Heaviest files: assets\/video\/talk\.mp4 \(127\.0 MB\)/);

  // No LMS chosen, and no quality small enough: a warning that asks for the LMS and says what to do with the video.
  const [assumed] = packageLimitFindings(packageBreaches(resolveProfiles(['unknown']), facts(130)), context(false), facts(130));
  const warning = assumed!.fields.details as unknown as PackageLimitDetails;
  assert.equal(assumed!.code, 'W_PACKAGE_TOO_LARGE_FOR_SOME_LMS');
  assert.equal(assumed!.fields.profile, 'unknown');
  assert.equal(warning.chosen, false);
  assert.equal(warning.fits, null);
  assert.match(assumed!.fields.message!, /No LMS is chosen: set delivery\.lms in course\.json/);
  assert.match(assumed!.fields.message!, /Even the low media quality is not enough: shorten or split assets\/video\/talk\.mp4, or host it on a video platform and link to it/);

  // Several LMSs over the limit, grouped by limit.
  const [several] = packageLimitFindings(packageBreaches(resolveProfiles(['unknown']), facts(1500)), { ...context(false), qualities: null }, facts(1500));
  assert.match(several!.fields.message!, /; Teach Up accepts 100 MB, Docebo and Rise Up 1 GB\./);
});

test('delivery.lms is what validation and the build target; an LMS no profile has is reported where it is written', async () => {
  const dir = copyExample();
  try {
    const course = readJSON(dir, 'course.json');
    writeJSON(dir, 'course.json', { ...course, delivery: { lms: ['moodle'] } });
    const moodle = validateProject(loadProjectFromDir(dir));
    assert.deepEqual(moodle.context.budget?.profiles, ['moodle']);
    const built = await build(dir, { emit: 'zip' });
    assert.ok(built.ok, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error')));
    assert.deepEqual(built.report.profiles.map((profile) => profile.id), ['moodle']);
    assert.deepEqual(validateProject(loadProjectFromDir(dir), { profiles: ['docebo'] }).context.budget?.profiles, ['docebo'], '--profile wins');

    writeJSON(dir, 'course.json', { ...course, delivery: { lms: ['moodel'] } });
    const typo = validateProject(loadProjectFromDir(dir));
    const finding = typo.diagnostics.find((d) => d.code === 'E_LMS_UNKNOWN');
    assert.equal(finding?.file, 'course.json');
    assert.equal(finding?.path, '/delivery/lms/0');
    assert.ok(!codes(typo.diagnostics).includes('E_SCHEMA'));
    // A preview still runs (the error is under a delivery rule): the build leaves that LMS out.
    const preview = await build(dir, { emit: 'dir', preview: true, writeLock: false });
    assert.ok(preview.ok);
    assert.deepEqual(preview.report.profiles.map((profile) => profile.id), ['unknown']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
