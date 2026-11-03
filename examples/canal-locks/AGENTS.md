<!-- elabora:rules revision=18 sha256=92de2542fb3711a5 · Elabora keeps the rules down to « elabora:rules end » up to date while nobody edits them; write your own notes after it. -->
# AGENTS.md — Elabora course project

This folder is an Elabora course (`elabora/0.1`). **Read this file and “Notes for this course” below before editing.** Load detailed guidance only for the task at hand.

## Always applicable
- **Plan is the contract.** Read `plan.json` and relevant author sources before changing course content. Draft or update the working plan through `elabora_write_plan` / `elabora plan write`; record assumptions in `decided` and at most one consequential `question`. After a validation keep writing the plan, then tell the author what changed (`elabora plan diff` / `elabora_plan_diff`). A change of substance (what is taught, a rule, an answer) is the author's call: ask before writing it. Never modify a `verbatim` text, create/validate plan versions or edit `plan-versions/`: those decisions belong to the author.
- **No eyebrows, no repeats.** No line over a title: the player or the style's numbering says where learners are. Skip descriptions the title and content already give: learners read everything, and may hear it too.
- **Traceability.** Every screen has `covers` and every plan item is covered. Reference validated material with `textRef` / `questionRef` instead of duplicating it; change the plan to change approved wording.
- **Editable before custom.** Prefer native blocks, then reusable components (including activity forks); use free-object code only when needed. Keep learner-facing words in editable blocks and props, not CSS, templates or generated figures. Preserve component fallbacks and migrations.
- **Stable learner state.** Never reuse ids or edit `elabora.lock.json`. Rename via `elabora_rename` / `elabora rename`, so references and progress follow.
- **Sources and media.** Treat `sources/` as private, read-only input that may hold personal data: quote only what the module needs. Use `elabora_source_read` / `elabora sources read`. Never reference sources directly from screens. Bring learner-facing assets in with `elabora_media_import` / `elabora media import` (not direct copies to `assets/`); include accessibility text/captions and mark AI-generated media `generated: true`.
- **Adjustments: only the change asked.** Suggest extras, never build them; one question for an open visual choice. Read only what it touches (`elabora object map`, `elabora docs --search`).
- **Check what the change can affect.** Read tool diagnostics and run `elabora validate .` after edits; fix errors first. Then check in proportion to what the change does, not to its size:
  - *Presentation only* (a duration, an easing, a colour, a decoration that moves nothing): the plan stays as it is. Read only the component or stylesheet concerned and the guidance for it, validate once, then `elabora look` the affected screen in the state that shows the issue (`--scroll`, `--step`, `--state answered`, `--block`). No fit, no object gates.
  - *Layout* (spacing, sizes, type that reflows, a shared stylesheet or component): add `elabora fit --screen <ids>` for the screens it reaches.
  - *Content, structure or behaviour*: the whole route, from the plan to `elabora fit` and the gates of the objects changed (`elabora object test`).
  
  Broaden only when a check reveals a problem. See screens and objects with `elabora look`, `elabora preview` or `elabora screenshot`, never a Playwright script of your own, and check fit before delivery. Never ignore a diagnostic on your own: explain keyed warnings and request author approval before `elabora ignore`.
- **Dialogues.** Short lines; the consequence first, the trainer's feedback after, never in a character's mouth; about three options (good, ok, bad), plausible and of similar length; write the best path first; check with `elabora dialogue paths` and `elabora dialogue play` before saying a dialogue is done.
- **Human and paid-service boundaries.** The author controls plan approvals, translated-plan approval, publishing, sharing and review resolution. For paid narration/transcription, load `elabora-narration` and follow its quota-estimation and approval threshold; do not assume every paid call requires approval.

## Load only the guidance your task needs

Skills are **not loaded** automatically. With MCP, read `elabora://skills/<name>` as a resource, or `elabora_docs { page: "skills/<name>" }` if your host does not show resources; without MCP, `elabora tools skills` lists them, `elabora tools skills <name>` reads one, `elabora tools skills <name> <reference>` its detailed reference.

| Task | Guidance to load |
| --- | --- |
| Planning, screens, events, review or delivery | `elabora-course-authoring` (then only the relevant reference); starter blocks: `elabora-blocks` |
| Visual styling, layouts, fonts, generated figures | `elabora-visual-design` |
| The learner's player: its bars, resources, glossary, credits | `elabora_player` / `elabora player` (then `elabora-visual-design` to fit it to the theme) |
| Reusable blocks, activity forks, migrations | `elabora-components` |
| Custom simulations/interactions | `elabora-free-objects` (and `threejs-r186` for three.js) |
| Objectives, questions, feedback, cognitive load | `elabora-pedagogy` |
| Branching dialogues (a conversation, its choices and characters) | `elabora-dialogues` |
| Voice, recorded audio, cues; sounds/music | `elabora-narration`; `elabora-sounds` |
| Translating/localising a course | `elabora-translation` |
| Importing Storyline or Rise | `elabora-importing` |

