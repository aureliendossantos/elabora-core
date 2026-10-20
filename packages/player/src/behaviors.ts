// Headless behaviours. The component template owns the markup; the player owns what must not be
// left to each template: scoring, saved state, SCORM interactions, announcements, focus and keyboard
// handling. Templates expose hooks (data-t-… attributes); the contract is in docs/components.md.
//
//   quiz      data-t-stem, data-t-option="<id>" (a <label>, one per option), data-t-input (optional
//             <input> inside the option), data-t-submit, data-t-feedback; optional data-t-group,
//             data-t-option-feedback and data-t-flag (inside the option, or ="<id>" next to it).
//   numeric   data-t-stem, data-t-input, data-t-submit, data-t-feedback; optional data-t-input-label,
//             data-t-unit, data-t-expected, data-t-group.
//   decision  data-t-prompt, data-t-choice="<id>" (a <button> per option), data-t-feedback.
//   results   data-t-score, data-t-status, data-t-message, data-t-retry (all optional).
// Any template: data-t-click (button firing the screen event "click"; ="<name>" names it), data-t-toggle="<part>"
// with data-t-part="<part>" (disclosure; data-t-open shows it first), data-t-tabs with data-t-tab="<k>" and
// data-t-panel="<k>" (tabs; data-t-selected picks the first), data-t-label="<label id>" (player label).
// Buttons, tabs and disclosures are the block's controls: each fires "click" with its name when the
// learner uses it, and gets data-t-visited once used (tabs and disclosures: once their content is shown).
//
// State for styling: options get is-selected, is-correct, is-wrong; the group gets
// data-t-result="correct|incorrect" and data-t-final once the answer is final.
//
// Dry run (outcomes): the behaviour binds the markup but not the course state, and returns its
// possible outcomes, each a function that renders that outcome (feedback, flags, messages). The
// player renders them on a hidden copy to reserve the room an answered activity needs in slides,
// and fit checks and screenshots render the tallest one ("answered" state).

import { hasBehavior } from './course-state.ts';
import type { CourseState, NumericResult, QuizResult, Score, TriggerInfo } from './course-state.ts';
import type { BlockData, DecisionBlock, DecisionOption, NumericBlock, QuizBlock, ResultsBlock, TriggerType } from './course-data.ts';
import type { Labels } from './labels.ts';
import type { Interaction } from './scorm12.ts';
import { element, uniqueId } from './dom.ts';
import { parseNumber, gradeNumeric, formatNumber } from './numeric.ts';

export interface BehaviorContext {
  courseState: CourseState;
  labels: Labels;
  // Course language: numbers typed and shown.
  language: string;
  formatLabel(label: string, values: Readonly<Record<string, unknown>>): string;
  // Says a message in the live region.
  announce(message: string): void;
  recordInteraction(interaction: Interaction): void;
  trigger(type: TriggerType, info: TriggerInfo): void;
  // Takes the assessment again (the retry button of results).
  retake(): void;
}

// Renders one possible outcome of an activity (dry run).
export type Outcome = () => void;

export type Behaviors = ReturnType<typeof createBehaviors>;

// What owns the controls of a template: a block, or the screen for its layout.
interface ControlOwner {
  id: string;
  visits?: Record<string, string>;
}

interface Control {
  node: HTMLElement;
  hook: 'click' | 'tab' | 'toggle';
  name: string;
}

// SCORM 1.2 responses and patterns name choices by letter: a, b, c…
const letter = (index: number) => String.fromCharCode(97 + index);

