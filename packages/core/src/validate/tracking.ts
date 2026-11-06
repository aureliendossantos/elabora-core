import { readLock, assignKeys, buildStateModel } from '../compile/state-model.ts';
import { worstCaseLength } from '@elabora/player/state-codec';
import { listProfiles, lmsName, resolveProfiles, deliveryLimits } from '../lms/profiles.ts';
import { courseFormat, formatMismatches, formatName } from '../lms/formats.ts';
import type { DeliveryFormat } from '../lms/formats.ts';
import type { LmsProfile } from '../lms/profiles.ts';
import { resolveBlockProps } from '../project/load.ts';
import { instanceBehavior } from '../components/registry.ts';
import type { Course } from '../project/model.ts';
import type { CourseCheckContext } from './context.ts';
import { fieldsOf } from './guards.ts';

// Tracking rules: status reporting coherence and the worst-case suspend data budget
// against the strictest selected LMS profile (checklist items 3 and 13).
export function checkTracking(ctx: CourseCheckContext): void {
  const { project, course, reporter, planIndex, registry } = ctx;
  const completion: NonNullable<Course['completion']> = course.completion || {};
  const reportAs = completion.reportAs || 'completed-incomplete';
  if (reportAs !== 'completed-incomplete' && completion.masteryScore === undefined) {
    reporter.emit('E_MASTERY_SCORE_MISSING', { file: 'course.json', path: '/completion', message: `reportAs "${reportAs}" needs completion.masteryScore.` });
  }
  const scored = [...ctx.blocks.values()].some(({ block }) => {
    const props = resolveBlockProps(block, planIndex, registry);
    const behavior = instanceBehavior(registry, block);
    if (behavior === 'quiz' || behavior === 'numeric' || behavior === 'fill-in' || behavior === 'sort') return props.scored !== false;
    if (behavior === 'decision' || behavior === 'object') return !!props.scored;
    if (behavior === 'predict') return fieldsOf(props.predict).scored === true;
    // A dialogue is scored when its scoring counts something (its mode's default, D61).
    if (behavior === 'dialogue') return (typeof props.scoring === 'string' ? props.scoring : props.mode === 'assessment' ? 'quality' : 'none') !== 'none';
    return false;
  });
  if (reportAs !== 'completed-incomplete' && !scored) reporter.emit('W_NO_SCORED_ITEMS', { file: 'course.json', path: '/completion/reportAs', message: `reportAs "${reportAs}" but no item is scored.` });

  // A module built for the web reports to no LMS (D41).
  if (ctx.options.target === 'web') return;

  // LMSs the course names (delivery.lms) must be known; ids asked for (--profile) throw.
  const named = course.delivery?.lms;
  if (Array.isArray(named) && named.length && ctx.options.profiles.join() === named.join()) {
    const unknown = named.filter((id) => typeof id === 'string' && !listProfiles().some((profile) => profile.id === id));
    for (const id of unknown) reporter.emit('E_LMS_UNKNOWN', { file: 'course.json', path: `/delivery/lms/${named.indexOf(id)}`, target: id, message: `delivery.lms names "${id}", which no LMS profile has. Known profiles: ${listProfiles().map((profile) => profile.id).join(', ')}.` });
    if (unknown.length) return;
  }
  let profiles: LmsProfile[];
  try { profiles = resolveProfiles(ctx.options.profiles); } catch (error) { reporter.emit('E_SCHEMA', { message: error instanceof Error ? error.message : String(error) }); return; }
  const format = ctx.options.target;
  const limits = deliveryLimits(profiles, format);
  const lock = readLock(project);
  const { keys } = assignKeys(project, lock, { dryRun: true });
  const worst: number = worstCaseLength(buildStateModel(project, keys, lock));
  ctx.budget = { worstCase: worst, limit: limits.suspendDataMax, profiles: profiles.map((profile) => profile.id) };
  const profileNames = profiles.map((profile) => profile.id).join(', ');
  if (worst > limits.suspendDataMax) {
    // Another format the LMSs take may keep more (SuccessFactors documents 64,000 in SCORM 1.2 and
    // 4,000 in SCORM 2004): the message says it.
    const other = (['scorm12', 'scorm2004'] as const).find((candidate) => candidate !== format && !formatMismatches(profiles, candidate).length && worst <= deliveryLimits(profiles, candidate).suspendDataMax);
    reporter.emit('E_SUSPEND_DATA_BUDGET', { file: 'course.json', measured: worst, limit: limits.suspendDataMax, profile: profileNames, message: `Worst-case suspend_data is ${worst} characters; the strictest target (${limits.suspendDataSource}) accepts ${limits.suspendDataMax} in ${formatName(format)}.${other ? ` In ${formatName(other)} it accepts ${deliveryLimits(profiles, other).suspendDataMax}: set course.json delivery.format to ${other}.` : ''}` });
  } else if (worst > 0.8 * limits.suspendDataMax) {
    reporter.emit('W_SUSPEND_DATA_NEAR_LIMIT', { file: 'course.json', measured: worst, limit: limits.suspendDataMax, profile: profileNames });
  }
  for (const object of project.objects.values()) {
    const max = object.manifest?.persistState?.enabled ? (object.manifest.persistState.maxLength || 300) : 0;
    if (max > limits.suspendDataMax / 4) reporter.emit('E_OBJECT_STATE_BUDGET', { file: `objects/${object.id}/object.manifest.json`, path: '/persistState/maxLength', target: object.id, measured: max, limit: Math.floor(limits.suspendDataMax / 4), message: `One object may use at most a quarter of the suspend data budget.` });
  }
  for (const profile of profiles) {
    if (profile.toMeasure?.length) reporter.emit('W_PROFILE_TO_MEASURE', { severity: 'info', profile: profile.id, message: `${profile.name}: ${profile.toMeasure.join(', ')} still to be measured in a real instance.` });
  }
  // The format against the LMSs: one they refuse stops the build, one they may not take warns. A
  // format Elabora picked is one they take.
  const setting = course.delivery?.format;
  const forced = setting !== undefined && setting !== 'auto';
  for (const { profile, support } of formatMismatches(profiles, format)) {
    const where = forced ? { file: 'course.json', path: '/delivery/format' } : {};
    if (support === 'no') reporter.emit('E_STANDARD_NOT_SUPPORTED', { ...where, profile: profile.id, message: `${lmsName(profile)} does not take ${formatName(format)} packages: build ${formatName(courseFormat({ delivery: { lms: [profile.id] } }).format)} for it (course.json delivery.format auto).` });
    else if (profile.id !== 'unknown') reporter.emit('W_STANDARD_UNSURE', { ...where, profile: profile.id, message: `${lmsName(profile)} may not take ${formatName(format)} packages (${standardWords(profile, format)}): try the package in it before delivering.` });
    else reporter.emit('W_STANDARD_UNSURE', { ...where, profile: profile.id, message: `No LMS is chosen: check that the client's LMS takes ${formatName(format)} packages, or choose it (course.json delivery.lms).` });
  }
  // xAPI records nothing without an LRS: the LMS's, when it launches xAPI packages, or delivery.lrs.
  if (format === 'xapi' && !course.delivery?.lrs) {
    const named = profiles.filter((profile) => profile.id !== 'unknown');
    reporter.emit('W_XAPI_NEEDS_LRS', { file: 'course.json', path: '/delivery', message: named.length
      ? `xAPI needs a learning record store: ${named.map(lmsName).join(', ')} must launch xAPI packages with its own, or set course.json delivery.lrs for a module outside an LMS.`
      : 'xAPI needs a learning record store: an LMS that launches xAPI packages has its own; outside an LMS, set course.json delivery.lrs, or nothing is recorded.' });
  }
}

// What a profile says of a format it may not take: a plugin, discouraged, in beta, or nothing.
function standardWords(profile: LmsProfile, format: DeliveryFormat): string {
  const standards = profile.standards;
  const value: unknown = format === 'scorm12' ? standards.scorm12 : format === 'scorm2004' ? standards.scorm2004 : format === 'cmi5' ? standards.cmi5 : standards.xapi;
  if (value === 'plugin') return 'only with a plugin';
  if (value === 'discouraged') return 'the vendor discourages it';
  if (value === 'beta') return 'in beta';
  return 'its documentation does not say';
}
