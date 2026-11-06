import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chooseFormat, courseFormat, formatSupport } from '@elabora/core/lms/formats';
import { resolveProfiles, getProfile } from '@elabora/core/lms/profiles';
import { scorm2004Manifest, structureFingerprint } from '@elabora/core/compile/manifests';
import { diffReports } from '@elabora/core/update-impact';
import { createScorm2004Adapter, scorm2004Duration, scorm2004Response } from '@elabora/player/scorm2004';
import type { Scorm2004Api } from '@elabora/player/scorm2004';
import { build } from '@elabora/node/build';
import { readZip } from '@elabora/node/zip';
import { copyExample, readJSON, writeJSON, codes } from '../helpers.ts';

// The delivery formats (docs/delivery.md): the format Elabora picks for the module's LMSs, the one
// the module forces, what the package holds in each, and what the SCORM 2004 adapter sends.

const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const course = () => { const dir = copyExample(); temporary.push(dir); return dir; };
const pick = (...ids: string[]) => chooseFormat(resolveProfiles(ids.length ? ids : ['unknown']));
const withDelivery = (dir: string, delivery: Record<string, unknown>) => {
  const data = readJSON(dir, 'course.json') as { delivery?: Record<string, unknown> };
  writeJSON(dir, 'course.json', { ...data, delivery: { ...data.delivery, ...delivery } });
};

test('Elabora picks SCORM 1.2 without an LMS, the profile\'s best format for one LMS, the one several share', () => {
  assert.deepEqual(pick(), { format: 'scorm12', how: 'auto', why: 'safest', lms: [], auto: { format: 'scorm12', why: 'safest' } });
  assert.deepEqual([pick('moodle').format, pick('moodle').why, pick('moodle').lms], ['scorm12', 'lms', ['Moodle 4.5–5.2']]);
  assert.deepEqual([pick('scorm-cloud').format, pick('scorm-cloud').edition], ['scorm2004', '4th']);
  assert.deepEqual([pick('docebo').format, pick('docebo').edition], ['scorm2004', '3rd']);
  assert.deepEqual([pick('cornerstone').format, pick('cornerstone').edition], ['scorm2004', '3rd']);
  for (const id of ['360learning', 'rise-up', 'successfactors', 'workday']) assert.deepEqual([id, pick(id).format, pick(id).edition], [id, 'scorm2004', '4th']);
  for (const id of ['totara', 'teach-up']) assert.equal(pick(id).format, 'scorm12', id);
  // Several LMSs: the format they share, the 3rd edition when one stops there, SCORM 1.2 when one takes no SCORM 2004.
  assert.deepEqual([pick('workday', 'scorm-cloud').format, pick('workday', 'scorm-cloud').edition, pick('workday', 'scorm-cloud').why], ['scorm2004', '4th', 'common']);
  assert.deepEqual([pick('workday', 'docebo').format, pick('workday', 'docebo').edition], ['scorm2004', '3rd']);
  assert.deepEqual([pick('moodle', 'docebo').format, pick('moodle', 'docebo').why], ['scorm12', 'common']);
  // Forced: the module's, with what Elabora would pick.
  const forced = chooseFormat(resolveProfiles(['moodle']), 'scorm2004');
  assert.deepEqual([forced.format, forced.how, forced.why, forced.auto.format], ['scorm2004', 'forced', 'forced', 'scorm12']);
  assert.equal(chooseFormat(resolveProfiles(['moodle']), 'auto').how, 'auto');
  // What the profiles say of SCORM 2004.
  assert.deepEqual(['moodle', 'docebo', 'teach-up', 'unknown'].map((id) => formatSupport(getProfile(id), 'scorm2004')), ['no', 'yes', 'unsure', 'unsure']);
  // course.json: delivery.format, else delivery.lms; an LMS no profile has is left out.
  assert.equal(courseFormat({ delivery: { lms: ['docebo'] } }).format, 'scorm2004');
  assert.equal(courseFormat({ delivery: { lms: ['docebo'], format: 'scorm12' } }).format, 'scorm12');
  assert.equal(courseFormat({ delivery: { lms: ['no-such-lms'] } }).format, 'scorm12');
  assert.equal(courseFormat({ delivery: { lms: ['moodle'] } }, ['scorm-cloud']).format, 'scorm2004');
});

