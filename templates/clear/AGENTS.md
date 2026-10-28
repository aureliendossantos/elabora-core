<!-- elabora:rules revision=13 sha256=00f0c0c48b13d680 · Elabora keeps the rules down to « elabora:rules end » up to date while nobody edits them; write your own notes after it. -->
# AGENTS.md — Elabora course project

This folder is an Elabora course (`elabora/0.1`). **Read this file and “Notes for this course” below before editing.** Load detailed guidance only for the task at hand.

## Always applicable
- **Plan is the contract.** Read `plan.json` and relevant author sources before changing course content. Draft or update the working plan through `elabora_write_plan` / `elabora plan write`; record assumptions in `decided` and at most one consequential `question`. After a validation keep writing the plan, then tell the author what changed (`elabora plan diff` / `elabora_plan_diff`). A change of substance (what is taught, a rule, an answer) is the author's call: ask before writing it. Never modify a `verbatim` text, create/validate plan versions or edit `plan-versions/`: those decisions belong to the author.
- **No words that repeat.** Avoid eyebrow texts and descriptions unless their information cannot be conveyed from the title and main content: learners read all of it, and on a narrated screen they hear the voice too.
- **Traceability.** Every screen has `covers` and every plan item is covered. Reference validated material with `textRef` / `questionRef` instead of duplicating it; change the plan to change approved wording.
- **Editable before custom.** Prefer native blocks, then reusable components (including activity forks); use free-object code only when needed. Keep learner-facing words in editable blocks and props, not CSS, templates or generated figures. Preserve component fallbacks and migrations.
- **Stable learner state.** Never reuse ids or edit `elabora.lock.json`. Rename via `elabora_rename` / `elabora rename`, so references and progress follow.
- **Sources and media.** Treat `sources/` as private, read-only input that may hold personal data: quote only what the module needs. Use `elabora_source_read` / `elabora sources read`. Never reference sources directly from screens. Bring learner-facing assets in with `elabora_media_import` / `elabora media import` (not direct copies to `assets/`); include accessibility text/captions and mark AI-generated media `generated: true`.
- **Check what the change can affect.** Read tool diagnostics and run `elabora validate .` after edits; fix errors first. Then check in proportion to what the change does, not to its size:
  - *Presentation only* (a duration, an easing, a colour, a decoration that moves nothing): the plan stays as it is. Read only the component or stylesheet concerned and the guidance for it, validate once, then `elabora look` the affected screen in the state that shows the issue (`--scroll`, `--step`, `--state answered`, `--block`). No fit, no object gates.
  - *Layout* (spacing, sizes, type that reflows, a shared stylesheet or component): add `elabora fit --screen <ids>` for the screens it reaches.
  - *Content, structure or behaviour*: the whole route, from the plan to `elabora fit` and the gates of the objects changed (`elabora object test`).
  
  Broaden only when a check reveals a problem. See screens and objects with `elabora look`, `elabora preview` or `elabora screenshot`, never a Playwright script of your own, and check fit before delivery. Never ignore a diagnostic on your own: explain keyed warnings and request author approval before `elabora ignore`.
- **Dialogues.** Short lines; the consequence first, the trainer's feedback after, never in a character's mouth; about three options (good, ok, bad), plausible and of similar length; write the best path first; check with `elabora dialogue paths` and `elabora dialogue play` before saying a dialogue is done.
- **Human and paid-service boundaries.** The author controls plan approvals, translated-plan approval, publishing, sharing and review resolution. For paid narration/transcription, load `elabora-narration` and follow its quota-estimation and approval threshold; do not assume every paid call requires approval.

## Load only the guidance your task needs

Skills are **not automatically loaded** just because they are listed here. With MCP, read `elabora://skills/<name>` as a resource, or `elabora_docs { page: "skills/<name>" }` if your host does not show resources; without MCP, run `elabora tools skills` to list available skills, `elabora tools skills <name>` to read one and `elabora tools skills <name> <reference>` for its optional detailed reference. Do not read all skills for a small change.

| Task | Guidance to load |
| --- | --- |
| Planning, screens, events, review or delivery | `elabora-course-authoring` (then only the relevant reference); starter blocks: `elabora-blocks` |
| Visual styling, layouts, fonts, generated figures | `elabora-visual-design` |
| The learner's player: its bars, resources, glossary, credits | `elabora_player` / `elabora player` (then `elabora-visual-design` to fit it to the theme) |
| Reusable blocks, activity forks, migrations | `elabora-components` |
| Custom simulations/interactions | `elabora-free-objects` (and `threejs-r186` for three.js) |
| Objectives, questions, feedback, cognitive load | `elabora-pedagogy` |
| Branching dialogues (a conversation, its choices and characters) | `elabora-dialogues` |
| Voice, recorded audio, timing and cues | `elabora-narration` |
| Translating/localising a course | `elabora-translation` |
| Importing Storyline or Rise | `elabora-importing` |

## Tools and course layout
Begin with `elabora project .` / `elabora_overview`; consult the plan, relevant sources and course notes. Use connected MCP tools when available. Without MCP, `elabora tools guide` gives the workflow and `elabora tools list <tool> --json` its schema; `elabora tools call <tool> . --args '<json>'` (or `--from <file>`) invokes the same operation and prints its JSON. Use ordinary file tools for CSS, templates, generators and screen JSON; use Elabora operations for plan edits, renames, media and translations. `elabora docs` / `elabora_docs` offers format reference. Do not modify the author's agent configuration or assume that running `elabora mcp .` connects a host.

Core files: `course.json` (settings), `plan.json` (contract), `screens/` (content), `components/` (reusable blocks), `objects/` (code), `theme/`, `generators/`, `assets/`, `sources/`, `translations/`, `elabora.lock.json` (state, do not edit), `dist/` (outputs).

If `elabora` is not on PATH (on macOS, Elabora installs it from Réglages › Outils pour les IA; on Windows, the installer does), use the app's CLI: `/Applications/Elabora.app/Contents/Resources/bin/elabora` (macOS) or `%LOCALAPPDATA%\Programs\elabora\resources\bin\elabora.cmd` (Windows).
<!-- elabora:rules end -->

## Notes for this course
<!-- What agents should know about this course: its audience, its voice, decisions taken. Elabora never changes this part. -->

Template 'Clear': strict grid, one accent, a travelling accent rule. Abstract placeholder text in English.
