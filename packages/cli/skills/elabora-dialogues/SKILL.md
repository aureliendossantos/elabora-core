---
name: elabora-dialogues
description: Write, check and export a branching dialogue in an Elabora course (a dialogue block): a mini-scenario, a conversation with consequences and retries, branches with endings, an interview hub, characters with expressions and gestures (and drawing a new SVG character), the lines' voices, cues on words, links with the screen's events; import Rise's scenario.
---

# Dialogues: a conversation in one block

Read `elabora docs dialogues` (MCP `elabora_docs { page: "dialogues" }`) for the whole guide; this is the checklist. Props: `elabora_get_schema("dialogue")`.

## Before writing
- One dialogue block per conversation. Its characters are `course.json` `speakers` (`id`, `name`, `color` a theme token, `look`); the learner plays `learner` (a speaker) or « Vous ».
- Choose the mode: `practice` (default: retry, then back to any choice after the end, not scored), `assessment` (no going back, scored by quality, feedback in the debrief), `exploration`.
- Keep the debrief (`debrief: true`, the default) in practice: at the end it is where the learner acts, « Changer ce choix » under each decision, « Recommencer » at its foot. « Recommencer » says the whole dialogue again from its first line: keep the opening short.

## Write
- **The best path first**, then the other options. Short lines: one or two sentences. A line without speaker is a narration (« Plus tard, au bureau de Marc »).
- **A decision: about three options**, `quality` good, ok and bad, plausible, of similar length; never a speaker on an option (the learner says it). `label` when the button needs fewer words than the bubble.
- **The consequence first** (`reply`: the character reacts), **the note after** (`feedback`: the trainer's voice, never a character's line).
- **Join back.** An option without `next` takes its node's way out (`next`, `end`, else the next node). Branch with `next` only where the story really differs, and bring branches back to a shared node.
- Retry a mistake: `retry: true` (the same options come back, this one greyed; the first choice still counts). A question hub: `once: true` options and one permanent way on. A final choice: `final: true` on the node.
- Endings: `endings` with `if` on the score (`{ "score": { "op": "gte", "value": 80 } }`), the last one without `if`; nodes end with `end: true`.
- Characters' faces: `expression` on a line (one their look declares), gestures and actions on words with `cues` (`{ "at": { "word": "Bonjour" }, "gesture": "saluer" }`). Stage directions in brackets stay for the voice.
- Line ids are unique in the screen (narration, layers and dialogues together); option ids `a`, `b`, `c` in their node; never reuse an id learners played.

## Voices
- A line with a `speaker` is a voice line like the narration's: `elabora voice generate <screen>` says the dialogue's lines too (ask the author before a paid voice: `elabora voice estimate`), `elabora narration import` takes recordings named after the lines. With `learnerVoice: true` the learner's answers are said by the `learner` speaker's voice, as the lines `<node>.<option>`.
- A line without speaker has no voice (a narration shown, not said), unless a `narrator: true` speaker says it.
- A line without audio (a narration not said, or a dialogue without voices) is shown whole, without ink, and waits for the learner's « Suite »; voiced lines follow one another by themselves. Nothing to set: a dialogue without voices reads at the learner's pace.
- Stage directions in brackets stay in the text for an expressive voice; the bubble and the captions never show them.

## A new character (SVG)
- Read `elabora docs dialogues`, section Characters: the convention, the style and the recipe. Start from a sample character, never from nothing: keep its tree (`<g data-part="character">`, `breath`, `body`, `head`, one `<g data-expression>` per expression, `eyes-closed`, the four mouths, gestures as parts with `data-gesture`).
- The root declares `data-character`, `data-expressions` (the base five: `neutre souriant inquiet soulage agace`), `data-default-expression`, `data-gestures` (`saluer:1.2`, the animation's seconds) and `data-portrait` (the face's box).
- Change the palette's defaults (custom properties: `fill: var(--character-skin, #E8B48F)`), the hair (one path) and the top of the bust; change the brows first for each expression, then the eyes, then one detail; give each expression its closed mouth.
- CSS moves only: `transform` and `opacity`, origins in px of the viewBox, gestures tied to the state (`[data-part="character"][data-gesture="saluer"] [data-part="arm-wave"]`), `both`, ending where they started.
- Never an `id` (no gradient, clip path, mask, filter), never text, under 40 KB.
- Declare it: `course.json` `speakers[].look = { "svg": "personnages/<name>.svg" }` and a `color` token.
- Check: `elabora validate .` (no `W_CHARACTER_CONVENTION`, `W_CHARACTER_CONTENT`, `W_SVG_INLINE_SANITIZED`, `W_DIALOGUE_LOOK`), then `elabora look` on the dialogue's screen: every expression reads in the round avatar.

## Edit
- The block is written with `elabora_add_block` / `elabora_update_block`; one node whole with `elabora_set_dialogue_node` (add after a node, or replace in place), which is lighter for long dialogues. Direct edits of the screen file are fine too.
- The dialogue never writes course variables nor navigates: put those on an event of the screen, `dialogue.ended` (filter `ending`), and read the scored run elsewhere with `{ "dialogue": "<block>", "ending": "…" }`.

## Check
- `elabora dialogue show . <block>` (MCP `elabora_dialogue_show`): reread it as a script.
- `elabora dialogue paths . <block>`: every ending reached, no node unreached, the best score at 100 %.
- `elabora dialogue play . <block> --choose a,a,a`: the best path; then each mistake.
- `elabora look . --screen <screen> --block <block> --act choose:a --act choose:c` (MCP `elabora_look` with `block` and `act`): the thread at rest after those choices, its end in the window (the notes, the next options, the debrief at the end); `--size 375x812` for a phone. Look at the best path's end and at a mistake.
- `elabora validate .`: the `E_DIALOGUE_*`, `W_DIALOGUE_*` and `W_CHARACTER_*` codes say what to fix; `W_NARRATION_AUDIO_MISSING` once per dialogue until its lines have their voices.

## For the client
- `elabora dialogue export . <block> --to pdf` (or html): the map, then the script, in the course's language. The client also plays it in the Revue.

## From other tools
- Rise scenarios import as dialogues (`elabora import`): reread the result, give options a quality, and replace the generic narration where Rise had a scene description.
- Ink, Yarn, Twee or Chat Mapper scripts: convert by hand to nodes, options and `next`; a variable becomes `vars` with `set`/`add`.