test('the SCORM 2004 manifest: one SCO, its edition, the content sets completion and success, no objective', () => {
  const manifest = scorm2004Manifest({ id: 'c', title: 'Écluses & ponts', version: '1.0.0', completion: { masteryScore: 80 } }, ['index.html', 'elabora/player.js'], '4th');
  assert.match(manifest, /<schemaversion>2004 4th Edition<\/schemaversion>/);
  assert.match(manifest, /xmlns="http:\/\/www\.imsglobal\.org\/xsd\/imscp_v1p1"/);
  assert.match(manifest, /adlcp:scormType="sco" href="index\.html"/);
  assert.match(manifest, /<imsss:deliveryControls completionSetByContent="true" objectiveSetByContent="true"\/>/);
  assert.match(manifest, /<title>Écluses &amp; ponts<\/title>/);
  assert.doesNotMatch(manifest, /minNormalizedMeasure|masteryscore/);
  assert.match(scorm2004Manifest({ id: 'c', title: 't', version: '1' }, [], '3rd'), /<schemaversion>2004 3rd Edition<\/schemaversion>/);
  // Another format is another structure: an update loses the learners' place.
  const report = (format: 'scorm12' | 'scorm2004') => ({ course: { version: '1' }, buildId: format, structure: structureFingerprint({ id: 'c' }, format) });
  assert.equal(diffReports(report('scorm12'), report('scorm2004')).manifest.sameStructure, false);
  assert.equal(diffReports(report('scorm2004'), report('scorm2004')).manifest.sameStructure, true);
});

test('a course for SCORM Cloud is built in SCORM 2004; course.json delivery.format and the build option force a format', async () => {
  const dir = course();
  withDelivery(dir, { lms: ['scorm-cloud'] });
  const auto = await build(dir, { emit: 'zip', writeLock: false });
  assert.ok(auto.ok, JSON.stringify(codes(auto.diagnostics)));
  assert.ok(auto.zipPath?.endsWith('-scorm2004.zip'), auto.zipPath);
  assert.deepEqual(auto.report.delivery, { format: 'scorm2004', edition: '4th', name: 'SCORM 2004 (4th edition)', how: 'auto', why: 'lms', lms: ['SCORM Cloud'] });
  assert.equal(auto.report.target, 'scorm2004');
  assert.deepEqual([auto.report.structure.format, auto.report.structure.edition], ['scorm2004', '4th']);
  assert.equal(auto.report.budget.suspendDataLimit, 64000);
  const files = readZip(fs.readFileSync(auto.zipPath!)).files;
  assert.match(files.get('imsmanifest.xml')!.toString(), /2004 4th Edition/);
  assert.match(files.get('elabora/course.js')!.toString(), /"lms":\{"format":"scorm2004"\}/);
  const proof = fs.readFileSync(auto.reportPath.replace(/\.report\.json$/, '.proof.md'), 'utf8');
  assert.match(proof, /SCORM 2004 \(4th edition\) \(the best for SCORM Cloud\)|SCORM 2004 \(4e édition\) \(le meilleur pour SCORM Cloud\)/);

  const option = await build(dir, { emit: 'zip', writeLock: false, target: 'scorm12' });
  assert.ok(option.ok && option.zipPath?.endsWith('-scorm12.zip'));
  assert.deepEqual([option.report.delivery?.how, option.report.delivery?.why], ['forced', 'forced']);
  // SCORM 1.2 packages say nothing of their format in the course data: they keep their bytes.
  assert.doesNotMatch(readZip(fs.readFileSync(option.zipPath!)).files.get('elabora/course.js')!.toString(), /"lms":/);

  withDelivery(dir, { lms: ['moodle'], format: 'scorm2004' });
  const refused = await build(dir, { emit: 'zip', writeLock: false });
  assert.equal(refused.ok, false);
  const error = refused.diagnostics.find((d) => d.code === 'E_STANDARD_NOT_SUPPORTED');
  assert.ok(error && error.path === '/delivery/format' && /Moodle.* does not take SCORM 2004 packages/.test(error.message ?? ''), JSON.stringify(error));

  // Without an LMS, a forced SCORM 2004 warns and counts the strictest suspend data (4,000).
  withDelivery(dir, { lms: undefined, format: 'scorm2004' });
  const unsure = await build(dir, { emit: 'zip', writeLock: false });
  assert.ok(unsure.ok, JSON.stringify(codes(unsure.diagnostics)));
  assert.ok(codes(unsure.diagnostics).includes('W_STANDARD_UNSURE'));
  assert.equal(unsure.report.budget.suspendDataLimit, 4000);
});

