import { readLock, assignKeys, buildStateModel } from '../compile/state-model.ts';
import { worstCaseLength } from '@elabora/player/state-codec';
import { listProfiles, resolveProfiles, scorm12Limits } from '../lms/profiles.ts';
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
  const limits = scorm12Limits(profiles);
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  const worst: number = worstCaseLength(buildStateModel(project, keys));
  ctx.budget = { worstCase: worst, limit: limits.suspendDataMax, profiles: profiles.map((profile) => profile.id) };
  const profileNames = profiles.map((profile) => profile.id).join(', ');
  if (worst > limits.suspendDataMax) {
    reporter.emit('E_SUSPEND_DATA_BUDGET', { file: 'course.json', measured: worst, limit: limits.suspendDataMax, profile: profileNames, message: `Worst-case suspend_data is ${worst} characters; the strictest target (${limits.suspendDataSource}) accepts ${limits.suspendDataMax}.` });
  } else if (worst > 0.8 * limits.suspendDataMax) {
    reporter.emit('W_SUSPEND_DATA_NEAR_LIMIT', { file: 'course.json', measured: worst, limit: limits.suspendDataMax, profile: profileNames });
  }
  for (const object of project.objects.values()) {
    const max = object.manifest?.persistState?.enabled ? (object.manifest.persistState.maxLength || 300) : 0;
    if (max > limits.suspendDataMax / 4) reporter.emit('E_OBJECT_STATE_BUDGET', { file: `objects/${object.id}/object.manifest.json`, path: '/persistState/maxLength', target: object.id, measured: max, limit: Math.floor(limits.suspendDataMax / 4), message: `One object may use at most a quarter of the suspend data budget.` });
  }
  for (const profile of profiles) {
    if (profile.toMeasure?.length) reporter.emit('W_PROFILE_TO_MEASURE', { severity: 'info', profile: profile.id, message: `${profile.name}: ${profile.toMeasure.join(', ')} still to be measured in a real instance.` });
    if (!profile.standards?.scorm12) reporter.emit('E_STANDARD_NOT_SUPPORTED', { profile: profile.id, message: `${profile.name} does not document SCORM 1.2.` });
  }
}
