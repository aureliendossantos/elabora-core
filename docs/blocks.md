# Built-in block catalogue (format 0.1)

Generated from `packages/format/schemas/0.1/blocks/` and the built-in components (`packages/core/src/components/builtin/`). Agents: call `elabora_get_schema <type>` for the full schema; course components are listed by `elabora_list_components` (docs/components.md).

## `heading` (content)

A section heading inside a screen. The screen title is already rendered as the level-1 heading.

> Use headings to signal structure (guardrail E5). Use textRef when the plan has a locked text for it.

Template `packages/core/src/components/builtin/heading.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `text` | string |  | Heading text. Use text or textRef, not both. |
| `textRef` | planId |  | Id of a validated text of the plan: the block shows the plan's wording, and rewording it writes the plan. |
| `level` | 2 \| 3 \| 4 |  | Heading level. Do not skip levels. Default 2. |

## `text` (content)

Rich text in the Elabora Markdown subset.

> Short paragraphs, conversational 'you' (E6), no decorative anecdotes (E1). Keep a screen under about 250 words (E3). When the plan has a locked text, use textRef instead of copying it.

Template `packages/core/src/components/builtin/text.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `markdown` | markdown |  | Text content. Use markdown or textRef, not both. |
| `textRef` | planId |  | Id of a validated text of the plan: the block shows the plan's wording, and rewording it writes the plan. |

## `image` (content)

An image from the assets folder.

> Only images with an instructional function (E1). Write alt as the information the image carries, not its file name. Mark purely decorative images decorative: true. Generated images must be marked generated: true (AI Act art. 50).

Template `packages/core/src/components/builtin/image.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `asset` | assetPath | yes |  |
| `alt` | string |  | Text alternative. Required unless decorative is true. |
| `decorative` | boolean |  | True only if the image carries no information. Default false. |
| `caption` | string |  |  |
| `generated` | boolean |  | True if produced by an AI model; the player shows a mark and the build report lists it. Default false. |
| `inline` | boolean |  | SVG only: the drawing goes into the page instead of an &lt;img&gt;, so that the draw effect of a timing traces its strokes and the theme's CSS and currentColor reach its shapes. Sanitized when it is built: no script, no event handler, no link or reference out of the drawing; its ids prefixed with the block's, its own &lt;style&gt; scoped to it. Named by alt (role img), or hidden when decorative. Keep it for figures that need it: an inline drawing is part of the page's weight. Default false. |

## `video` (content)

A video file: played by the learner with its controls (captions and a transcript), or as a muted loop like an animated image (loop: true, with alt), or decorative.

> Short segments controlled by the learner (E3), never autoplayed with sound. A video with sound needs captions (WebVTT) and a transcript (F3); a video without sound needs a transcript or alt. A short silent animation (a process, a gesture) plays as a loop: loop: true with alt saying what it shows. A video that carries no information (an ambiance, a background) is decorative: true. The validator reports what is missing.

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `asset` | assetPath | yes | MP4 (H.264/AAC) or WebM file. |
| `title` | string | yes | Shown under a video played with its controls, which it names for assistive technologies; names a loop in the editor. |
| `captions` | assetPath |  | WebVTT captions file (.vtt). Required when the video is played with its sound. |
| `transcript` | markdown |  | What is said and shown, for those who cannot watch or hear it. Required for a video played with its controls (a silent one may give alt instead). |
| `loop` | boolean |  | Plays muted, in a loop, like an animated image: it starts by itself unless the learner prefers reduced motion, and a button pauses it. Its sound is never heard: no captions. Default false. |
| `alt` | string |  | Text alternative of a loop or of a video without sound: what it shows. Required for a loop unless decorative. |
| `decorative` | boolean |  | True only if the video carries no information: it plays as a loop, ignored by assistive technologies, with nothing to caption, transcribe or describe. Default false. |
| `poster` | assetPath |  |  |
| `generated` | boolean |  |  Default false. |

## `audio` (content)

An audio file (narration, interview, ambiance) the learner plays, with its transcript unless it is decorative.

> Do not duplicate the narration as on-screen text (E4). A transcript is mandatory for a sound that carries information (F3); an ambiance or music that carries none is decorative: true. No autoplay.

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `asset` | assetPath | yes | MP3, M4A or OGG file. |
| `title` | string | yes |  |
| `transcript` | markdown |  | What is said, for those who cannot hear it. Required unless decorative. |
| `decorative` | boolean |  | True only if the sound carries no information (an ambiance, music): no transcript. The learner still starts it. Default false. |
| `generated` | boolean |  |  Default false. |

## `callout` (content)

A highlighted note: key rule, tip, warning.

> Use for the one rule learners must remember (signalling, E5). Not for decoration.

Template `packages/core/src/components/builtin/callout.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `variant` | "info" \| "tip" \| "warning" \| "important" |  |  Default "info". |
| `title` | string |  |  |
| `markdown` | markdown |  | Use markdown or textRef, not both. |
| `textRef` | planId |  |  |