export function createBehaviors({ courseState, labels, language, formatLabel, announce, recordInteraction, trigger, retake }: BehaviorContext) {
  // Controls of each template root (bound before the slots are filled), and the refresh of each results block.
  const controlsOf = new WeakMap<Element, Control[]>();
  const refreshers = new WeakMap<Element, () => void>();

  const escapeValue = (value: string) => String(value).replace(/["\\]/g, '\\$&');
  const findHook = <E extends Element = HTMLElement>(root: ParentNode, hook: string, value?: string) => root.querySelector<E>(value === undefined ? `[data-t-${hook}]` : `[data-t-${hook}="${escapeValue(value)}"]`);
  // A hook the behaviour requires: the validator checks that the template has it (BEHAVIORS in @elabora/core).
  const requiredHook = <E extends Element = HTMLElement>(root: ParentNode, hook: string) => findHook<E>(root, hook) as E;
  const findHooks = (root: ParentNode, hook: string) => [...root.querySelectorAll<HTMLElement>(`[data-t-${hook}]`)];
  // Hooks on buttons get type="button": they never submit a form.
  const makeButton = (node: HTMLElement) => { if ('type' in node) node.type = 'button'; };
  // Words come from the player labels (course language, course.ui overrides) when the template
  // leaves an element empty; an icon inside stays.
  const fillText = (node: Element | null, text: string) => { if (node && !node.textContent?.trim()) node.append(text); };
  const groupOf = (wrap: HTMLElement): Element => findHook(wrap, 'group') || wrap.firstElementChild || wrap;
  const live = <T extends Element | null>(node: T): T => { if (!node) return node; node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); return node; };
  const labelGroup = (wrap: HTMLElement, hook: string) => {
    const group = groupOf(wrap);
    const head = findHook(wrap, hook);
    if (head) { head.id ||= uniqueId(hook); group.setAttribute('aria-labelledby', head.id); }
    if (group.tagName !== 'FIELDSET') group.setAttribute('role', 'group');
    return { group, head };
  };

  // ── primitives, for every template ──
  // Controls remember being used: the visited state is recorded before the click event runs, so
  // its conditions see it (all visited, on the last one).
  const syncVisited = (root: Element, owner: ControlOwner) => { for (const control of controlsOf.get(root) || []) control.node.toggleAttribute('data-t-visited', !!owner.visits && courseState.controlVisited(owner.id, control.name)); };
  function use(root: Element, owner: ControlOwner, name: string) {
    if (owner.visits) courseState.visitControl(owner.id, name);
    syncVisited(root, owner);
    trigger('click', { target: owner.id, name: name || undefined });
  }
  function primitives(root: HTMLElement, owner: ControlOwner) {
    for (const node of findHooks(root, 'label')) if (!node.textContent?.trim()) node.textContent = labels[node.getAttribute('data-t-label') ?? ''] ?? '';
    // Bound before the slots are filled: the controls of nested blocks belong to those blocks.
    controlsOf.set(root, (['click', 'tab', 'toggle'] as const).flatMap((hook) => findHooks(root, hook).map((node) => ({ node, hook, name: node.getAttribute(`data-t-${hook}`) || '' }))));
    for (const button of findHooks(root, 'click')) {
      makeButton(button);
      button.addEventListener('click', () => use(root, owner, button.getAttribute('data-t-click') || ''));
    }
    for (const button of findHooks(root, 'toggle')) {
      const part = findHook(root, 'part', button.getAttribute('data-t-toggle') ?? '');
      if (!part) continue;
      part.id ||= uniqueId('part');
      makeButton(button);
      button.setAttribute('aria-controls', part.id);
      const set = (open: boolean) => { part.hidden = !open; button.setAttribute('aria-expanded', String(open)); };
      set(part.hasAttribute('data-t-open'));
      button.addEventListener('click', () => { set(!!part.hidden); use(root, owner, button.getAttribute('data-t-toggle') ?? ''); });
    }
    for (const box of findHooks(root, 'tabs')) {
      const tabs = findHooks(box, 'tab');
      const panels = findHooks(box, 'panel');
      if (!tabs.length) continue;
      tabs[0].parentElement?.setAttribute('role', 'tablist');
      const panelOf = (tab: HTMLElement) => panels.find((panel) => panel.getAttribute('data-t-panel') === tab.getAttribute('data-t-tab'));
      for (const tab of tabs) {
        makeButton(tab);
        tab.setAttribute('role', 'tab');
        tab.id ||= uniqueId('tab');
        const panel = panelOf(tab);
        if (panel) { panel.id ||= uniqueId('panel'); panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0; tab.setAttribute('aria-controls', panel.id); }
      }
      const select = (selected: HTMLElement, focus?: boolean) => {
        for (const tab of tabs) {
          const on = tab === selected;
          tab.setAttribute('aria-selected', String(on));
          tab.tabIndex = on ? 0 : -1;
          const panel = panelOf(tab);
          if (panel) panel.hidden = !on;
        }
        if (focus) selected.focus();
      };
      select(tabs.find((tab) => tab.hasAttribute('data-t-selected')) || tabs[0]);
      tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => { select(tab); use(root, owner, tab.getAttribute('data-t-tab') ?? ''); });
        tab.addEventListener('keydown', (event) => {
          const moves: Readonly<Record<string, number | undefined>> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: tabs.length - 1 };
          const target = moves[event.key];
          if (target === undefined) return;
          event.preventDefault();
          const next = tabs[(target + tabs.length) % tabs.length];
          select(next, true);
          use(root, owner, next.getAttribute('data-t-tab') ?? '');
        });
      });
    }
    syncVisited(root, owner);
  }
  // Tabs and disclosures count as visited once their content is shown, without a click: the
  // selected tab (or open part) of a block in view, not in a pending step nor concealed. The player
  // calls this whenever blocks come into view.
  function noteShown(container: ParentNode) {
    for (const wrap of container.querySelectorAll<HTMLElement>('.t-block[data-block]')) {
      const block = courseState.blockIndex.get(wrap.dataset.block ?? '')?.block;
      const controls = controlsOf.get(wrap);
      if (!block?.visits || !controls?.length || wrap.closest('[inert]')) continue;
      let seen = false;
      for (const control of controls) {
        const shown = control.hook === 'tab' ? control.node.getAttribute('aria-selected') === 'true' : control.hook === 'toggle' && control.node.getAttribute('aria-expanded') === 'true';
        if (shown && !control.node.closest('[hidden]') && courseState.visitControl(block.id, control.name)) seen = true;
      }
      if (seen) syncVisited(wrap, block);
    }
  }

  // ── quiz: single or multiple choice ──
  function quiz(wrap: HTMLElement, block: QuizBlock, dry: boolean): Outcome[] | undefined {
    const props = block.props;
    const { group } = labelGroup(wrap, 'stem');
    const name = uniqueId('q');
    const feedback = live(requiredHook(wrap, 'feedback'));
    const submit = requiredHook(wrap, 'submit');
    makeButton(submit);
    fillText(submit, labels.submit);
    const items = props.options.map((option) => {
      const node = findHook(wrap, 'option', option.id);
      if (!node) return null;
      let input = node.querySelector('input');
      if (!input) { input = element('input'); node.prepend(input); }
      input.type = props.mode === 'multiple' ? 'checkbox' : 'radio';
      input.name = name;
      input.value = option.id;
      // Per-option feedback and flag: inside the option, or next to it with the option id.
      const optionFeedback = findHook(node, 'option-feedback') || findHook(wrap, 'option-feedback', option.id);
      const flag = findHook(node, 'flag') || findHook(wrap, 'flag', option.id);
      if (optionFeedback) optionFeedback.hidden = true;
      if (flag) flag.hidden = true;
      return { option, node, input, optionFeedback, flag };
    }).filter((item) => item !== null);
    const syncSelected = () => { for (const item of items) item.node.classList.toggle('is-selected', item.input.checked); };
    // Compact feedback: the chosen option's text is not shown again (it is marked where it is),
    // only read to screen readers. Read when the result shows, so that a reserved room can be
    // measured both ways (screen-view.ts feedbackRooms).
    if (props.feedbackStyle === 'compact') group.setAttribute('data-t-feedback-style', 'compact');

    const showResult = (selected: readonly string[], result: QuizResult) => {
      feedback.replaceChildren();
      group.setAttribute('data-t-result', result.correct ? 'correct' : 'incorrect');
      for (const item of items) {
        item.node.classList.remove('is-correct', 'is-wrong');
        if (item.optionFeedback) item.optionFeedback.hidden = true;
        if (item.flag) item.flag.hidden = true;
        item.node.querySelector('.t-option-flag')?.remove();
      }
      const head = result.correct ? labels.correct : result.final ? labels.incorrect : formatLabel(labels.tryAgain, { n: result.attemptsLeft });
      feedback.append(element('p', { class: `t-feedback-head ${result.correct ? 'is-correct' : 'is-wrong'}`, text: head }));
      const chosen = items.filter((candidate) => selected.includes(candidate.option.id));
      const compact = group.getAttribute('data-t-feedback-style') === 'compact' && chosen.filter((item) => !item.optionFeedback && item.option.feedbackHtml).length <= 1;
      for (const item of chosen) {
        if (item.optionFeedback) { if (!item.optionFeedback.textContent?.trim()) item.optionFeedback.innerHTML = item.option.feedbackHtml; item.optionFeedback.hidden = false; }
        else if (item.option.feedbackHtml) feedback.append(element('div', { class: 't-feedback-item t-text' }, element('strong', { class: compact ? 't-feedback-option t-sr-only' : 't-feedback-option', text: `${item.option.text} — ` }), element('span', { html: item.option.feedbackHtml.replace(/^<p>|<\/p>\s*$/g, '') })));
      }
      if (result.final) {
        group.setAttribute('data-t-final', '');
        for (const item of items) {
          item.input.disabled = true;
          if (props.showCorrectAnswer !== false && item.option.correct) {
            item.node.classList.add('is-correct');
            if (item.flag) { fillText(item.flag, labels.correctAnswer); item.flag.hidden = false; } else item.node.append(element('span', { class: 't-option-flag', text: ` (${labels.correctAnswer})` }));
          } else if (selected.includes(item.option.id) && !item.option.correct) item.node.classList.add('is-wrong');
        }
        submit.hidden = true;
      }
    };

    if (dry) {
      const attempts = props.attempts || 1;
      const correctIds = props.options.filter((option) => option.correct).map((option) => option.id);
      const choices = props.mode === 'multiple' ? [props.options.map((option) => option.id), correctIds] : props.options.map((option) => [option.id]);
      const outcomes: Outcome[] = [];
      for (const selected of choices) {
        const correct = selected.length === correctIds.length && selected.every((id) => correctIds.includes(id));
        outcomes.push(() => { for (const item of items) item.input.checked = selected.includes(item.option.id); syncSelected(); showResult(selected, { correct, final: true, attemptsLeft: 0 }); });
        if (!correct && attempts > 1) outcomes.push(() => { for (const item of items) item.input.checked = selected.includes(item.option.id); syncSelected(); showResult(selected, { correct: false, final: false, attemptsLeft: attempts - 1 }); });
      }
      return outcomes;
    }
    for (const item of items) item.input.addEventListener('change', syncSelected);

    submit.addEventListener('click', () => {
      const selected = items.filter((item) => item.input.checked).map((item) => item.option.id);
      if (!selected.length) { announce(labels.yourAnswer); return; }
      const result = courseState.answerQuiz(block.id, selected);
      if (!result) return;
      showResult(selected, result);
      recordInteraction({
        id: block.id, type: 'choice', objective: props.objective, weight: props.weight || 1,
        response: selected.map((id) => letter(props.options.findIndex((option) => option.id === id))).join(','),
        correctPattern: props.options.map((option, index) => (option.correct ? letter(index) : null)).filter(Boolean).join(','),
        result: result.correct ? 'correct' : 'wrong'
      });
      trigger('quiz.submitted', { target: block.id, correct: result.correct });
    });

    const saved = courseState.quizState(block);
    if (saved) {
      for (const item of items) item.input.checked = saved.selected.includes(item.option.id);
      syncSelected();
      if (courseState.quizFinal(block)) showResult(saved.selected, { correct: courseState.quizIsCorrect(block, saved.selected), final: true, attemptsLeft: 0 });
    }
    return undefined;
  }

  // ── numeric answer ──
  function numeric(wrap: HTMLElement, block: NumericBlock, dry: boolean): Outcome[] | undefined {
    const props = block.props;
    const { group, head: stem } = labelGroup(wrap, 'stem');
    const input = requiredHook<HTMLInputElement>(wrap, 'input');
    input.type = 'text';
    input.setAttribute('inputmode', 'decimal');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.id ||= uniqueId('num');
    const label = findHook<HTMLLabelElement>(wrap, 'input-label');
    if (label) { label.htmlFor = input.id; fillText(label, labels.yourAnswer); } else if (stem) input.setAttribute('aria-labelledby', stem.id);
    const unit = findHook(wrap, 'unit');
    if (unit) { unit.id ||= uniqueId('unit'); input.setAttribute('aria-describedby', unit.id); }
    const feedback = live(requiredHook(wrap, 'feedback'));
    const expectedHost = findHook(wrap, 'expected');
    const submit = requiredHook(wrap, 'submit');
    makeButton(submit);
    fillText(submit, labels.submit);
    const show = (result: NumericResult) => {
      feedback.replaceChildren();
      group.setAttribute('data-t-result', result.correct ? 'correct' : 'incorrect');
      const head = result.correct ? labels.correct : result.final ? labels.incorrect : formatLabel(labels.tryAgain, { n: result.attemptsLeft });
      feedback.append(element('p', { class: `t-feedback-head ${result.correct ? 'is-correct' : 'is-wrong'}`, text: head }));
      const html = result.correct ? props.feedback.correctHtml : result.misconception ? result.misconception.feedbackHtml : props.feedback.incorrectHtml;
      if (html) feedback.append(element('div', { class: 't-feedback-item t-text', html }));
      input.classList.toggle('is-correct', result.correct);
      input.classList.toggle('is-wrong', !result.correct);
      input.setAttribute('aria-invalid', String(!result.correct));
      if (result.final) {
        group.setAttribute('data-t-final', '');
        input.readOnly = true;
        submit.hidden = true;
        if (!result.correct && props.showCorrectAnswer !== false) {
          const node = element('p', { class: 't-numeric-expected' }, `${labels.expectedValue}${labels.colon}`, element('strong', { text: `${formatNumber(props.answer, language)}${props.unit ? ` ${props.unit}` : ''}` }));
          if (expectedHost) expectedHost.replaceChildren(node); else feedback.append(node);
        }
      }
    };
    const invalid = () => feedback.replaceChildren(element('p', { class: 't-feedback-head is-wrong', text: labels.numberInvalid }));
    if (dry) {
      const attempts = props.attempts || 1;
      const wrong = props.answer + Math.max(1, Math.abs(props.answer)) * 10;
      const typed = (value: number, result: NumericResult): Outcome => () => { input.value = formatNumber(value, language); show(result); };
      return [
        typed(props.answer, { ...gradeNumeric(props, props.answer), final: true, attemptsLeft: 0 }),
        typed(wrong, { ...gradeNumeric(props, wrong), final: true, attemptsLeft: 0 }),
        ...(props.misconceptions || []).map((misconception) => typed(misconception.value, { ...gradeNumeric(props, misconception.value), final: true, attemptsLeft: 0 })),
        ...(attempts > 1 ? [typed(wrong, { ...gradeNumeric(props, wrong), final: false, attemptsLeft: attempts - 1 })] : []),
        () => { input.value = '?'; invalid(); }
      ];
    }
    const answer = () => {
      const value = parseNumber(input.value, language);
      if (value === null) {
        invalid();
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      const result = courseState.answerNumeric(block.id, value);
      if (!result) return;
      show(result);
      recordInteraction({ id: block.id, type: 'numeric', objective: props.objective, weight: props.weight || 1, response: String(value), correctPattern: String(props.answer), result: result.correct ? 'correct' : 'wrong' });
      trigger('quiz.submitted', { target: block.id, correct: result.correct });
    };
    submit.addEventListener('click', answer);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); answer(); } });
    const saved = courseState.numericState(block);
    if (saved && saved.value !== null) {
      input.value = saved.value.toLocaleString(language, { useGrouping: false, maximumFractionDigits: 10 });
      if (courseState.numericFinal(block)) show({ ...gradeNumeric(props, saved.value), final: true, attemptsLeft: 0 });
    }
    return undefined;
  }

  // ── decision (scenario choice) ──
  function decision(wrap: HTMLElement, block: DecisionBlock, dry: boolean): Outcome[] | undefined {
    const props = block.props;
    const { group } = labelGroup(wrap, 'prompt');
    const feedback = live(requiredHook(wrap, 'feedback'));
    const buttons = props.options.map((option) => {
      const button = findHook(wrap, 'choice', option.id);
      if (!button) return null;
      makeButton(button);
      button.setAttribute('aria-pressed', 'false');
      if (!dry) button.addEventListener('click', () => choose(option));
      return { option, button };
    }).filter((item) => item !== null);
    const show = (chosenOption: DecisionOption) => {
      group.setAttribute('data-t-result', chosenOption.id);
      for (const { option, button } of buttons) {
        const chosen = option.id === chosenOption.id;
        button.setAttribute('aria-pressed', String(chosen));
        button.classList.toggle('is-selected', chosen);
        if (!props.allowChange && !chosen) button.setAttribute('aria-disabled', 'true');
      }
      if (!props.allowChange) group.setAttribute('data-t-final', '');
      feedback.replaceChildren(chosenOption.feedbackHtml ? element('div', { class: 't-text', html: chosenOption.feedbackHtml }) : '');
    };
    if (dry) return props.options.map((option) => () => show(option));
    function choose(option: DecisionOption) {
      const result = courseState.chooseDecision(block.id, option.id);
      if (!result) return;
      show(option);
      const hasCorrect = props.options.some((candidate) => candidate.correct !== undefined);
      recordInteraction({
        id: block.id, type: 'choice', objective: props.objective, weight: props.weight || 1,
        response: letter(props.options.findIndex((candidate) => candidate.id === option.id)),
        correctPattern: hasCorrect ? props.options.map((candidate, index) => (candidate.correct ? letter(index) : null)).filter(Boolean).join(',') : undefined,
        result: hasCorrect ? (option.correct ? 'correct' : 'wrong') : 'neutral'
      });
      trigger('decision.selected', { target: block.id, option: option.id });
    }
    const saved = courseState.decisionOf(block);
    if (saved) { const option = props.options.find((candidate) => candidate.id === saved); if (option) show(option); }
    return undefined;
  }

  // ── results: score, status, message and retry, refreshed after every change ──
  function results(wrap: HTMLElement, block: ResultsBlock, dry: boolean): Outcome[] | undefined {
    const props = block.props;
    const scoreNode = findHook(wrap, 'score');
    const statusNode = findHook(wrap, 'status');
    const messageNode = findHook(wrap, 'message');
    const retryButton = findHook(wrap, 'retry');
    if (retryButton) { makeButton(retryButton); fillText(retryButton, labels.retry); if (!dry) retryButton.addEventListener('click', retake); }
    const render = (score: Pick<Score, 'raw' | 'decided'>, status: string) => {
      if (scoreNode) {
        scoreNode.hidden = score.raw === null;
        scoreNode.replaceChildren(`${labels.yourScore}${labels.colon}`, element('strong', { text: score.decided ? `${score.raw} %` : '—' }));
      }
      if (statusNode) {
        statusNode.className = statusNode.className.replace(/\bt-status--\S+/g, '').trim();
        // « not attempted » (SCORM) holds a space, which a class name cannot.
        statusNode.classList.add(`t-status--${status.replace(/\s+/g, '-')}`);
        statusNode.replaceChildren(`${labels.status}${labels.colon}`, element('strong', { text: labels[`status_${status}`] || status }));
      }
      if (messageNode) {
        const html = status === 'passed' ? props.passedMessageHtml : status === 'failed' ? props.failedMessageHtml : status === 'completed' ? props.completedMessageHtml : '';
        messageNode.innerHTML = html || '';
        messageNode.hidden = !html;
      }
      if (retryButton) retryButton.hidden = !(props.allowRetry && status === 'failed');
    };
    if (dry) {
      const scores = { passed: 100, failed: 50, completed: 100, incomplete: null };
      return Object.entries(scores).map(([status, raw]) => () => render({ raw, decided: raw !== null }, status));
    }
    const refresh = () => render(courseState.computeStatus().score, courseState.lmsStatus);
    refreshers.set(wrap, refresh);
    refresh();
    return undefined;
  }

  function run(wrap: HTMLElement, block: BlockData, dry: boolean): Outcome[] | undefined {
    if (hasBehavior(block, 'quiz')) return quiz(wrap, block, dry);
    if (hasBehavior(block, 'numeric')) return numeric(wrap, block, dry);
    if (hasBehavior(block, 'decision')) return decision(wrap, block, dry);
    if (hasBehavior(block, 'results')) return results(wrap, block, dry);
    return undefined;
  }

  return {
    primitives,
    noteShown,
    // Binds the behaviour of an activity or results block to its markup (nothing for other blocks).
    bind(wrap: HTMLElement, block: BlockData): void { run(wrap, block, false); },
    // Dry run: the possible outcomes of an activity or results block (none for other blocks).
    outcomes(wrap: HTMLElement, block: BlockData): Outcome[] { return run(wrap, block, true) || []; },
    // Results blocks of the page show the current score and status.
    refreshResults(): void { for (const node of document.querySelectorAll('[data-behavior="results"]')) refreshers.get(node)?.(); }
  };
}
