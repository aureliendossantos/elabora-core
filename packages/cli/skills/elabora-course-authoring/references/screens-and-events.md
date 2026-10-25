# Screens, blocks, media and events (on demand)

**Screens.** For each plan item, in order, create the screen(s) that implement it (`elabora_create_screen` with `covers: ["ITEM-n"]`).

**Blocks.** Fill screens with blocks (`elabora_list_components` lists built-in blocks and the course's components; `elabora_get_schema <type>` before writing a block):
   - validated texts of the item → `text` / `callout` / `heading` with `textRef` (to reword one, for a clearer or shorter phrase, write it in the plan with `elabora_write_plan`: every block that shows it follows; never a `verbatim` text, kept « à l'identique »: ask the author; a change of substance, such as a question's answer, is the author's call);
   - validated questions → `quiz` with `questionRef`;
   - practice and scenarios → `quiz` (inline), `decision` with consequences (feedback, layers, `go-to`);
   - calculations → `numeric` (answer, tolerance, unit, feedback, one misconception per typical error), validated numeric questions with `questionRef`;
   - recalling terms in context → `fill-in` (`[[answer|other accepted]]` blanks in its Markdown, one to three per sentence; `typed`, `menus` or `bank` with distractors); telling cases apart, matching or ordering → `sort` (`pairs`, `categories`, `order`; four to eight items); connecting the content to the learner's own work → `reflection` (`text` with an expert's `model`, or a `scale`); both scored activities need `feedback.incorrect`;
   - something to recognise by sight → `quiz` with `presentation: "images"` (each option's `image` and `alt`) or `"image"` (zones placed at `x`, `y` on one picture);
   - equations → `$…$` / `$$…$$` in any Markdown, or a `math` block (LaTeX, rendered as MathML);
   - images with alt text describing the information, `generated: true` if AI-made; media files (an image you generated or downloaded, a recording, a video) are imported first with `elabora_media_import` (`elabora media import . <file>`), which converts them to web masters, removes their metadata and returns the path to put in `asset` (`images/diagram.webp`); a video with sound then gets its captions from a WebVTT or SubRip file with `elabora_set_captions` (`elabora media captions . <block> <file>`; `E_VIDEO_CAPTIONS_MISSING` until it has them). Never write raw files into `assets/`; a media job still running shows as `I_MEDIA_PROCESSING`, and builds wait for it;
   - course components where they fit (a card, a layout, a restyled quiz): fill their props and put blocks in their slots (`blocks` with `slot`); copy an instance with `elabora_duplicate_block`;

**Look and layout.** Screen `layout` + block `slot`, named `style`s, components (skill `elabora-components`), `presentation`: scroll pages (the default, Rise-like lessons of any length, with something to do every few paragraphs) or slides that fit 1600×900 (`elabora_check_fit` checks both), `step` to pace a screen (Continue reveals the next step, in the page in scroll presentation; a click event with `reveal-step`; or `steps.<n>.opens: "answered"` to open the rest once the activity above is answered); figures from `generators/` with legends in blocks (skill `elabora-visual-design`).

**Events.** Interactivity with events, not code: `{ on, if, do, else }` (`elabora_get_schema event`). An event with `do: []` is one the author started in the app (`W_EVENT_NO_ACTION`): finish it as they meant it, or ask. Layers for consequences and reminders. Exploration in any order (click each tab or marker, then Next): one component holding the markers with named buttons (`data-t-click="{{id}}"`), a click event per `name`, and `{ "visited": "<block>" }` conditions with `complete-screen` (docs/design.md, "Explore in any order").

**Diagnostics and looks.** After every edit, read the returned diagnostics and fix errors first. A warning with a `key` (a heuristic over your words: a negation in a quoted maxim, a dense screen that is a primary text) may not apply: tell the author why, and only if they agree, `elabora_ignore_finding { code, key }` (`elabora ignore . <code> <key>`); it comes back when the text changes. Never ignore one yourself, never write a plan waiver for it. Then `elabora_validate`, and look at changed screens with `elabora_look` (`elabora look . --screen <id>`: well under a second once warm, free objects included; `elabora look . --url` gives a page that follows your edits, for a browser pane). Before handing over: `elabora_check_fit` and `elabora_preview_screenshot` (the built package) on every designed screen.

## Rules the validator enforces
- A screen without `covers`, or a plan item without a screen: error (A1).
- Locked texts and validated questions must be referenced, not copied (A5).
- Every quiz option has feedback that explains why (D1); 3 plausible options; no "all of the above". Numeric questions need correct and incorrect feedback; misconceptions must not fall within the tolerance.
- No words inside figures, CSS or component templates; LaTeX must parse.
- Screens with activities use `completeWhen: "interactions-done"`.
- Free objects only when no block can do the job: see skill `elabora-free-objects`.
