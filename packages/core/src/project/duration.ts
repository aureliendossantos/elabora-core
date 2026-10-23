import type { Project } from './model.ts';
import { planIndex, screenBlocks } from './load.ts';
import { extractUnits } from '../i18n/units.ts';
import { screenTimeline } from '../narration/timeline.ts';
import { instanceBehavior, getRegistry, type Behavior } from '../components/registry.ts';
import { isRecord } from '../util/values.ts';
import { dialogueBlocks, projectDialogue, pathTime } from '../dialogue/project.ts';
import { explorePaths } from '@elabora/player/dialogue/paths';

// How long a learner spends on each screen, estimated from what it holds (docs/decisions.md D50):
// the words they read, at a pace for reading to learn, or the voice when it says more; then a moment
// for each question, decision or free object. An estimate the plan's views add up by part and for
// the module, in grey and rounded, never a promise: nothing is timed before the screens exist.

// Reading to learn, slower than reading for pleasure (about 230 words a minute in French or English,
// 140 to 200 to learn or remember: Carver's reading gears), and the pace of the narration's voice.
export const READING_WORDS_PER_MINUTE = 150;
// What an activity adds to the reading of its words: deciding, answering, trying.
// A prediction (a trend's predict mode) takes about as long as a choice: drawing, then reading the answer.
// A dialogue is timed by its paths instead (dialogueSeconds).
export const ACTIVITY_SECONDS: Readonly<Record<Behavior | 'predict', number>> = { quiz: 45, numeric: 60, decision: 45, dialogue: 0, object: 90, results: 0, chart: 0, predict: 40 };
// A screen is never shorter than a glance.
export const MIN_SCREEN_SECONDS = 10;

export interface ScreenEstimate {
  seconds: number; // rounded to the second
  words: number; // read on the screen, the plan's texts and questions it shows included
  narration: number | null; // seconds of voice (its recordings, or estimated from its text); null: not narrated
  activities: number; // questions, decisions, free objects
}

const WORD = /\p{L}[\p{L}\p{N}'’-]*/gu;
export const countWords = (text: string): number => text.replace(/\]\([^)]*\)/g, ']').match(WORD)?.length ?? 0;

// Every listed screen of the course, with its estimate.
export function screenEstimates(project: Project): Map<string, ScreenEstimate> {
  const words = new Map<string, number>();
  // A dialogue's words are not all read: one path is (dialogueSeconds).
  const dialogues = dialogueBlocks(project);
  const dialogueUnits = dialogues.map((ref) => `block.${ref.id}.`);
  for (const unit of extractUnits(project)) {
    const screen = /^screens\/(.+)\.json$/.exec(unit.file)?.[1];
    // Heard, not read: the narration's lines (the screen's, a layer's, a dialogue's) are timed by the voice.
    if (!screen || unit.editor || /(^|\/)narration\//.test(unit.pointer) || dialogueUnits.some((prefix) => unit.id.startsWith(prefix))) continue;
    words.set(screen, (words.get(screen) ?? 0) + countWords(unit.text));
  }
  const plan = planIndex(project.plan);
  const registry = getRegistry(project);
  const estimates = new Map<string, ScreenEstimate>();
  for (const [id, { data: screen }] of project.screens) {
    let read = words.get(id) ?? 0;
    let activities = 0;
    let busy = 0;
    for (const { block } of screenBlocks(screen)) {
      const props = isRecord(block.props) ? block.props : {};
      // The plan's words a block shows by reference.
      if (typeof props.textRef === 'string') read += countWords(plan.texts.get(props.textRef)?.text ?? '');
      if (typeof props.questionRef === 'string') {
        const question = plan.questions.get(props.questionRef);
        if (question) read += countWords([question.stem, ...(question.options ?? []).map((option) => option.text)].join(' '));
      }
      const behavior = instanceBehavior(registry, block);
      if (behavior && ACTIVITY_SECONDS[behavior]) { activities++; busy += ACTIVITY_SECONDS[behavior]; }
      if (behavior === 'dialogue') {
        const ref = dialogues.find((candidate) => candidate.id === block.id);
        if (ref) { activities++; busy += dialogueSeconds(project, ref); }
      }
    }
    const timeline = screenTimeline(project, id);
    const narration = timeline?.narrated ? timeline.duration : null;
    const reading = (read / READING_WORDS_PER_MINUTE) * 60;
    const seconds = Math.round(Math.max(MIN_SCREEN_SECONDS, Math.max(reading, narration ?? 0) + busy));
    estimates.set(id, { seconds, words: read, narration: narration === null ? null : Math.round(narration * 10) / 10, activities });
  }
  return estimates;
}

// Minutes as the plan's views say them: at least one, to the minute; a module of more than a quarter
// of an hour to five minutes.
export function roundedMinutes(seconds: number, { module = false }: { module?: boolean } = {}): number {
  const minutes = seconds / 60;
  if (module && minutes > 15) return Math.round(minutes / 5) * 5;
  return Math.max(1, Math.round(minutes));
}

// A dialogue takes the time of an average path (its lines' audio or their text, reading its options
// and notes), over its first paths.
function dialogueSeconds(project: Project, ref: ReturnType<typeof dialogueBlocks>[number]): number {
  const data = projectDialogue(project, ref);
  const paths = explorePaths(data, { limit: 50 }).paths;
  if (!paths.length) return 0;
  return paths.reduce((sum, path) => sum + pathTime(project, ref, data, path.walk.beats).seconds, 0) / paths.length;
}
