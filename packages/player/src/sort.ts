// Sort activities (D63): grading what a learner placed. Pure: the player grades, the core's tests and
// validation read the same rules.
//
// A placement is a list of numbers:
//   pairs, categories: one per item, in the items' order: the index of the target it was placed in
//                      (-1: not placed);
//   order:             one per position, from the first: the index of the item the learner put there.

export type SortPresentation = 'pairs' | 'categories' | 'order';

// What grading needs of a sort: for each item, the index of the target it belongs to (-1 for order,
// or a target that does not exist).
export interface GradedSort {
  presentation: SortPresentation;
  items: readonly { target: number }[];
}

export interface SortGrade {
  // One per item, in the items' order: placed right or not.
  marks: boolean[];
  // The share of items placed right, 0..1 (Moodle's per-item rule).
  score: number;
  correct: boolean;
}

export function gradeSort(sort: GradedSort, placement: readonly number[]): SortGrade {
  const count = sort.items.length;
  const marks = sort.presentation === 'order'
    ? sort.items.map((_, index) => placement.indexOf(index) === index)
    : sort.items.map((item, index) => item.target >= 0 && placement[index] === item.target);
  const right = marks.filter(Boolean).length;
  return { marks, score: count ? right / count : 0, correct: count > 0 && right === count };
}

// Every item placed: the learner may submit.
export function sortComplete(sort: GradedSort, placement: readonly number[]): boolean {
  if (sort.presentation === 'order') return placement.length === sort.items.length && new Set(placement).size === placement.length && placement.every((index) => index >= 0 && index < sort.items.length);
  return sort.items.every((_, index) => (placement[index] ?? -1) >= 0);
}