// A fake SCORM 2004 API: what the content set, and what it reads back.
function fakeApi(values: Record<string, string> = {}): Scorm2004Api & { values: Record<string, string>; calls: string[] } {
  const api = {
    values: { 'cmi.completion_status': 'unknown', 'cmi.success_status': 'unknown', ...values },
    calls: [] as string[],
    Initialize: () => 'true',
    Terminate: () => 'true',
    Commit: () => 'true',
    GetValue: (element: string) => api.values[element] ?? '',
    SetValue: (element: string, value: string) => { api.calls.push(`${element}=${value}`); api.values[element] = value; return 'true'; },
    GetLastError: () => '0',
    GetErrorString: () => ''
  };
  return api;
}

test('the SCORM 2004 adapter translates SCORM 1.2\'s data model', () => {
  const api = fakeApi({ 'cmi.location': 'k2', 'cmi.entry': 'resume' });
  const lms = createScorm2004Adapter({ api, where: 'parent^1' }, { now: () => new Date(2026, 10, 6, 9, 5, 7).getTime() });
  assert.equal(lms.kind, 'scorm2004');
  assert.ok(lms.initialize());
  assert.equal(lms.get('cmi.core.lesson_location'), 'k2');
  assert.equal(lms.get('cmi.core.entry'), 'resume');
  assert.equal(lms.get('cmi.core.lesson_status'), 'not attempted');
  lms.set('cmi.core.lesson_status', 'incomplete');
  lms.set('cmi.core.exit', 'suspend');
  lms.set('cmi.core.score.min', '0');
  lms.set('cmi.core.score.max', '100');
  lms.set('cmi.core.score.raw', '80');
  lms.set('cmi.core.session_time', '0001:02:03.50');
  assert.deepEqual(api.calls.splice(0), ['cmi.completion_status=incomplete', 'cmi.exit=suspend', 'cmi.score.min=0', 'cmi.score.max=100', 'cmi.score.raw=80', 'cmi.score.scaled=0.8', 'cmi.session_time=PT1H2M3.50S']);
  lms.set('cmi.core.lesson_status', 'passed');
  lms.set('cmi.core.exit', '');
  assert.deepEqual(api.calls.splice(0), ['cmi.completion_status=completed', 'cmi.success_status=passed', 'cmi.exit=normal']);
  assert.equal(lms.get('cmi.core.lesson_status'), 'passed');
  // Unchanged values are not sent again.
  lms.set('cmi.core.lesson_status', 'passed');
  assert.deepEqual(api.calls, []);
  // Interactions: their delimiters, timestamps and results.
  const write = (index: number, fields: [string, string][]) => { for (const [field, value] of fields) lms.setAlways(`cmi.interactions.${index}.${field}`, value); };
  write(0, [['id', 'q1'], ['time', '09:05:07'], ['type', 'choice'], ['correct_responses.0.pattern', 'a,c'], ['student_response', 'a,c'], ['result', 'correct']]);
  write(1, [['type', 'matching'], ['student_response', '1.a,2.c'], ['result', 'wrong']]);
  write(2, [['type', 'numeric'], ['correct_responses.0.pattern', '42'], ['student_response', '41']]);
  write(3, [['type', 'performance'], ['student_response', 'opened the valve']]);
  write(4, [['type', 'fill-in'], ['student_response', '{lang} a [,] b']]);
  assert.deepEqual(api.calls.splice(0), [
    'cmi.interactions.0.id=q1', 'cmi.interactions.0.timestamp=2026-11-06T09:05:07', 'cmi.interactions.0.type=choice', 'cmi.interactions.0.correct_responses.0.pattern=a[,]c', 'cmi.interactions.0.learner_response=a[,]c', 'cmi.interactions.0.result=correct',
    'cmi.interactions.1.type=matching', 'cmi.interactions.1.learner_response=1[.]a[,]2[.]c', 'cmi.interactions.1.result=incorrect',
    'cmi.interactions.2.type=numeric', 'cmi.interactions.2.correct_responses.0.pattern=42[:]42', 'cmi.interactions.2.learner_response=41',
    'cmi.interactions.3.type=other', 'cmi.interactions.3.learner_response=opened the valve',
    'cmi.interactions.4.type=fill-in', 'cmi.interactions.4.learner_response=(lang} a   b'
  ]);
  assert.ok(lms.finish());
  assert.equal(lms.phase, 'finished');
  assert.equal(lms.set('cmi.suspend_data', 'x'), false);
  assert.deepEqual(lms.log.map((call) => call.method).filter((method) => method !== 'SetValue' && method !== 'GetValue'), ['Initialize', 'Terminate']);
  assert.equal(scorm2004Duration('0000:00:07.00'), 'PT0H0M7S');
  assert.equal(scorm2004Response('true-false', 't'), 'true');
});
