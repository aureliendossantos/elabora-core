// The SCORM 1.2 interactions of D63's activities (cmi.interactions.n), built from what the learner
// gave. Patterns follow the data model's formats: a choice is one character (a, b, c…), a matching
// pairs a source character and a target character ("1.a,2.c"), a sequencing lists characters in order
// ("b,a,c"), a likert answer is one character, a fill-in is one line of 255 characters at most.

import type { Interaction } from './scorm12.ts';
import type { FillInProps, ReflectionProps, SortProps } from './course-data.ts';

const letter = (index: number) => String.fromCharCode(97 + index);
// Matching sources: 1…9, then a, b, c (twelve items at most).
const sourceChar = (index: number) => (index + 1).toString(36);
// What an LMS keeps of a learner's words (CMIString255): one line, 255 characters.
export const scormText = (text: unknown): string => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 255);
const round2 = (value: number) => Math.round(value * 100) / 100;

// One interaction per blank, <block>.<n>: typed, a fill-in with the words written and the first
// answer as pattern; menus and words to place, a choice by the word's letter in the list offered.
export function fillInInteractions(id: string, props: Pick<FillInProps, 'presentation' | 'blanks' | 'words' | 'weight' | 'objective'>, given: readonly string[], marks: readonly boolean[]): Interaction[] {
  return props.blanks.map((blank, index) => {
    const common = { id: `${id}.${index + 1}`, ...(props.objective ? { objective: props.objective } : {}), weight: round2((props.weight || 1) / props.blanks.length), result: marks[index] ? 'correct' as const : 'wrong' as const };
    if (props.presentation === 'typed') return { ...common, type: 'fill-in', response: scormText(given[index]), correctPattern: scormText(blank.answers[0]) };
    const at = (word: string | undefined) => letter(Math.max(0, props.words.indexOf(word ?? '')));
    return { ...common, type: 'choice', response: at(given[index]), correctPattern: at(blank.answers[0]) };
  });
}

// One interaction per sort: pairs and categories a matching, order a sequencing.
export function sortInteraction(id: string, props: Pick<SortProps, 'presentation' | 'items' | 'weight' | 'objective'>, given: readonly number[], correct: boolean): Interaction {
  const common = { id, ...(props.objective ? { objective: props.objective } : {}), weight: props.weight || 1, result: correct ? 'correct' as const : 'wrong' as const };
  if (props.presentation === 'order') return { ...common, type: 'sequencing', response: given.map(letter).join(','), correctPattern: props.items.map((_, index) => letter(index)).join(',') };
  return {
    ...common, type: 'matching',
    response: given.map((target, index) => (target >= 0 ? `${sourceChar(index)}.${letter(target)}` : '')).filter(Boolean).join(','),
    correctPattern: props.items.map((item, index) => `${sourceChar(index)}.${letter(item.target)}`).join(',')
  };
}

// A reflection: its text's first 255 characters as a fill-in, or the point of its scale as a likert;
// neutral, never scored.
export function reflectionInteraction(id: string, props: Pick<ReflectionProps, 'presentation' | 'objective'>, value: string | number): Interaction {
  return { id, ...(props.objective ? { objective: props.objective } : {}), type: props.presentation === 'scale' ? 'likert' : 'fill-in', response: props.presentation === 'scale' ? String(value).slice(0, 1) : scormText(value), result: 'neutral' };
}
