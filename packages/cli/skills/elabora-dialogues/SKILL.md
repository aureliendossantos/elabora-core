---
name: elabora-dialogues
description: Write, check and export a branching dialogue in an Elabora course (a dialogue block): a mini-scenario, a conversation with consequences and retries, branches with endings, an interview hub, characters with expressions and gestures, cues on words, links with the screen's events; import Rise's scenario.
---

# Dialogues: a conversation in one block

Read `elabora docs dialogues` (MCP `elabora_docs { page: "dialogues" }`) for the whole guide; this is the checklist. Props: `elabora_get_schema("dialogue")`.

## Before writing
- One dialogue block per conversation. Its characters are `course.json` `speakers` (`id`, `name`, `color` a theme token, `look`); the learner plays `learner` (a speaker) or « Vous ».
- Choose the mode: `practice` (default: retry, then back to any choice after the end, not scored), `assessment` (no going back, scored by quality, feedback in the debrief), `exploration`.

## Write
- **The best path first**, then the other options. Short lines: one or two sentences. A line without speaker is a narration (« Plus tard, au bureau de Marc »).
- **A decision: about three options**, `quality` good, ok and bad, plausible, of similar length; never a speaker on an option (the learner says it). `label` when the button needs fewer words than the bubble.
- **The consequence first** (`reply`: the character reacts), **the note after** (`feedback`: the trainer's voice, never a character's line).
- **Join back.** An option without `next` takes its node's way out (`next`, `end`, else the next node). Branch with `next` only where the story really differs, and bring branches back to a shared node.
- Retry a mistake: `retry: true` (the same options come back, this one greyed; the first choice still counts). A question hub: `once: true` options and one permanent way on. A final choice: `final: true` on the node.
- Endings: `endings` with `if` on the score (`{ "score": { "op": "gte", "value": 80 } }`), the last one without `if`; nodes end with `end: true`.
- Characters' faces: `expression` on a line (one their look declares), gestures and actions on words with `cues` (`{ "at": { "word": "Bonjour" }, "gesture": "saluer" }`). Stage directions in brackets stay for the voice.
- Line ids are unique in the screen (narration, layers and dialogues together); option ids `a`, `b`, `c` in their node; never reuse an id learners played.

## Edit
- The block is written with `elabora_add_block` / `elabora_update_block`; one node whole with `elabora_set_dialogue_node` (add after a node, or replace in place), which is lighter for long dialogues. Direct edits of the screen file are fine too.
- The dialogue never writes course variables nor navigates: put those on an event of the screen, `dialogue.ended` (filter `ending`), and read the scored run elsewhere with `{ "dialogue": "<block>", "ending": "…" }`.

## Check
- `elabora dialogue show . <block>` (MCP `elabora_dialogue_show`): reread it as a script.
- `elabora dialogue paths . <block>`: every ending reached, no node unreached, the best score at 100 %.
- `elabora dialogue play . <block> --choose a,a,a`: the best path; then each mistake.
- `elabora validate .`: the `E_DIALOGUE_*` and `W_DIALOGUE_*` codes say what to fix.

## For the client
- `elabora dialogue export . <block> --to pdf` (or html): the map, then the script, in the course's language. The client also plays it in the Revue.

## From other tools
- Rise scenarios import as dialogues (`elabora import`): reread the result, give options a quality, and replace the generic narration where Rise had a scene description.
- Ink, Yarn, Twee or Chat Mapper scripts: convert by hand to nodes, options and `next`; a variable becomes `vars` with `set`/`add`.