## Tools and course layout
Begin with `elabora project .` / `elabora_overview`, the plan, relevant sources and course notes; use connected MCP tools. Without MCP, `elabora tools guide` gives the workflow and `elabora tools list <tool> --json` its schema; `elabora tools call <tool> . --args '<json>'` (or `--from <file>`) invokes the same operation and prints its JSON. Use ordinary file tools for CSS, templates, generators and screen JSON; use Elabora operations for plan edits, renames, media and translations. `elabora docs` / `elabora_docs` offers format reference. Do not modify the author's agent configuration or assume that running `elabora mcp .` connects a host.

Core files: `course.json` (settings), `plan.json` (contract), `screens/` (content), `components/` (reusable blocks), `objects/` (code), `theme/`, `generators/`, `assets/`, `sources/`, `translations/`, `elabora.lock.json` (state, do not edit), `dist/` (outputs).

If `elabora` is not on PATH (on macOS, Elabora installs it from Réglages › Outils pour les IA; on Windows, the installer does), use the app's CLI: `/Applications/Elabora.app/Contents/Resources/bin/elabora` (macOS) or `%LOCALAPPDATA%\Programs\elabora\resources\bin\elabora.cmd` (Windows).
<!-- elabora:rules end -->

## Notes for this course
<!-- What agents should know about this course: its audience, its voice, decisions taken. Elabora never changes this part. -->

What the author asked for (24 Oct 2026): a short demonstration module for curious minds (teenagers and adults, no prior knowledge, 3 to 5 minutes), in four slides: a hook, a 3D lock the learner operates, an animated cross-section explaining it, and a case with a lock keeper. One reusable free object carries the 3D scene; its author-facing settings are the visual style, the camera, the level of information, the motion intensity and the annotations. 3D: yes. Voice: no (discreet synthesised sound effects that can be muted). Tone: told as a story. Accessibility: level AA. Left to the AI: the quizzes, a case to solve and the charter. The look is a gentle, warm, slightly poetic one (river landscapes, paper texture, watercolour washes), the 3D scene blending into the slide's background.

Agent notes (first draft, 24 Oct 2026):
- One free object, `objects/canal-lock`, serves the four screens with different settings (explore / explain / display mode, style, camera, level of information). The lock's rules are in `sim.js` and depend on neither style nor motion; the geometry is in `geometry.js`, the materials and palettes in `materials.js` (no colour written in code: material props or tokens), the sound in `audio.js` (synthesised, after a first click in the frame).
- Screen events and the dialogue's choices drive the object through the `command` prop (set-object-props): each value set runs the operation once, with the same rules as for the learner.
- Shared layout: the `lock-stage` screen component (top / left / hero), the object at `aspectRatio: fill` with a transparent background laid on the paper; the title and the text declare their zone through the safe area.
- Charter: cream paper, sage and moss greens, canal blues, ochre; Fraunces (headings) and Source Sans 3 (text); the background's washes and grain are generated by `generators/paper.mjs`.

Agent notes (adjustments, 27 Oct 2026):
- Navigation: the player's Next stays disabled; each screen has its own button (style `next`, with an arrow), revealed at step 2 by the object's `completed` event (screens 1.2 and 2.1).
- Object: no status card and no written explanation of mistakes on screen (the author refused them: the scene is enough; screen readers still hear them); the hint opens above the toolbar. Labels without icons: the name, then the state in a coloured sans-serif (closed: terracotta, open: blue). Boat: « Boat », Back up then Sail ahead; only a possible move is green. In the « top » layout, the text fits in the safe area's 8rem and takes clicks only on its controls. In explain mode, a single bubble (title, caption, Replay / Previous / Next) replaces the steps card; `completed` is sent at the end of the last step. The exploration's controls sit on rails above and below the diorama (`RAILS` in `object.js`) and are placed with the CSS `translate` property (never `transform`, reserved for their animations).
- « guided » level: zone names and flow arrows only; the target level line, Δh and the flows' labels are kept for the « technical » level.
- Watercolour entrance: the scene is rendered into a texture during the entrance, and the wash lands only on the diorama's silhouette. In test mode (`testMode`) the entrance is replaced by a fade: the capture tools do not show it.