## `button` (interaction)

A button. What it does is defined by screen events with on: {type: click, target: &lt;this block id&gt;}.

> Label with a verb describing the result ("Voir la solution"). Add a click event, otherwise the validator reports a dead button.

Template `packages/core/src/components/builtin/button.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `label` | string | yes |  |
| `variant` | "primary" \| "secondary" |  |  Default "secondary". |

## `accordion` (structure)

Expandable panels for optional detail. Revealing content is not practice (guardrail B2).

Template `packages/core/src/components/builtin/accordion.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `items` | array | yes |  |
| `allowMultiple` | boolean |  | Allow several panels open at once. Default true. |

## `math` (content)

A displayed equation in LaTeX, rendered as MathML at build time: native to browsers, read by screen readers, no script at runtime. For maths inside sentences, write $…$ in any Markdown text.

> LaTeX maths (temml, close to KaTeX). Keep words out of the equation: put them in caption or in text blocks so they can be translated. Use \text{} only for short unit labels.

Template `packages/core/src/components/builtin/math.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `tex` | string | yes | LaTeX source, without $ delimiters. |
| `caption` | markdown |  | What the equation means, shown under it. |
| `label` | string |  | Equation number shown at the right, for example (1). |

## `quiz` (assessment)

A single- or multiple-choice question with elaborated feedback. Either reuse a validated plan question (questionRef) or write the question inline (stem, mode, options) for non-locked practice.

> Prefer questionRef when the plan has the question. Inline items: 3 plausible options (C1), no 'all/none of the above', no unflagged negation, homogeneous option length, elaborated feedback for every option explaining why (D1), contextualised at the objective's Bloom level (C2).

Template `packages/core/src/components/builtin/quiz.html`: fork it to change the markup; the fork keeps the quiz behaviour and must provide `data-t-stem`, `data-t-option`, `data-t-submit`, `data-t-feedback`.

| Prop | Type | Required | Description |
|---|---|---|---|
| `questionRef` | planId |  | Id of a plan question. When set, do not set stem, mode or options. |
| `stem` | markdown |  |  |
| `mode` | "single" \| "multiple" |  |  |
| `options` | array |  |  |
| `objective` | planId |  | Plan objective measured. Taken from the plan question when questionRef is used. |
| `scored` | boolean |  | Counts in the course score. Default true. |
| `weight` | number |  |  Default 1. |
| `attempts` | integer |  | Tries before the answer is final. Default 1. |
| `showCorrectAnswer` | boolean |  | After the last try, highlight the correct options. Default true. |
| `feedbackStyle` | "full" \| "compact" |  | How the feedback of the options chosen is shown under the question. full: each option's text in bold, then its feedback. compact: its feedback only, the option being marked where it is (screen readers still hear its text first): about half the room an answered question reserves on a slide, so that two questions fit side by side. With several options' feedback at once (multiple choice), each keeps its text. Default "full". |

## `numeric` (assessment)

A question answered with a number, accepted within a tolerance, with targeted feedback for the values learners get with typical errors. Either reuse a validated numeric question of the plan (questionRef) or write it inline.

> Use it for calculation objectives (apply level) instead of multiple choice. Put the unit in unit. Give correct and incorrect feedback, and one misconception per typical error (wrong formula, inverted ratio, sign error) with feedback naming that error. Tolerance: absolute for rounded values, percent for measured ones.

Template `packages/core/src/components/builtin/numeric.html`: fork it to change the markup; the fork keeps the numeric behaviour and must provide `data-t-stem`, `data-t-input`, `data-t-submit`, `data-t-feedback`.

| Prop | Type | Required | Description |
|---|---|---|---|
| `questionRef` | planId |  | Id of a numeric question of the plan. When set, do not set stem, answer, tolerance, unit, feedback or misconceptions. |
| `stem` | markdown |  |  |
| `answer` | number |  | Expected value. |
| `tolerance` | numericTolerance |  |  |
| `unit` | string |  | Unit shown after the input, for example rpm. |
| `feedback` | numericFeedback |  |  |
| `misconceptions` | misconceptions |  |  |
| `objective` | planId |  | Plan objective measured. Taken from the plan question when questionRef is used. |
| `scored` | boolean |  | Counts in the course score. Default true. |
| `weight` | number |  |  Default 1. |
| `attempts` | integer |  | Tries before the answer is final. Default 1. |
| `showCorrectAnswer` | boolean |  | After the last try, show the expected value. Default true. |

## `decision` (scenario)

A choice in a scenario. Consequences are defined by events (decision.selected with option), for example show a layer or go to another screen. Use it for branching scenarios (guardrail B3).

> Realistic situation, plausible options, consequences shown rather than told (D3). Add one event per option or one event per outcome.

Template `packages/core/src/components/builtin/decision.html`: fork it to change the markup; the fork keeps the decision behaviour and must provide `data-t-prompt`, `data-t-choice`, `data-t-feedback`.

| Prop | Type | Required | Description |
|---|---|---|---|
| `prompt` | markdown | yes |  |
| `options` | array | yes |  |
| `objective` | planId |  |  |
| `scored` | boolean |  | Counts in the course score (needs at least one option with correct). Default false. |
| `weight` | number |  |  Default 1. |
| `allowChange` | boolean |  | Let the learner choose again after seeing the consequence. Default false. |

## `free-object` (free)

Places a free object (governed custom code, for example a three.js scene) on the screen. The object lives in objects/&lt;object&gt;/ with its manifest, code, tests and notes. props holds values for the props the manifest declares: change them here, never in the code.

> Only when no native block can do the job, and on explicit request. Write the manifest first, then tests, then code (see skill elabora-free-objects). textAlternative must give an equivalent activity or a full description.

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `object` | slug | yes | Free object id (folder name in objects/). |
| `title` | string | yes | Accessible name of the embedded object. |
| `props` | object |  | Values of the props declared in the object manifest. Missing props use their manifest default. |
| `a11y` | object |  | What screen readers say about the object, worded for this block (defaults: the manifest a11y description and keyboard). Translations write here. |
| `strings` | object |  | Wording of the object's strings for this block (keys declared in the manifest strings; same placeholders). Required when the course language differs from the manifest language; translations write here. |
| `enumLabels` | object |  | Wording of the values of the object's choices for this block, as the editor shows them (defaults: the manifest x-enum-labels). Keys are props with an enum, or &lt;prop&gt;.&lt;field&gt; for a field of a list's items; each maps values of that enum to words. Translations write here. |
| `aspectRatio` | aspectRatio |  | Shape of the frame on wide containers. auto: the object sets its height with host.requestHeight(px). fill: the frame takes the height of its layout slot. Default "16:9". |
| `narrowAspectRatio` | aspectRatio |  | Shape when the block is narrower than 640 px (phones, narrow slots). Typically 3:4, 2:3 or auto. Defaults to aspectRatio. |
| `minHeight` | integer |  | Minimum frame height in px. |
| `maxHeight` | integer |  | Maximum frame height in px. |
| `textAlternative` | markdown | yes | Equivalent text activity or full description, shown on demand (WCAG 1.1.1). |
| `scored` | boolean |  | Use the object's score event in the course score. Default false. |
| `weight` | number |  |  Default 1. |

## `results` (assessment)

Shows the learner's score and status. The final status is decided when the assessment is complete, and shown here, rather than sent at exit.

Template `packages/core/src/components/builtin/results.html`: fork it to change the markup; the fork keeps the results behaviour and must provide one of `data-t-score`, `data-t-status`, `data-t-message`.

| Prop | Type | Required | Description |
|---|---|---|---|
| `showScore` | boolean |  |  Default true. |
| `showStatus` | boolean |  |  Default true. |
| `allowRetry` | boolean |  | Offer to retake scored items when failed. A failed status is never downgraded to incomplete. Default false. |
| `passedMessage` | markdown |  |  |
| `failedMessage` | markdown |  |  |
| `completedMessage` | markdown |  |  |

## `stack` (structure)

A stack (« Pile »): several contents that follow one another in the same place of a timed screen, each with its moment (its blocks' timing.in), as objects stacked on a Storyline slide. The stack takes the size of its largest content, so nothing moves around it when one replaces another. Its contents are the blocks of its items slot; each shows from its moment until the next one's (or its own timing.out). On a screen without a timeline the contents stack one under the other.

> Use on narrated slides to show successive visuals in one place as the voice names them (a printer offline, then an error message, then a diagram). Give every content a timing.in anchored to the word that brings it; the first may start with its step. Do not use for content learners must compare side by side.

Template `packages/core/src/components/builtin/stack.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `transition` | "crossfade" \| "cut" \| "slide" |  | How a content gives way to the next, unless the content sets its own effect: crossfade (one fades out as the next fades in), cut (at once), slide (the next comes from the right). Default "crossfade". |
| `duration` | number |  | Seconds of the transition. Default 0.4. |
