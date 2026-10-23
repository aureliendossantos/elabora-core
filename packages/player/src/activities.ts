// The activities of D63, headless like the quiz: the template gives the markup and its hooks, the player
// builds the fields, lists and buttons in them, scores, saves, records and announces.
//
//   fill-in     data-t-stem, data-t-text (the text, where the build left a <span data-t-blank="n"> per
//               blank), data-t-submit, data-t-feedback; optional data-t-group, data-t-bank (where the
//               words to place go: made after the text when absent).
//   sort        data-t-stem, data-t-sort-item="{{id}}" (a <button> per item, data-each="items"),
//               data-t-submit, data-t-feedback; pairs and categories: data-t-sort-target="{{id}}" (one
//               per target, data-each="targets") holding a <button data-t-place> and, optionally, a
//               data-t-zone where its items go; optional data-t-group, data-t-pool (where items wait).
//   reflection  data-t-prompt, data-t-response (where the field or the scale goes), data-t-submit,
//               data-t-feedback; optional data-t-group, data-t-model (the expert's answer), data-t-download
//               (a <button>: « Mes réponses »).
//
// Placing is tap first (WCAG 2.5.7): choose an item, then where it goes; Escape lets go of it. A mouse
// may also drag (fine pointers only). Fields are labelled from the player's labels; marks are said,
// not only coloured. As for quizzes, the group gets data-t-result and data-t-final; blanks and items
// get is-correct and is-wrong. A dry run (outcomes) renders what the room of a slide must hold.

import { flatBlocks, hasBehavior } from './course-state.ts';
import type { CourseState, PartialResult, TriggerInfo } from './course-state.ts';
import type { FillInBlock, ReflectionBlock, SortBlock, TriggerType } from './course-data.ts';
import type { Labels } from './labels.ts';
import type { Interaction } from './scorm12.ts';
import { element, uniqueId } from './dom.ts';
import { icon } from './icons.ts';
import { blankIsRight, gradeFillIn } from './fill-in.ts';
import { gradeSort, sortComplete } from './sort.ts';
import { fillInInteractions, reflectionInteraction, sortInteraction } from './activity-interactions.ts';

export interface ActivityContext {
  courseState: CourseState;
  labels: Labels;
  formatLabel(label: string, values: Readonly<Record<string, unknown>>): string;
  announce(message: string): void;
  recordInteraction(interaction: Interaction): void;
  trigger(type: TriggerType, info: TriggerInfo): void;
  // The course's title: the first line of « Mes réponses ».
  courseTitle?: string;
}

type Outcome = () => void;

// Drag is an extra for mice and trackpads; fingers place by tapping.
const finePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;

