---
name: elabora-pedagogy
description: Evidence-based defaults for corporate e-learning written by an agent - alignment to the validated plan, practice, feedback, multimedia, accessibility and the human review the AI cannot replace. Use when designing screens, writing questions, feedback or scenarios in an Elabora course.
---

# Pedagogical defaults (subordinate to the validated plan)

The plan wins. When it contains an unsupported assumption (learning styles, satisfaction as the only measure), tell the author with its source and propose the correction; write it only with their agreement, never silently: the client sees it as a change since the version they validated.

## Alignment
- Each screen serves a plan item; each objective gets practice or assessment at the same Bloom level (A1–A2).
- Objectives are observable: action verb, condition, criterion (A3).

## Practice and decisions
- No more than four exposition screens in a row without retrieval, decision or production (B1).
- Revealing content (accordion, tabs) is not practice (B2).
- Behavioural objectives get at least one realistic decision with consequences shown, not told (B3, D3): `decision` + layers or branches.
- Novices: a worked example before independent practice (B4).

## Questions (C1) and feedback (D1)
- About three plausible options, homogeneous in length and form; no "all/none of the above"; negations in **bold** or avoided.
- Contextualised questions at the objective's level, not definitions for an application objective.
- Feedback for every option: why it is right or wrong and what to remember. Task-focused, no praise of the person (D2).

## Multimedia and load
- No decorative media (E1); words near what they describe (E2); short learner-controlled segments, about 250 words per screen at most (E3); no on-screen text duplicating narration (E4); "you" style (E6).

## Narrated screens (Mayer's principles)
- **Segmenting**: cut the voice into steps the learner advances (`step` on lines; `advance: "learner"`, the default), each under about 90 s (`W_SEGMENT_TOO_LONG`); a step ends where an idea ends. `auto` chains the steps of a screen and then waits for Next; `next-screen` also goes to the next screen by itself: only for a screen that must run on (an introduction, credits) the client asked for (`W_AUTO_ADVANCE`, WCAG 2.2.1).
- **Temporal contiguity**: a block arrives with the step whose line names it (put it in that step), not before nor long after; within a step, anchor it to the word that names it (`timing.in` at `{ line, word }`), so the eye goes to it as the ear hears it. Signal with one effect per block, short and quiet (a fade, a rise), not a show: several blocks arriving together compete for attention. A question waits at the end of the step that prepares it (`steps: { "n": { "opens": "answered" } }` for what follows), and stays there until the learner answered (`E_ACTIVITY_LEAVES_UNANSWERED`).
- **Coherence**: take a block away (`timing.out`) when the voice moves on to something it no longer illustrates, rather than piling everything up; several contents in the same place follow one another in a `stack`. Text that appears must stay long enough to be read (`W_TEXT_TOO_FAST`).
- **Redundancy (E4)**: the voice explains, the screen shows (a figure, a diagram, two or three keywords); never the same sentences on screen (`W_NARRATION_DUPLICATED`). The captions and the transcript give the words to those who need them: no need to repeat them in blocks.
- **Modality and voice**: a conversational, second-person script, one idea per line; name speakers in `course.json` `speakers` (dialogues: two or three voices at most). Generated voices are marked for the AI Act by their sidecar (`generated: true`).
- Cue events and timed blocks on lines and words, never on seconds: they survive a new voice and a translation. Counting on a cue counts replays (`W_TIMED_INCREMENT`).

## Glossary: « Relever les termes »
When the author asks for a glossary, or a module has words of the trade its audience may not know:
1. Read the screens (`elabora_get_course`, the screens' texts) and propose the terms a learner of the plan's audience would look up: the trade's words, acronyms, a word used in a narrow sense. Not the words everyone knows, not one-off names. For each: `term` as learners read it, a `definition` of one or two sentences in the course's words (what it is and what it does here; never a circular definition), and `variants` (plural, the acronym and its expansion, the English word the trade uses). Say where you found each term in `source`: `{ kind: "source", id: "<name in sources/>", at: "p. 4" }` for a source of the author's (D49; `at` as they would find it: a page, a slide, a time), `{ kind: "screen", id: "<screen>" }` for a screen; the editor shows it beside the entry, learners never see it.
2. Show the list to the author and keep what they keep: a glossary is the author's text, read in the panel and in every tooltip.
3. Write it with `elabora_player` `glossary` (the whole list, ids in kebab-case). With the glossary item's option `linkTerms` on (the default), the terms added are linked at once, the first time each is in each screen; `linkTerms: true` links all of them again on demand, `linkTerms: ["<id>"]` some. The result lists the links placed: read them, and remove a link where the word is not used in the glossary's sense (the operation will not put it back unless asked). Its `translations` say which translated texts took the same link and which must be translated again (the term's translation was not in them): tell the author, since a package of every language leaves out a translation with texts out of date (`W_PACKAGE_LANGUAGE_LEFT_OUT`). Removing an entry (the glossary written again without it) removes its links in the same change, their words kept, in the translations too: the result's `unlinked` lists them.
4. `translate: false` on an entry keeps its term and variants as they are in every language (a product name, an acronym the trade keeps in English); its definition is still translated.

## Accessibility (F)
- Alt text describes the information, or `decorative: true`; captions (when it has sound: a WebVTT or SubRip file given to the block with `elabora_set_captions`, `elabora media captions . <block> <file>`) and a transcript for every video the learner plays, a short silent animation as a loop (`loop: true`) with alt, transcript for audio; `decorative: true` only for a video or a sound that carries no information; text alternative for every free object.
- WCAG 2.2 AA is checked by axe-core in `elabora test`; RGAA criteria that cannot be automated need a human audit.

## What stays human
Subject-matter review of every item and factual claim (C3, G1–G2), pedagogical review of free objects (gate 7–8), the client's validation of the plan's next version. Prepare these reviews; do not perform them.