export function createActivities({ courseState, labels, formatLabel, announce, recordInteraction, trigger, courseTitle = '' }: ActivityContext) {
  const escapeValue = (value: string) => String(value).replace(/["\\]/g, '\\$&');
  const hook = <E extends HTMLElement = HTMLElement>(root: ParentNode, name: string, value?: string) => root.querySelector<E>(value === undefined ? `[data-t-${name}]` : `[data-t-${name}="${escapeValue(value)}"]`);
  const makeButton = (node: HTMLElement) => { if ('type' in node) (node as HTMLButtonElement).type = 'button'; };
  const fillText = (node: Element | null, text: string) => { if (node && !node.textContent?.trim()) node.append(text); };
  const live = (node: HTMLElement) => { node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); return node; };
  const groupOf = (wrap: HTMLElement): HTMLElement => hook(wrap, 'group') || (wrap.firstElementChild as HTMLElement | null) || wrap;
  // The group is named by its stem (or prompt) when it has words.
  const labelGroup = (wrap: HTMLElement, name: string) => {
    const group = groupOf(wrap);
    const head = hook(wrap, name);
    if (head?.textContent?.trim()) { head.id ||= uniqueId(name); group.setAttribute('aria-labelledby', head.id); }
    if (group.tagName !== 'FIELDSET') group.setAttribute('role', 'group');
    return { group, head };
  };
  const resultHead = (result: PartialResult) => element('p', {
    class: `t-feedback-head ${result.correct ? 'is-correct' : 'is-wrong'}`,
    text: result.correct ? labels.correct : result.final ? labels.incorrect : formatLabel(labels.tryAgain, { n: result.attemptsLeft })
  });
  const showFeedback = (feedback: HTMLElement, result: PartialResult, count: string | null, html: string) => {
    feedback.replaceChildren(resultHead(result));
    if (count && !result.correct) feedback.append(element('p', { class: 't-feedback-count', text: count }));
    if (html) feedback.append(element('div', { class: 't-feedback-item t-text', html }));
  };
  const refuse = (feedback: HTMLElement, text: string) => feedback.replaceChildren(element('p', { class: 't-feedback-head is-wrong', text }));
  // The button goes once the answer is final: the focus it had goes to the feedback, which is read.
  const hideSubmit = (submit: HTMLElement, feedback: HTMLElement) => {
    const focused = submit === document.activeElement;
    submit.hidden = true;
    if (focused) { feedback.tabIndex = -1; feedback.focus(); }
  };

  // ── fill-in ──
  function fillIn(wrap: HTMLElement, block: FillInBlock, dry: boolean): Outcome[] | undefined {
    const props = block.props;
    const { presentation, blanks } = props;
    const { group } = labelGroup(wrap, 'stem');
    const text = hook(wrap, 'text') || wrap;
    const feedback = live(hook(wrap, 'feedback')!);
    const submit = hook(wrap, 'submit')!;
    makeButton(submit);
    fillText(submit, labels.submit);
    const longestWord = Math.max(4, ...props.words.map((word) => [...word].length));
    // Bound again (a copy measured for the room, an answered state shown): the answers it holds are
    // read, then given back to the fields made again.
    const current = group.hasAttribute('data-t-built') ? blanks.map((_, index) => {
      const control = hook(text, 'blank', String(index + 1))?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button');
      return !control ? '' : control instanceof HTMLButtonElement ? control.textContent ?? '' : control.value;
    }) : null;
    group.setAttribute('data-t-built', '');
    for (const node of wrap.querySelectorAll('.t-blank-answer, .t-blank-mark')) node.remove();

    // The words to place (bank): one button each, left in its place (hidden) once placed.
    const tokens: { word: string; button: HTMLButtonElement; blank: number }[] = [];
    let bank: HTMLElement | null = null;
    if (presentation === 'bank') {
      bank = hook(wrap, 'bank');
      if (!bank) { bank = element('div', { class: 't-bank', 'data-t-bank': '' }); text.after(bank); }
      bank.replaceChildren();
      bank.setAttribute('role', 'group');
      bank.setAttribute('aria-label', labels.wordBank);
      for (const word of props.words) {
        const button = element('button', { type: 'button', class: 't-word', 'aria-pressed': 'false', text: word });
        bank.append(button);
        tokens.push({ word, button, blank: -1 });
      }
    }
    // A field, a list or a slot in each blank of the text.
    const slots = blanks.map((blank, index) => {
      const node = hook(text, 'blank', String(index + 1));
      if (!node) return null;
      node.replaceChildren();
      node.classList.remove('is-correct', 'is-wrong', 'is-filled');
      const name = formatLabel(labels.blank, { n: index + 1 });
      let control: HTMLInputElement | HTMLSelectElement | HTMLButtonElement;
      if (presentation === 'menus') {
        control = element('select', { class: 't-blank-select', 'aria-label': name }, element('option', { value: '', text: labels.chooseWord }), props.words.map((word) => element('option', { value: word, text: word })));
      } else if (presentation === 'bank') {
        control = element('button', { type: 'button', class: 't-blank-slot', 'aria-label': formatLabel(labels.blankEmpty, { n: index + 1 }) });
        control.style.minWidth = `${longestWord + 1}ch`;
      } else {
        const longest = Math.max(...blank.answers.map((answer) => [...answer].length), 3);
        control = element('input', { type: 'text', class: 't-blank-input', 'aria-label': name, maxlength: blank.maxLength, size: Math.min(28, longest + 3), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
      }
      node.append(control);
      return { index, node, control, token: -1 };
    });
    type Slot = NonNullable<(typeof slots)[number]>;
    let picked = -1;

    const syncTokens = () => tokens.forEach((token, index) => {
      token.button.classList.toggle('is-used', token.blank >= 0);
      token.button.classList.toggle('is-picked', index === picked);
      token.button.setAttribute('aria-pressed', String(index === picked));
    });
    const clearMark = (slot: Slot) => {
      slot.node.classList.remove('is-correct', 'is-wrong');
      slot.node.querySelector('.t-blank-mark')?.remove();
      slot.control.removeAttribute('aria-invalid');
    };
    const syncSlot = (slot: Slot) => {
      const word = slot.token >= 0 ? tokens[slot.token].word : '';
      slot.control.textContent = word;
      slot.control.setAttribute('aria-label', word ? formatLabel(labels.blankFilled, { n: slot.index + 1, word }) : formatLabel(labels.blankEmpty, { n: slot.index + 1 }));
      slot.node.classList.toggle('is-filled', !!word);
    };
    const place = (tokenIndex: number, slot: Slot) => {
      if (slot.token >= 0) tokens[slot.token].blank = -1;
      const token = tokens[tokenIndex];
      const from = token.blank >= 0 ? slots[token.blank] : null;
      if (from) { from.token = -1; syncSlot(from); clearMark(from); }
      token.blank = slot.index;
      slot.token = tokenIndex;
      picked = -1;
      syncSlot(slot);
      clearMark(slot);
      syncTokens();
    };
    const unplace = (slot: Slot) => {
      if (slot.token < 0) return;
      tokens[slot.token].blank = -1;
      slot.token = -1;
      syncSlot(slot);
      clearMark(slot);
      syncTokens();
    };
    const valueOf = (slot: Slot | null): string => !slot ? '' : presentation === 'bank' ? (slot.token >= 0 ? tokens[slot.token].word : '') : (slot.control as HTMLInputElement | HTMLSelectElement).value;
    const answers = () => blanks.map((_, index) => valueOf(slots[index]));
    // Puts given answers in the blanks (resume, dry runs): words to place go back first.
    const fill = (given: readonly string[]) => {
      if (presentation === 'bank') for (const slot of slots) if (slot) unplace(slot);
      slots.forEach((slot, index) => {
        if (!slot) return;
        const value = given[index] ?? '';
        if (presentation !== 'bank') { (slot.control as HTMLInputElement).value = value; return; }
        const token = tokens.findIndex((candidate) => candidate.blank < 0 && candidate.word === value);
        if (token >= 0) place(token, slot);
      });
    };
    const lock = () => {
      for (const slot of slots) {
        if (!slot) continue;
        if (slot.control instanceof HTMLInputElement) slot.control.readOnly = true;
        else slot.control.disabled = true;
      }
      for (const token of tokens) { token.button.disabled = true; token.button.draggable = false; }
    };
    const show = (result: PartialResult) => {
      group.setAttribute('data-t-result', result.correct ? 'correct' : 'incorrect');
      const right = result.marks.filter(Boolean).length;
      showFeedback(feedback, result, blanks.length > 1 ? formatLabel(labels.blanksRight, { n: right, total: blanks.length }) : null, result.correct ? props.feedback.correctHtml : props.feedback.incorrectHtml);
      for (const slot of slots) {
        if (!slot) continue;
        clearMark(slot);
        const ok = result.marks[slot.index];
        slot.node.classList.add(ok ? 'is-correct' : 'is-wrong');
        if (!ok && !(slot.control instanceof HTMLButtonElement)) slot.control.setAttribute('aria-invalid', 'true');
        slot.node.append(element('span', { class: 't-sr-only t-blank-mark', text: ok ? labels.correct : labels.incorrect }));
      }
      if (!result.final) return;
      group.setAttribute('data-t-final', '');
      lock();
      if (props.showCorrectAnswer !== false) {
        for (const slot of slots) {
          if (!slot || result.marks[slot.index]) continue;
          slot.node.append(element('span', { class: 't-blank-answer' }, element('span', { class: 't-sr-only', text: `${labels.correctAnswer}${labels.colon}` }), blanks[slot.index].answers[0] ?? ''));
        }
      }
      hideSubmit(submit, feedback);
    };
    const resultOf = (given: readonly string[], final: boolean): PartialResult => {
      const grade = gradeFillIn(blanks, given, { ignoreAccents: props.ignoreAccents });
      return { ...grade, final: final || grade.correct, attemptsLeft: final ? 0 : (props.attempts || 1) - 1 };
    };

    if (current) fill(current);
    if (dry) {
      const right = blanks.map((blank) => blank.answers[0] ?? '');
      // A wrong word for each blank: a word offered that it does not accept (each word placed once).
      const used = new Set<number>();
      const wrong = blanks.map((blank) => {
        if (presentation === 'typed') return '?';
        const index = props.words.findIndex((word, candidate) => !used.has(candidate) && !blankIsRight(blank, word, { ignoreAccents: props.ignoreAccents }));
        if (index < 0) return '';
        if (presentation === 'bank') used.add(index);
        return props.words[index];
      });
      const outcome = (given: string[], final: boolean): Outcome => () => { fill(given); show(resultOf(given, final)); };
      return [outcome(right, true), outcome(wrong, true), ...((props.attempts || 1) > 1 ? [outcome(wrong, false)] : [])];
    }

    const submitAnswers = () => {
      const given = answers();
      const empty = slots.find((slot) => slot && !valueOf(slot).trim());
      if (empty) { refuse(feedback, labels.fillAll); empty.control.focus(); return; }
      const result = courseState.answerFillIn(block.id, given);
      if (!result) return;
      show(result);
      for (const interaction of fillInInteractions(block.id, props, given, result.marks)) recordInteraction(interaction);
      trigger('quiz.submitted', { target: block.id, correct: result.correct });
    };
    submit.addEventListener('click', submitAnswers);
    for (const slot of slots) {
      if (!slot) continue;
      if (presentation === 'bank') {
        slot.control.addEventListener('click', () => {
          if (picked >= 0) {
            const word = tokens[picked].word;
            place(picked, slot);
            announce(formatLabel(labels.wordPlaced, { word, n: slot.index + 1 }));
          } else if (slot.token >= 0) {
            const word = tokens[slot.token].word;
            unplace(slot);
            announce(formatLabel(labels.wordReturned, { word }));
          } else announce(labels.sortChooseFirst);
        });
      } else {
        slot.control.addEventListener('input', () => clearMark(slot));
        slot.control.addEventListener('change', () => clearMark(slot));
      }
      if (presentation === 'typed') slot.control.addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Enter') { event.preventDefault(); submitAnswers(); } });
    }
    tokens.forEach((token, index) => token.button.addEventListener('click', () => {
      if (token.blank >= 0) return;
      picked = picked === index ? -1 : index;
      syncTokens();
      announce(picked === index ? formatLabel(labels.pickWord, { word: token.word }) : labels.cancelled);
    }));
    wrap.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || picked < 0) return;
      picked = -1;
      syncTokens();
      announce(labels.cancelled);
      event.stopPropagation();
    });
    // Drag: a word onto a blank.
    if (presentation === 'bank' && finePointer()) {
      tokens.forEach((token, index) => {
        token.button.draggable = true;
        token.button.addEventListener('dragstart', (event) => { picked = index; syncTokens(); event.dataTransfer?.setData('text/plain', token.word); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; });
        token.button.addEventListener('dragend', () => { if (tokens[index].blank < 0 && picked === index) { picked = -1; syncTokens(); } });
      });
      for (const slot of slots) {
        if (!slot) continue;
        slot.node.addEventListener('dragover', (event) => { if (picked >= 0) { event.preventDefault(); slot.node.classList.add('is-over'); } });
        slot.node.addEventListener('dragleave', () => slot.node.classList.remove('is-over'));
        slot.node.addEventListener('drop', (event) => {
          event.preventDefault();
          slot.node.classList.remove('is-over');
          if (picked < 0 || group.hasAttribute('data-t-final')) return;
          const word = tokens[picked].word;
          place(picked, slot);
          announce(formatLabel(labels.wordPlaced, { word, n: slot.index + 1 }));
        });
      }
    }
    const saved = courseState.fillInState(block);
    if (saved) {
      fill(saved.answers);
      if (courseState.fillInFinal(block)) show(resultOf(saved.answers, true));
    }
    return undefined;
  }

  // ── sort ──
  function sort(wrap: HTMLElement, block: SortBlock, dry: boolean): Outcome[] | undefined {
    const props = block.props;
    const order = props.presentation === 'order';
    const { group } = labelGroup(wrap, 'stem');
    const feedback = live(hook(wrap, 'feedback')!);
    const submit = hook(wrap, 'submit')!;
    makeButton(submit);
    fillText(submit, labels.submit);
    // Bound again (a copy measured for the room, an answered state shown): the placements it holds are
    // read, what the earlier binding made is made again, then the placements given back.
    const rebound = group.hasAttribute('data-t-built');
    group.setAttribute('data-t-built', '');
    const itemNodes = () => [...wrap.querySelectorAll<HTMLElement>('[data-t-sort-item]')];
    const held = !rebound ? null : order
      ? itemNodes().map((node) => props.items.findIndex((item) => item.id === node.getAttribute('data-t-sort-item'))).filter((index) => index >= 0)
      : props.items.map((item) => {
        const node = itemNodes().find((candidate) => candidate.getAttribute('data-t-sort-item') === item.id);
        const target = node?.parentElement?.closest('[data-t-sort-target]')?.getAttribute('data-t-sort-target');
        return target == null ? -1 : props.targets.findIndex((candidate) => candidate.id === target);
      });
    for (const node of wrap.querySelectorAll('.t-sort-ghost, .t-sort-mark, .t-sort-belongs, .t-sort-moves, .t-sort-where')) node.remove();
    for (const row of wrap.querySelectorAll('.t-sort-row')) row.replaceWith(...row.childNodes);
    const items = props.items.map((item, index) => ({ item, index, node: hook<HTMLButtonElement>(wrap, 'sort-item', item.id), ghost: null as HTMLElement | null, row: null as HTMLElement | null, up: null as HTMLButtonElement | null, down: null as HTMLButtonElement | null }));
    type Item = (typeof items)[number] & { node: HTMLButtonElement };
    const present = items.filter((item): item is Item => !!item.node);
    const pool = hook(wrap, 'pool') || present[0]?.node.parentElement || wrap;
    const targets = props.targets.map((target, index) => {
      const box = hook(wrap, 'sort-target', target.id);
      const place = box ? hook<HTMLButtonElement>(box, 'place') : null;
      let zone = box ? hook(box, 'zone') : null;
      if (box && !zone) { zone = element('div', { class: 't-sort-zone', 'data-t-zone': '' }); box.append(zone); }
      zone?.replaceChildren();
      return { target, index, box, place, zone };
    });
    for (const item of present) item.node.classList.remove('is-correct', 'is-wrong', 'is-picked');
    for (const target of targets) if (target.place) { makeButton(target.place); target.place.setAttribute('aria-label', formatLabel(labels.sortPlaceIn, { target: target.target.label })); }
    pool.setAttribute('role', order ? 'list' : 'group');
    if (!order) pool.setAttribute('aria-label', labels.itemsToPlace); else pool.removeAttribute('aria-label');
    let picked: Item | null = null;
    const placement = props.items.map(() => -1);
    let arrangement = props.shuffled.filter((index) => items[index]?.node);

    const syncPicked = () => { for (const item of present) { item.node.classList.toggle('is-picked', item === picked); item.node.setAttribute('aria-pressed', String(item === picked)); } };
    const clearMark = (item: Item) => {
      item.node.classList.remove('is-correct', 'is-wrong');
      item.node.querySelector('.t-sort-mark')?.remove();
    };
    // Where a placed item is, said after its words.
    const syncWhere = (item: Item) => {
      item.node.querySelector('.t-sort-where')?.remove();
      const target = targets[placement[item.index]];
      if (target) item.node.append(element('span', { class: 't-sr-only t-sort-where', text: ` (${formatLabel(labels.sortIn, { target: target.target.label })})` }));
    };
    // pairs and categories: into a target, or back to its place among the items to place (-1); the
    // place it leaves keeps its room.
    const placeItem = (item: Item, targetIndex: number) => {
      const target = targets[targetIndex];
      if (targetIndex >= 0 && !target?.zone) return;
      if (targetIndex < 0) {
        if (item.ghost) { item.ghost.replaceWith(item.node); item.ghost = null; }
      } else {
        if (props.presentation === 'pairs') {
          const occupant = present.find((other) => other !== item && placement[other.index] === targetIndex);
          if (occupant) placeItem(occupant, -1);
        }
        if (!item.ghost) {
          const ghost = item.node.cloneNode(true) as HTMLElement;
          ghost.removeAttribute('data-t-sort-item');
          ghost.removeAttribute('id');
          ghost.classList.remove('is-picked');
          ghost.classList.add('t-sort-ghost');
          ghost.setAttribute('aria-hidden', 'true');
          ghost.inert = true;
          item.ghost = ghost;
          item.node.replaceWith(ghost);
        }
        target!.zone!.append(item.node);
      }
      placement[item.index] = targetIndex;
      syncWhere(item);
      clearMark(item);
    };
    // order: the rows in the learner's order; the focus stays where it was.
    const renderOrder = () => {
      const active = document.activeElement;
      for (const index of arrangement) { const item = items[index]; if (item.row) pool.append(item.row); }
      arrangement.forEach((index, position) => {
        const item = items[index];
        item.up?.setAttribute('aria-disabled', String(position === 0));
        item.down?.setAttribute('aria-disabled', String(position === arrangement.length - 1));
      });
      if (active instanceof HTMLElement && active !== document.activeElement && wrap.contains(active)) active.focus();
    };
    const moveTo = (item: Item, position: number) => {
      const from = arrangement.indexOf(item.index);
      if (from < 0 || position < 0 || position >= arrangement.length) return false;
      arrangement.splice(from, 1);
      arrangement.splice(position, 0, item.index);
      renderOrder();
      for (const other of present) clearMark(other);
      return true;
    };
    if (order) {
      for (const item of present) {
        const up = element('button', { type: 'button', class: 't-sort-move t-sort-move--up', 'aria-label': formatLabel(labels.moveUp, { item: item.item.label }) }, icon('chevronUp'));
        const down = element('button', { type: 'button', class: 't-sort-move t-sort-move--down', 'aria-label': formatLabel(labels.moveDown, { item: item.item.label }) }, icon('chevronDown'));
        item.up = up;
        item.down = down;
        item.row = element('div', { class: 't-sort-row', role: 'listitem' });
        item.node.replaceWith(item.row);
        item.row.append(item.node, element('span', { class: 't-sort-moves' }, up, down));
      }
      renderOrder();
    } else for (const index of props.shuffled) { const node = items[index]?.node; if (node) pool.append(node); }

    const current = () => (order ? [...arrangement] : [...placement]);
    const set = (given: readonly number[]) => {
      if (order) { arrangement = given.filter((index) => items[index]?.node); renderOrder(); return; }
      for (const item of present) placeItem(item, -1);
      for (const item of present) if ((given[item.index] ?? -1) >= 0) placeItem(item, given[item.index]);
    };
    const lock = () => {
      for (const item of present) { item.node.disabled = true; item.node.draggable = false; if (item.up) item.up.disabled = true; if (item.down) item.down.disabled = true; if (item.row) item.row.draggable = false; }
      for (const target of targets) if (target.place) target.place.disabled = true;
    };
    const show = (result: PartialResult) => {
      group.setAttribute('data-t-result', result.correct ? 'correct' : 'incorrect');
      showFeedback(feedback, result, formatLabel(labels.itemsRight, { n: result.marks.filter(Boolean).length, total: props.items.length }), result.correct ? props.feedback.correctHtml : props.feedback.incorrectHtml);
      for (const item of present) {
        clearMark(item);
        const ok = result.marks[item.index];
        item.node.classList.add(ok ? 'is-correct' : 'is-wrong');
        item.node.append(element('span', { class: 't-sr-only t-sort-mark', text: ` (${ok ? labels.markRight : labels.markWrong})` }));
      }
      picked = null;
      syncPicked();
      if (!result.final) return;
      group.setAttribute('data-t-final', '');
      lock();
      if (props.showCorrectAnswer !== false) {
        for (const item of present) {
          if (result.marks[item.index]) continue;
          const where = order ? formatLabel(labels.rightPosition, { n: item.index + 1 }) : formatLabel(labels.rightPlace, { target: props.targets[item.item.target]?.label ?? '' });
          item.node.append(element('span', { class: 't-sort-belongs', text: where }));
        }
      }
      hideSubmit(submit, feedback);
    };
    if (held) set(held);
    const resultOf = (given: readonly number[], final: boolean): PartialResult => {
      const grade = gradeSort(props, given);
      return { ...grade, final: final || grade.correct, attemptsLeft: final ? 0 : (props.attempts || 1) - 1 };
    };

    if (dry) {
      const count = props.items.length;
      const right = order ? props.items.map((_, index) => index) : props.items.map((item) => item.target);
      // The wrong answers that take the most room: every item in one category (each in turn), each pair
      // shifted (by one, two…), the order turned by one: every item wrong, each saying where it belonged.
      const wrongs = order ? [[...right.slice(1), right[0]]]
        : props.presentation === 'pairs' ? Array.from({ length: Math.max(0, count - 1) }, (_, shift) => props.items.map((_, index) => props.items[(index + shift + 1) % count].target))
          : props.targets.map((_, target) => props.items.map(() => target));
      const outcome = (given: number[], final: boolean): Outcome => () => { set(given); show(resultOf(given, final)); };
      return [outcome(right, true), ...wrongs.map((wrong) => outcome(wrong, true)), ...((props.attempts || 1) > 1 ? wrongs.map((wrong) => outcome(wrong, false)) : [])];
    }

    submit.addEventListener('click', () => {
      if (!order && !sortComplete(props, placement)) { refuse(feedback, labels.sortAll); return; }
      const given = current();
      const result = courseState.answerSort(block.id, given);
      if (!result) return;
      show(result);
      recordInteraction(sortInteraction(block.id, props, given, result.correct));
      trigger('quiz.submitted', { target: block.id, correct: result.correct });
    });
    for (const item of present) {
      item.node.addEventListener('click', () => {
        if (group.hasAttribute('data-t-final')) return;
        if (order && picked && picked !== item) {
          const moved = picked;
          picked = null;
          syncPicked();
          if (moveTo(moved, arrangement.indexOf(item.index))) { moved.node.focus(); announce(formatLabel(labels.movedTo, { item: moved.item.label, n: arrangement.indexOf(moved.index) + 1, total: arrangement.length })); }
          return;
        }
        picked = picked === item ? null : item;
        syncPicked();
        announce(picked ? formatLabel(labels.sortPick, { item: item.item.label }) : labels.cancelled);
      });
      const step = (by: number) => () => {
        const position = arrangement.indexOf(item.index) + by;
        if (group.hasAttribute('data-t-final') || !moveTo(item, position)) return;
        announce(formatLabel(labels.movedTo, { item: item.item.label, n: position + 1, total: arrangement.length }));
      };
      item.up?.addEventListener('click', step(-1));
      item.down?.addEventListener('click', step(1));
    }
    for (const target of targets) {
      target.place?.addEventListener('click', () => {
        if (!picked) { announce(labels.sortChooseFirst); return; }
        const item = picked;
        picked = null;
        placeItem(item, target.index);
        syncPicked();
        announce(formatLabel(labels.sortPlaced, { item: item.item.label, target: target.target.label }));
      });
    }
    wrap.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !picked) return;
      picked = null;
      syncPicked();
      announce(labels.cancelled);
      event.stopPropagation();
    });
    // Drag: an item onto a target (or back among the items to place), a row onto another row.
    if (finePointer()) {
      let dragged: Item | null = null;
      for (const item of present) {
        const handle = order ? item.row! : item.node;
        handle.draggable = true;
        handle.addEventListener('dragstart', (event) => { dragged = item; item.node.classList.add('is-dragging'); event.dataTransfer?.setData('text/plain', item.item.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; });
        handle.addEventListener('dragend', () => { item.node.classList.remove('is-dragging'); dragged = null; });
        if (order) {
          item.row!.addEventListener('dragover', (event) => { if (dragged) event.preventDefault(); });
          item.row!.addEventListener('drop', (event) => {
            event.preventDefault();
            if (!dragged || dragged === item || group.hasAttribute('data-t-final')) return;
            const moved = dragged;
            if (moveTo(moved, arrangement.indexOf(item.index))) announce(formatLabel(labels.movedTo, { item: moved.item.label, n: arrangement.indexOf(moved.index) + 1, total: arrangement.length }));
          });
        }
      }
      const dropOn = (node: HTMLElement | null, targetIndex: number) => {
        if (!node) return;
        node.addEventListener('dragover', (event) => { if (dragged) { event.preventDefault(); node.classList.add('is-over'); } });
        node.addEventListener('dragleave', (event) => { if (!node.contains(event.relatedTarget as Node | null)) node.classList.remove('is-over'); });
        node.addEventListener('drop', (event) => {
          event.preventDefault();
          event.stopPropagation();
          node.classList.remove('is-over');
          if (!dragged || group.hasAttribute('data-t-final')) return;
          const item = dragged;
          placeItem(item, targetIndex);
          picked = null;
          syncPicked();
          if (targetIndex >= 0) announce(formatLabel(labels.sortPlaced, { item: item.item.label, target: props.targets[targetIndex].label }));
        });
      };
      if (!order) { for (const target of targets) dropOn(target.box, target.index); dropOn(pool, -1); }
    }
    const saved = courseState.sortState(block);
    if (saved) {
      set(saved.placement);
      if (courseState.sortFinal(block)) show(resultOf(saved.placement, true));
    }
    return undefined;
  }

  // ── reflection ──
  function reflection(wrap: HTMLElement, block: ReflectionBlock, dry: boolean): Outcome[] | undefined {
    const props = block.props;
    const scale = props.presentation === 'scale';
    const { group, head } = labelGroup(wrap, 'prompt');
    const response = hook(wrap, 'response')!;
    const feedback = live(hook(wrap, 'feedback')!);
    const submit = hook(wrap, 'submit')!;
    makeButton(submit);
    fillText(submit, labels.save);
    // Bound again: what the field or the scale holds is given back to the one made again.
    const held = response.querySelector<HTMLTextAreaElement>('textarea')?.value ?? response.querySelector<HTMLInputElement>('input:checked')?.value;
    response.replaceChildren();
    // The expert's answer: outside the live region, which only says it was saved.
    let model = hook(wrap, 'model');
    if (!model && props.modelHtml) { model = element('div', { class: 't-reflection-model', 'data-t-model': '' }); feedback.after(model); }
    if (model) { model.replaceChildren(); model.hidden = true; }
    let download = hook<HTMLButtonElement>(wrap, 'download');
    if (!download && props.download) { download = element('button', { type: 'button', class: 't-btn t-btn--secondary t-reflection-download', 'data-t-download': '' }); (model || feedback).after(download); }
    if (download) {
      makeButton(download);
      if (!download.textContent?.trim()) download.append(icon('download'), element('span', { text: labels.myAnswers }));
      download.hidden = true;
    }

    let read: () => string | number | null;
    let write: (value: string | number) => void;
    if (scale) {
      const name = uniqueId('scale');
      const { min, max, minLabel, maxLabel } = props.scale;
      const minId = minLabel ? uniqueId('scale-min') : undefined;
      const maxId = maxLabel ? uniqueId('scale-max') : undefined;
      const inputs: HTMLInputElement[] = [];
      const points = element('div', { class: 't-scale-points' });
      for (let value = min; value <= max; value++) {
        const input = element('input', { type: 'radio', class: 't-scale-input', name, value: String(value), 'aria-describedby': value === min ? minId : value === max ? maxId : undefined });
        inputs.push(input);
        points.append(element('label', { class: 't-scale-point' }, input, element('span', { class: 't-scale-value', text: String(value) })));
      }
      const radios = element('div', { class: 't-scale', role: 'radiogroup', 'aria-labelledby': head?.id }, points);
      if (minLabel || maxLabel) radios.append(element('div', { class: 't-scale-ends' }, element('span', { class: 't-scale-end', id: minId, text: minLabel }), element('span', { class: 't-scale-end t-scale-end--max', id: maxId, text: maxLabel })));
      response.append(radios);
      read = () => { const chosen = inputs.find((input) => input.checked); return chosen ? Number(chosen.value) : null; };
      write = (value) => { for (const input of inputs) input.checked = Number(input.value) === value; };
    } else {
      const count = element('p', { class: 't-reflection-count', id: uniqueId('count') });
      const field = element('textarea', { class: 't-reflection-input', rows: props.rows, maxlength: props.maxLength, 'aria-labelledby': head?.id, 'aria-describedby': count.id });
      const syncCount = () => { count.textContent = formatLabel(labels.characters, { n: field.value.length, max: props.maxLength }); };
      field.addEventListener('input', syncCount);
      syncCount();
      response.append(field, count);
      read = () => (field.value.trim() ? field.value : null);
      write = (value) => { field.value = String(value); syncCount(); };
    }
    if (held) write(scale ? Number(held) : held);
    const showSaved = () => {
      group.setAttribute('data-t-saved', '');
      feedback.replaceChildren(element('p', { class: 't-feedback-head is-correct', text: labels.saved }));
      if (model && props.modelHtml) {
        if (!model.textContent?.trim()) model.append(element('p', { class: 't-reflection-model-head', text: labels.expertAnswer }), element('div', { class: 't-text', html: props.modelHtml }));
        model.hidden = false;
      }
      if (download) download.hidden = false;
    };
    if (dry) {
      return [
        () => { write(scale ? props.scale.max : '…'); showSaved(); },
        () => refuse(feedback, scale ? labels.scaleEmpty : labels.reflectionEmpty)
      ];
    }
    submit.addEventListener('click', () => {
      const value = read();
      if (value === null) { refuse(feedback, scale ? labels.scaleEmpty : labels.reflectionEmpty); return; }
      if (!courseState.saveReflection(block.id, value)) return;
      // Emptied, then filled: saving again is said again.
      feedback.replaceChildren();
      setTimeout(showSaved, 30);
      recordInteraction(reflectionInteraction(block.id, props, value));
      // No event listens to a reflection; the trigger has the screen's completion, and the steps that
      // wait for an answer, follow it.
      trigger('quiz.submitted', { target: block.id });
    });
    download?.addEventListener('click', () => saveAnswers());
    const saved = courseState.reflectionOf(block);
    if (saved !== null) { write(saved); showSaved(); }
    return undefined;
  }

  // « Mes réponses »: every reflection of the course with what the learner saved, as a text file made
  // in the page (nothing leaves the browser).
  function answersText(): string {
    const lines = [courseTitle ? `${courseTitle} — ${labels.myAnswers}` : labels.myAnswers, ''];
    for (const screen of courseState.screens) {
      for (const block of flatBlocks([...screen.blocks, ...screen.layers.flatMap((layer) => layer.blocks)])) {
        if (!hasBehavior(block, 'reflection')) continue;
        const value = courseState.reflectionOf(block);
        const { scale } = block.props;
        const answer = value === null ? labels.noAnswer : typeof value === 'number' ? formatLabel(labels.scaleAnswer, { value, min: scale.min, max: scale.max }) : value;
        lines.push(`${screen.title}`, block.props.prompt, '', answer, '', '');
      }
    }
    return `${lines.join('\n').trim()}\n`;
  }
  function saveAnswers(): void {
    const slug = (text: string) => text.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    const name = `${[slug(courseTitle), slug(labels.myAnswers)].filter(Boolean).join('-') || 'answers'}.txt`;
    const url = URL.createObjectURL(new Blob([answersText()], { type: 'text/plain;charset=utf-8' }));
    const link = element('a', { href: url, download: name, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  return { fillIn, sort, reflection, answersText };
}
