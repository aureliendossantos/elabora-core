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

Rich text in the Elabora Markdown subset, with an optional note in the margin (aside): beside the text on wide windows, after it, indented, on narrow ones.

> Short paragraphs, conversational 'you' (E6), no decorative anecdotes (E1). Keep a screen under about 250 words (E3). When the plan has a locked text, use textRef instead of copying it. aside: a margin note of one or two sentences (a word explained, a source, a nuance); the text must read without it.

Template `packages/core/src/components/builtin/text.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `markdown` | markdown |  | Text content. Use markdown or textRef, not both. |
| `textRef` | planId |  | Id of a validated text of the plan: the block shows the plan's wording, and rewording it writes the plan. |
| `aside` | markdown |  | A note in the margin: beside the text on wide windows, after it, indented, on narrow ones; read after the text by screen readers. |

## `image` (content)

An image from the assets folder, in one of five presentations: centered (in the reading column, the default), wide (wider than the text), band (edge to edge, cropped to a height around its focal point), beside (a title and a text beside it, stacked on narrow screens) or over (a title and a text over it, edge to edge, on the theme's scrim).

> Only images with an instructional function (E1): a figure that explains, a situation the learner will recognise, the object studied. Write alt as the information the image carries, not its file name; decorative: true only when it carries none. Generated images must be marked generated: true (AI Act art. 50). Presentations: centered for most figures; wide for a figure whose detail needs room (a map, a diagram); band to open or separate the parts of a long page, not as decoration between paragraphs; beside to explain one picture in a few sentences; over for a short title and one or two sentences on a photograph that sets the scene (the text must stay readable: elabora fit measures it). Give focus where the subject is when the image is cropped (band, over, beside on phones).

Template `packages/core/src/components/builtin/image.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `presentation` | "centered" \| "wide" \| "band" \| "beside" \| "over" |  | centered: in the reading column, as it is; wide: across the wide column; band: edge to edge of the window (of the slide in slides), cropped to height around focus; beside: title and markdown beside the image, which takes share of the width on side (stacked under it on narrow screens); over: title and markdown over the image, edge to edge, on the theme's scrim. Default "centered". |
| `asset` | assetPath | yes |  |
| `alt` | string |  | Text alternative. Required unless decorative is true. |
| `decorative` | boolean |  | True only if the image carries no information. Default false. |
| `caption` | string |  |  |
| `generated` | boolean |  | True if produced by an AI model; the player shows a mark and the build report lists it. Default false. |
| `focus` | focus |  | Where the subject is (0 to 1 across and down): crops keep it in view (band, over, beside on phones). |
| `title` | string |  | beside and over: a heading for the text (it follows the page's headings). |
| `markdown` | markdown |  | beside and over: the text that goes with the image. Over an image, keep it to one or two sentences. |
| `side` | "start" \| "end" |  | beside: the side of the image (start: left in left-to-right languages). Default "start". |
| `share` | "half" \| "third" \| "two-thirds" |  | beside: the share of the width the image takes. Default "half". |
| `height` | "medium" \| "short" \| "tall" |  | band and over: how tall the image is (the crop keeps focus in view). Over grows with its text. Default "medium". |
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

A single- or multiple-choice question with elaborated feedback. Either reuse a validated plan question (questionRef) or write the question inline (stem, mode, options) for non-locked practice. presentation text lists the options; images shows them as picture cards (each option's image and alt); image places them as numbered zones on one picture (image, alt; each option's x and y), named « Zone 1 »… for screen readers until the answer is final.

> Prefer questionRef when the plan has the question. Inline items: 3 plausible options (C1), no 'all/none of the above', no unflagged negation, homogeneous option length, elaborated feedback for every option explaining why (D1), contextualised at the objective's Bloom level (C2). presentation images when the options are things to recognise by sight (a part, a sign, a screen), each picture with an alt that describes it without giving the answer away; image to find something on one picture (a component on a board, a field on a form): place each option's x and y (0 to 1 from the top left) on the thing, three to six zones, the stem saying what to find.

Template `packages/core/src/components/builtin/quiz.html`: fork it to change the markup; the fork keeps the quiz behaviour and must provide `data-t-stem`, `data-t-option`, `data-t-submit`, `data-t-feedback`.

| Prop | Type | Required | Description |
|---|---|---|---|
| `presentation` | "text" \| "images" \| "image" |  | text: the options as a list. images: a grid of picture cards, each option with its image and alt. image: one picture (image, alt) with the options as zones placed at their x and y. Default "text". |
| `image` | assetPath |  | image: the picture the zones are placed on. |
| `alt` | string |  | image: what the picture shows, without naming the zones' answers. |
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

## `dialogue` (scenario)

A branching conversation held in one block (D61): its nodes (a few lines, then a way out: options the learner chooses, a jump, an end), its endings and its score. The learner plays a speaker (learner) whose options become their bubbles; characters answer with lines. The thread grows in the block; the player keeps the path, replays it on resume, scores the first run and records one SCORM interaction per decision.

> Write the best path first, then the other options. Short lines (one or two sentences). Each decision: about three options, good, ok and bad (quality), plausible and of similar length, never with a speaker. Show the consequence first (reply, a character's reaction), the trainer's note after (feedback), never in a character's mouth. An option without next joins the node's way out: branch only where the story really differs, and join back. Check with elabora dialogue paths and elabora dialogue play (skill elabora-dialogues).

Template `packages/core/src/components/builtin/dialogue.html`: fork it to change the markup; the fork keeps the dialogue behaviour and must provide `data-t-log`, `data-t-options`.

| Prop | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | The dialogue's accessible name, read by screen readers and shown on its start card and debrief (« L'appel de Marc »). |
| `learner` | slug |  | The speaker of course.json speakers the learner plays: their options become this speaker's bubbles. Absent: the bubbles say « Vous » (a player label). |
| `learnerVoice` | boolean |  | The learner's options are said by the voice of learner, as lines (with learner). Default false. |
| `style` | "messaging" \| "scene" |  | messaging: a chat thread, characters on the left with a round portrait, the learner on the right (slides and scroll pages). scene: a backdrop and the cast drawn large, a few bubbles near them, the full thread in a History (slides; scroll pages too). Default "messaging". |
| `scene` | dialogueScene |  | Style scene: the backdrop and the cast placed on it. A node may change the backdrop (its scene). |
| `mode` | "practice" \| "assessment" \| "exploration" |  | Sets revisit, feedback and scoring at once (each stays changeable). practice: retry during the run, then back to any choice after the first end; feedback now and in the debrief; not scored. assessment: no going back, feedback in the debrief only, scored by quality. exploration: back to any choice at any time, feedback now, not scored. Default "practice". |
| `revisit` | "none" \| "retry" \| "after-end" \| "anytime" |  | How the learner may go back (default: the mode's). none: never (retry options continue instead). retry: « Choisir autrement » right after a consequence, and options with retry come back. after-end: retry, then « Reprendre d'ici » on any past choice and « Recommencer » once the first end is reached. anytime: « Reprendre d'ici » from the first choice. The first run to an end is the only one scored, whatever the policy; a final decision cannot be revisited, nor anything before it, but once the dialogue has ended « Recommencer » still starts a new run. |
| `scoring` | "none" \| "quality" \| "points" \| "ending" |  | What the dialogue's score (0 to 1, like any activity) is made of (default: the mode's). quality: good 1, ok 0.5, bad 0, the mean over the decisions met. points: the sum of the options' points over the highest sum a path can reach (computed on the graph). ending: the score of the ending reached. none: not scored. Scored dialogues count in the course score with weight, and record one choice interaction per decision of the first run. |
| `weight` | number |  | Weight in the course score, when scored. Default 1. |
| `objective` | planId |  | The plan objective the dialogue practises: the objective of its SCORM interactions. A node or an option may name its own. |
| `feedback` | "now" \| "debrief" \| "both" |  | When the options' feedback is shown (default: the mode's): now, as a trainer's note in the thread after the consequence; debrief, in the debrief card at the end; both. |
| `debrief` | boolean |  | A debrief card at the end: the ending reached, each decision with its quality and feedback, then the other endings. Default true. |
| `pace` | "auto" \| "click" |  | auto: the lines of a turn follow one another. click: one line per click. Default "auto". |
| `reveal` | "ink" \| "appear" \| "instant" |  | How a line's words come in step with its voice: ink (words not said yet in a lighter ink), appear (they appear), instant (the whole text at once). Reduced motion and the learner's « Texte : tout de suite » show the whole text. Default "ink". |
| `begins` | "auto" \| "click" \| "event" |  | auto: when the block comes into view (or its step is revealed). click: a start card with a button. event: when an event runs start-dialogue. Default "auto". |
| `start` | dialogueNodeId |  | The first node (default: the first of nodes). |
| `vars` | array |  | Variables of the dialogue only (a character's trust…), changed by options (set, add) and read by conditions ({ "var": "trust", "op": "gte", "value": 2 }). Recomputed from the path, so they go back when the learner goes back. Never the course's variables: those change on dialogue.ended, in an event of the screen. |
| `nodes` | array | yes | The moments of the conversation, in reading order. A node plays its lines, then leaves by, in this order: its options (a decision), its next, its end, or else the next node of the list (after the last one, the dialogue ends). |
| `endings` | array |  | Named endings. end: true lets their conditions choose (the first that holds wins; put one without if last); end: "&lt;id&gt;" picks one. Without endings, the dialogue ends without a title. |

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

## `key-figures` (chart)

2 to 4 figures to remember, side by side, counted up when they appear.

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). A figure is short ("62 %", "1 in 10", "25 min"); its label says what it counts.

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the data comes from, shown under the chart. |
| `items` | array | yes | The figures. |
| `highlight` | string |  | Id of the figure that carries the idea: it takes the accent colour, the others step back. |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `bars` (chart)

A ranking: horizontal bars that say which item dominates. The highlighted bar takes the accent colour once every bar stands; the pointer, a tap or the arrow keys read each value.

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). 2 to 12 rows; sorted largest first unless sort is none (an order that means something: a scale, years).

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the data comes from, shown under the chart. |
| `rows` | array | yes | The bars, in any order. |
| `highlight` | string |  | Id of the row that carries the idea: it takes the accent colour, the others step back. |
| `unit` | string |  | Unit written after the values (min, kg, €). "%" writes percentages as the language does (62 %, 62%). |
| `decimals` | integer |  | Decimals shown. Default 0. |
| `sort` | "descending" \| "none" |  | Order of the bars. Default "descending". |
| `max` | number |  | The value of a full bar (100 for percentages of a whole). Default: the largest value. |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `donut` (chart)

A whole in 2 to 6 parts (fewer reads better), as a ring whose centre says the highlighted part. Hover, a tap or the arrow keys lend the centre to another part.

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). Parts should add up to a whole; more than 5 parts reads badly: use bars.

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the data comes from, shown under the chart. |
| `parts` | array | yes | The parts, clockwise from the top. |
| `highlight` | string |  | Id of the part that carries the idea: it takes the accent colour, the others step back. |
| `unit` | string |  | Unit written after the values (min, kg, €). "%" writes percentages as the language does (62 %, 62%). |
| `decimals` | integer |  | Decimals shown. Default 0. |
| `center` | "highlight" \| "total" |  | What the centre of the ring says at rest. Default "highlight". |
| `totalLabel` | string |  | Under the total, when center is total ("emails tested"). |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `trend` (chart)

A change over time as a line that draws itself, with the moment that explains it. In predict mode the learner draws the end of the line before seeing it.

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). 2 to 40 points; a note on the point where things changed. Predict mode: hide the points after predict.from and let the learner draw them; not scored by default (an engagement moment).

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the data comes from, shown under the chart. |
| `points` | array | yes | The points, in order. x is a year or a number (spaced by value), or a word (evenly spaced). |
| `unit` | string |  | Unit written after the values (min, kg, €). "%" writes percentages as the language does (62 %, 62%). |
| `decimals` | integer |  | Decimals shown. Default 0. |
| `valueLabels` | "ends" \| "end" \| "none" |  | The values written on the line: ends, the first (in grey) and the last (at the line's head); end, the last only; none, neither. The pointer, the keys and the data table still give every value. Default "ends". |
| `yMin` | number |  | Bottom of the scale. Default 0. |
| `yMax` | number |  | Top of the scale. Default a little above the largest value. |
| `note` | object |  | What explains the change, written at a point of the line, shown when the line reaches it. |
| `mode` | "show" \| "predict" |  | predict: the learner draws the end of the line, then sees the real one over their guess. Default "show". |
| `predict` | object |  | Predict mode. |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `proportion` (chart)

"1 in 10" as an icon array: of icons in a grid, part of them in the accent colour, grouped at the start (grouped icons are read better than scattered ones), with the figure beside them.

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). Keep of at 10, 20, 50 or 100; write figure in words people say ("1 in 10").

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the data comes from, shown under the chart. |
| `of` | integer | yes | How many icons in all. Default 100. |
| `part` | integer | yes | How many in the accent colour. |
| `figure` | string |  | The figure beside the icons ("1 in 10"). Default: the percentage. |
| `label` | string |  | What the figure counts, under it ("clicked the link of the test email"). |
| `icon` | "person" \| "circle" \| "square" |  | The icon. Default "person". |
| `columns` | integer |  | Icons per row. Default 10, or 20 from 100 icons. |
| `at` | anchor |  | Narrated screens: the moment the counted icons fill in. |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `before-after` (chart)

A few items measured twice, joined by a line: who moved, who moved least.

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). 2 to 10 items; beforeLabel and afterLabel name the two moments.

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the data comes from, shown under the chart. |
| `items` | array | yes | The items. |
| `beforeLabel` | string | yes | The first moment ("2022"). |
| `afterLabel` | string | yes | The second moment ("2025"). |
| `highlight` | string |  | Id of the item that carries the idea: it takes the accent colour, the others step back. |
| `unit` | string |  | Unit written after the values (min, kg, €). "%" writes percentages as the language does (62 %, 62%). |
| `decimals` | integer |  | Decimals shown. Default 0. |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `levels` (chart)

Stacked levels shaped as one figure: a funnel, widest at the top (what remains at each stage, with values), or a pyramid, widest at the base (levels that rest on one another).

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). Items from top to bottom. A funnel has values; a pyramid may not.

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the data comes from, shown under the chart. |
| `items` | array | yes | The levels, from top to bottom. |
| `shape` | "funnel" \| "pyramid" |  | funnel: widest at the top; pyramid: widest at the base. Default "funnel". |
| `highlight` | string |  | Id of the level that carries the idea: it takes the accent colour, the others step back. |
| `unit` | string |  | Unit written after the values (min, kg, €). "%" writes percentages as the language does (62 %, 62%). |
| `decimals` | integer |  | Decimals shown. Default 0. |
| `showDrops` | boolean |  | A funnel with values: the drop from one row to the next (« −34 % ») beside the silhouette. false leaves the values alone. Default true. |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `process` (chart)

A short procedure: numbered steps joined by a line that draws itself.

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). 2 to 7 steps; a title is a verb ("Press Report").

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the data comes from, shown under the chart. |
| `items` | array | yes | The steps, in order. |
| `highlight` | string |  | Id of the step that carries the idea: it takes the accent colour, the others step back. |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `cycle` (chart)

A loop of stages around a centre; the centre explains the stage pointed at, focused or tapped.

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). 3 to 8 stages; center says what the loop is.

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the data comes from, shown under the chart. |
| `items` | array | yes | The stages, clockwise from the top. |
| `center` | object |  | What the centre says at rest (optional: without it the centre stays empty). |
| `highlight` | string |  | Id of the stage that carries the idea: it takes the accent colour, the others step back. |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `matrix` (chart)

Items placed on two axes, in four quadrants; one quadrant can carry the message.

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). x and y of items go from 0 to 1 (left to right, bottom to top).

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the data comes from, shown under the chart. |
| `x` | object | yes | The horizontal axis. |
| `y` | object | yes | The vertical axis. |
| `quadrants` | object | yes | The quadrants' names. |
| `highlightQuadrant` | "topLeft" \| "topRight" \| "bottomLeft" \| "bottomRight" |  | The quadrant that carries the message. |
| `items` | array | yes | The items. |
| `highlight` | string |  | Id of the item that carries the idea: it takes the accent colour, the others step back. |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `milestones` (chart)

Dated events on a rail that draws itself.

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). 2 to 8 events, in order; date is short ("2019", "March 2024").

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the data comes from, shown under the chart. |
| `items` | array | yes | The events, in order. |
| `highlight` | string |  | Id of the event that carries the idea: it takes the accent colour, the others step back. |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `diagram` (chart)

A flow, a decision, a map of ideas, written in Mermaid and drawn when the course is built (by Pele): nodes appear by depth and edges draw; pointing at a node lights the path that leads to it.

> One chart says one thing: write takeaway as the finding, set highlight to the item that proves it, keep labels short (they are translated). On a narrated screen, give items an at anchor to the word that names them (see skill elabora-charts). Allowed: flowchart, sequenceDiagram, stateDiagram-v2, mindmap, timeline, journey, ishikawa, venn. Write labels in the course language; no style, classDef or colours (the theme colours the diagram). Keep it under about 15 nodes.

Rendered by code: cannot be forked; place it in a component slot.

| Prop | Type | Required | Description |
|---|---|---|---|
| `takeaway` | string | yes | The sentence the chart proves, shown as its title: "Most incidents start with an email", not "Incidents by origin". |
| `context` | string |  | Only what neither the title nor the chart says (the unit, the population or the period the axes do not give), in one line under the title. Most charts need none; never a rephrasing of the takeaway. |
| `source` | string |  | Where the diagram comes from, shown under it. |
| `mermaid` | string | yes | The diagram in Mermaid syntax, its words in the course language. |
| `labels` | object |  | Words of nodes and edges by id (as Pele names them: a flowchart node's id, an edge's L_&lt;from&gt;_&lt;to&gt;_&lt;n&gt;, a mind map node's words), replacing the Mermaid text's. Translations write here. |
| `beats` | array |  | Narrated screens: nodes brought by the voice. |
| `highlight` | string |  | Id of the node that carries the idea (an outcome): it takes the accent colour. |
| `spotlightEnd` | anchor |  | Narrated screens: when the voice is done with the items, so they all stand again and the highlight takes the colour. Default: the end of the line where the last item came. |
| `revealOnBeats` | boolean |  | Narrated screens with item moments: each item appears at its moment (true), or every item is there from the start and the moments only move the spotlight (false). Default true. |

## `fill-in` (assessment)

« Texte à trous »: a text with blanks the learner fills, typed, chosen from menus or placed from a bank of words. Blanks are written in the Markdown as [[answer|other accepted answer]]; the build turns them into blanks and keeps their answers out of the text. Scored by the share of its blanks right; correct when all are. After the last try the right answers show in place.

> Use it to recall key terms, values or steps in their context (retrieval practice). Blank the word that carries the idea, never a trivial one, and keep one to three blanks per sentence and a dozen at most: the sentence must stay readable around them. Give every accepted spelling or synonym after | ([[DNS|serveur DNS]]). presentation typed (default) asks to produce the word: the strongest retrieval, for terms learners must write; menus gives a list per blank: recognition, quicker on phones, for words with tricky spellings; bank gives the words to place: easiest, for a first practice. With menus and bank add two or three plausible distractors (words of the same kind as the answers). Always write feedback.incorrect that explains the rule or the clue without giving the answers, and feedback.correct that says why.

Template `packages/core/src/components/builtin/fill-in.html`: fork it to change the markup; the fork keeps the fill-in behaviour and must provide `data-t-stem`, `data-t-text`, `data-t-submit`, `data-t-feedback`.

| Prop | Type | Required | Description |
|---|---|---|---|
| `presentation` | "typed" \| "menus" \| "bank" |  | How the learner fills the blanks: typed (a field per blank), menus (a list per blank: every blank's answer and the distractors, in a fixed shuffled order), bank (the words to place: choose a word, then its blank; drag works too with a mouse). Switching it never changes the words. Default "typed". |
| `stem` | markdown |  | Instruction or question above the text (Complétez la procédure.). |
| `markdown` | markdown | yes | The text with its blanks: [[answer]] or [[answer\|other accepted\|another]]. The first answer is the one shown after the last try (and the word a bank or a menu offers). Translate the answers with their sentence. |
| `distractors` | array |  | menus and bank: wrong words offered with the answers. |
| `ignoreAccents` | boolean |  | typed: accept an answer written without its accents (« eleve » for « élève »). Case, spaces around the word and the form of quotes and apostrophes never count. Default false. |
| `feedback` | activityFeedback |  |  |
| `objective` | planId |  | Plan objective measured. |
| `scored` | boolean |  | Counts in the course score (the share of its blanks right). Default true. |
| `weight` | number |  |  Default 1. |
| `attempts` | integer |  | Tries before the answers are final. Default 1. |
| `showCorrectAnswer` | boolean |  | After the last try, show the right answer in each wrong blank. Default true. |

## `sort` (assessment)

« Classer »: items the learner places, by choosing an item then where it goes (a mouse may also drag): each with its match (pairs), into two to four categories (categories), or in order (order). Scored by the share of its items placed right; correct when all are. After the last try each item shows whether it was right, and where it belonged.

> Use it to tell cases apart (categories: sort examples, and near misses, under the concepts they illustrate), to link two sets (pairs: a term and its definition, a symptom and its cause) or to order a procedure or a timeline (order). Four to eight items: fewer is a guess, more is a chore on a phone. pairs: as many targets as items, each target holding one; the last pair is then given by elimination, so prefer categories when there are more than five pairs. categories: two to four targets, each with at least one item, items written as cases from the learner's work rather than definitions. order: write the items in the right order, the player shows them shuffled; no targets. Keep items short (a few words, or an image with its alt). Always write feedback.incorrect that explains the rule that sorts them, and feedback.correct that says why.

Template `packages/core/src/components/builtin/sort.html`: fork it to change the markup; the fork keeps the sort behaviour and must provide `data-t-stem`, `data-t-sort-item`, `data-t-submit`, `data-t-feedback`.

| Prop | Type | Required | Description |
|---|---|---|---|
| `presentation` | "pairs" \| "categories" \| "order" |  | pairs: each item goes to its own target, each target takes one item. categories: two to four targets, each taking several items. order: no targets, the items are put in order (written in the right order, shown shuffled). Default "pairs". |
| `stem` | markdown |  | The instruction (Associez chaque symptôme à sa cause.). |
| `items` | array |  | What the learner places, in the right order for order (they are shown in a fixed shuffled order). |
| `targets` | array |  | pairs and categories: where items go (two to four categories; as many targets as items for pairs). |
| `feedback` | activityFeedback |  |  |
| `objective` | planId |  | Plan objective measured. |
| `scored` | boolean |  | Counts in the course score (the share of its items placed right). Default true. |
| `weight` | number |  |  Default 1. |
| `attempts` | integer |  | Tries before the placements are final. Default 1. |
| `showCorrectAnswer` | boolean |  | After the last try, each item placed wrong says where it belonged. Default true. |

## `reflection` (assessment)

« Réflexion »: a prompt the learner answers in their own words (text) or on a scale (scale). Never scored: it counts as answered once saved. Saving shows a confirmation and, when model is given, an expert's answer to compare with. With download, a button gives « Mes réponses », a text file of every reflection of the course made in the browser.

> Use it to make learners connect the content to their own work (self-explanation, generative learning): ask about a situation they know (« Pensez à la dernière fois qu'un client… : qu'auriez-vous fait autrement ? »), not for a definition the text gives. One clear question per block, after the content it builds on; a few per module. text (default): give model, an expert's short answer written as an example to compare with, not as the right answer; keep maxLength near 500 (each character counts in the LMS's saved data, see E_SUSPEND_DATA_BUDGET). scale: a self-assessment (confidence, frequency, agreement) with minLabel and maxLabel saying what the ends mean; five points by default. Turn download on in modules whose reflections learners keep (a plan of action).

Template `packages/core/src/components/builtin/reflection.html`: fork it to change the markup; the fork keeps the reflection behaviour and must provide `data-t-prompt`, `data-t-response`, `data-t-submit`, `data-t-feedback`.

| Prop | Type | Required | Description |
|---|---|---|---|
| `presentation` | "text" \| "scale" |  | text: the learner writes. scale: the learner picks a point from scale.min to scale.max. Default "text". |
| `prompt` | markdown | yes | The question, tied to the learner's own experience. |
| `maxLength` | integer |  | text: the longest answer, in characters. The build counts it in the LMS's saved data as a persisted string variable. Default 500. |
| `rows` | integer |  | text: the height of the field, in lines. Default 4. |
| `model` | markdown |  | An expert's answer, shown once the learner has saved theirs, to compare with. |
| `download` | boolean |  | Offer « Mes réponses »: a text file of every reflection of the course and the learner's answers, made in the browser (nothing is sent). Default false. |
| `scale` | object |  | scale: the points offered, and what their ends mean. |
| `objective` | planId |  | Plan objective the reflection serves (recorded with its interaction). |

## `statement` (content)

A statement (« Énoncé »): the one idea of a page to remember, set large. Presentations: statement (large text), ruled (between two rules), quote (a quotation mark before it) and image (over a picture, edge to edge, on the theme's scrim). With an author it is a quotation in every presentation: a figure with its blockquote and a caption naming the author, their role, and an optional round portrait.

> One statement per page at most, for the idea the learner must keep (a rule, a principle, the takeaway of a case), in one or two sentences. Never repeat a sentence of the page as a pull quote: a statement whose words are also in a text block of the screen is reported (W_QUOTE_REPEATS); say it once, here or there. A quotation needs a real author (author, role) and the exact words. Use the image presentation only with a photograph that carries the idea, and keep the text short: elabora fit measures its contrast on the scrim. When the plan has a locked text, use textRef.

Template `packages/core/src/components/builtin/statement.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `presentation` | "statement" \| "ruled" \| "quote" \| "image" |  | statement: large text; ruled: between two rules; quote: a quotation mark before it; image: over image, edge to edge of the window (of the slide in slides), on the theme's scrim. Default "statement". |
| `markdown` | markdown |  | The statement, one or two sentences. Use markdown or textRef, not both. |
| `textRef` | planId |  | Id of a validated text of the plan: the statement shows the plan's wording. |
| `author` | string |  | Who said or wrote it: the statement becomes a quotation (figure, blockquote, caption). |
| `role` | string |  | With author: who they are (their role, a book, a date). |
| `portrait` | assetPath |  | With author: a portrait shown round beside the caption. Decorative: the caption names the person. |
| `image` | assetPath |  | image presentation: the picture under the text. |
| `alt` | string |  | image presentation: what the picture shows. Required unless decorative is true. |
| `decorative` | boolean |  | image presentation: true when the picture carries no information beyond the text. Default false. |
| `generated` | boolean |  | True if the picture or the portrait was produced by an AI model; the player shows a mark and the build report lists it. Default false. |
| `focus` | focus |  | image presentation: where the subject of the picture is, kept in view when it is cropped. |
| `align` | "center" \| "start" |  | Where the text sits: centred, or at the start of the line. Default "center". |

## `divider` (structure)

A divider (« Séparateur ») between the parts of a long page: line (a thin rule, a separator for screen readers), ornament (the theme's drawing, a small mark by default), number (the number of the part, counted on the page: 01, 02…) or space (room only). Decoration: screen readers skip it, except a line, which is an &lt;hr&gt;.

> Use dividers to mark a pause between the parts of a long scroll page, where a heading would be too much; never one after every paragraph. A number divider opens each part of a page that has three or more (restart: true starts the count again). A part that has a name needs a heading, not a divider.

Template `packages/core/src/components/builtin/divider.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `presentation` | "line" \| "ornament" \| "number" \| "space" |  | line: a thin rule; ornament: the theme's drawing (a small mark by default); number: the part's number, counted from the first number divider of the screen (01, 02…); space: room only. Default "line". |
| `size` | "medium" \| "small" \| "large" |  | How much room it takes above and below. Default "medium". |
| `restart` | boolean |  | number: count from 01 again here. Default false. |

## `gallery` (content)

A gallery (« Galerie »): several images shown together. Presentations: grid (in columns, cropped to one ratio), mosaic (in columns at their own proportions), carousel (one at a time; until the player has its sequence, it shows as a grid) and compare (exactly two images, the second over the first, with a slider to move between them: before and after).

> Use a gallery when the images are read together: variants to compare, examples of one category, the steps of a result. Each image needs alt (what it shows that matters here) unless it is decorative, and a caption when the learner must tell the images apart. compare takes exactly two images of the same framing: the first is before (or left), the second after. Keep grids to 2 to 8 images; more belong in separate parts.

Template `packages/core/src/components/builtin/gallery.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `presentation` | "grid" \| "mosaic" \| "carousel" \| "compare" |  | grid: columns of images cropped to ratio; mosaic: columns of images at their own proportions; carousel: one image at a time (shown as a grid for now); compare: two images, one over the other, and a slider between them. Default "grid". |
| `images` | array | yes | The images, in reading order. |
| `columns` | integer |  | grid and mosaic: columns on wide screens (fewer on narrow ones). Default 3. |
| `ratio` | "4:3" \| "1:1" \| "3:2" \| "16:9" \| "3:4" |  | grid: the shape every image is cropped to, around its focus. Default "4:3". |
| `caption` | string |  | A caption for the whole gallery. |
| `generated` | boolean |  | True if images of the gallery were produced by an AI model; the player shows a mark and the build report lists it. Default false. |

## `columns` (structure)

Columns (« Colonnes »): two or three columns of blocks side by side (slots first, second, third), stacked in reading order on narrow screens. Use it for content read side by side: two cases compared, a figure and its explanation, three short points.

> Columns for content the learner compares or reads together, each column short (a heading, a paragraph, an image). Reading order is first, then second, then third: write each column so it reads after the one before when they stack on a phone. Not for long text: a column narrower than about 45 characters is hard to read. With count 2, put nothing in third.

Template `packages/core/src/components/builtin/columns.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `count` | 2 \| 3 |  | Two or three columns. Default 2. |
| `widths` | "equal" \| "wide-start" \| "wide-end" |  | equal; wide-start: the first column is twice as wide; wide-end: the last column is twice as wide. Default "equal". |
| `align` | "start" \| "center" |  | Vertical alignment of the columns: at their top, or centred on each other. Default "start". |

## `steps` (interaction)

A steps block (« Étapes »): a process, a procedure or a story told in order, as items with a title and a text. Not the screen's steps (a screen's steps pace its blocks with Continue); a steps block is one block whose items the learner goes through. Presentations: carousel (one step at a time with Previous and Next, an optional intro and summary; Rise's process), timeline (« Frise »: the steps one under the other on a line, each with its date) and scroll (« Défilé »: the text scrolls while a figure stays in view beside it and changes with the step that crosses the middle of the window; native scroll, the page is never held). In slides a scroll steps block shows its steps one under the other, each with its picture.

> Use a steps block for what happens in order: three to seven steps (W_ITEMS_MANY over seven in a carousel), each a title of a few words (about 23 characters) and two or three sentences (120 to 270 characters). carousel: a process to follow; give it an intro (what the process is for) and a summary (what to remember) when it has more than three steps. timeline: dated events (date on every item). scroll: a figure that changes with the text; figure replace (each step's image in turn), build (each step's image a transparent layer over figureImage, stacking up) or focus (one figureImage, each step's region outlined). Each image needs alt unless decorative. In slides prefer carousel: a scroll steps block shows its steps one under the other there (W_STEPS_SCROLL_SLIDES). Never call it « Étapes » steps of the screen: those are screen.steps.

Template `packages/core/src/components/builtin/steps.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `presentation` | "carousel" \| "timeline" \| "scroll" |  | carousel: one step at a time, Previous and Next, the intro and summary first and last; timeline: the steps one under the other on a line, their date before them; scroll: the text scrolls beside a figure that follows it (above it, a picture per step, in narrow places, in slides and with less motion). Default "carousel". |
| `items` | array | yes | The steps, in order. |
| `intro` | object |  | carousel: the first item, before the steps (what the process is for, what to look for). The sequence's item intro. |
| `summary` | object |  | carousel: the last item, after the steps (what to remember). The sequence's item summary: reaching it means every step was shown. |
| `numbered` | boolean |  | carousel and scroll: each step shows its number (the intro and the summary have none). Default true. |
| `figure` | "replace" \| "build" \| "focus" |  | scroll: how the figure follows the steps. replace: each step's image replaces the one before (a cross-fade; a step without image keeps it); build: each step's image is a layer added over figureImage, step n showing layers 1 to n; focus: figureImage alone, each step's region outlined and the rest dimmed. Default "replace". |
| `figureImage` | assetPath |  | scroll: the base of the figure (build: under the layers; focus: the picture whose regions the steps outline). |
| `figureAlt` | string |  | What figureImage shows. Required with figureImage. |
| `side` | "end" \| "start" |  | scroll: where the figure sits beside the text on wide places (end: after it, on the right in a left-to-right language; start: before it). Default "end". |

## `hotspots` (interaction)

An interactive picture (« Image interactive »; Rise's labeled graphic): markers on one picture, each opening a short text about the part it points at. Presentations: popover (the text floats by its marker), side (the text beside the picture), below (the text under the picture) and tour (the markers in order, one text at a time with Previous and Next). Markers are 44 px at least, numbered by default, and never pulse. In places narrower than 560 px (a phone, a column) the texts become a numbered list under the picture, the markers numbered on it; a tour stays a tour.

> Use it when the learner must find parts on one picture (a machine, a screen, a document, a map): three to six markers (W_ITEMS_MANY over eight), each a title of a few words (about 15 characters) and one or two sentences (120 to 270 characters). x and y place each marker from 0 to 1 of the whole picture (0, 0 its top left), whatever crops it later: point at the part itself. Markers closer than 44 px on a phone overlap (W_HOTSPOTS_CLOSE): move them apart or split the picture. tour when the parts have an order (a path, a procedure); otherwise popover. Give the picture its alt (what it shows as a whole); the markers carry the details.

Template `packages/core/src/components/builtin/hotspots.html`: fork it to change the markup.

| Prop | Type | Required | Description |
|---|---|---|---|
| `presentation` | "popover" \| "side" \| "below" \| "tour" |  | popover: the text floats by its marker, over the picture; side: beside the picture; below: under it; tour: the markers in order, one text at a time under the picture with Previous and Next. Default "popover". |
| `image` | assetPath | yes | The picture the markers sit on. |
| `alt` | string |  | What the picture shows as a whole. Required unless decorative is true. |
| `decorative` | boolean |  | True only when the markers' texts say everything the picture shows. Default false. |
| `focus` | focus |  | Where the subject is. In places narrower than 560 px the picture is then shown half as large again, cropped at its sides around this point, so that its markers have room; a marker the crop leaves out stays at the picture's edge. Without focus the picture is never cropped. |
| `items` | array | yes | The markers, in reading order (their numbers, and a tour's order). |
| `markerStyle` | "number" \| "icon" |  | number: each marker shows its number; icon: each shows the icon (the list on narrow places keeps the numbers). Default "number". |
| `icon` | "plus" \| "info" \| "question" \| "eye" |  | markerStyle icon: the icon of every marker. Default "plus". |
| `prompt` | string |  | What to do or look for, shown above the picture (« Sélectionnez chaque repère… »). |
| `generated` | boolean |  | True if the picture was produced by an AI model; the player shows a mark and the build report lists it. Default false. |

# Built-in screen layouts

Generated from `packages/format/schemas/0.1/layouts/`. A screen uses one with `"layout": "<id>"` and its `layoutProps`; blocks choose a slot with `slot` (docs/components.md).

## `opening` (layout)

An opening (« Ouverture »), a built-in screen layout: the head of a lesson, then its page. The head holds an eyebrow (the section and « Leçon 2 sur 6 » unless you write one), the screen's title, a lead and the reading time; presentations: title (the head alone, in the reading column), band (the title over an image edge to edge, on the theme's scrim), split (the title and the lead beside the image) and cover (the first view of the page: the image fills the window, the title over it). Its slots: question, a question asked before the lesson (a quiz or a reflection), and body, the page (the default slot), laid out as the default column.

> One opening per lesson page, on the first screen of a lesson; the rest of the page goes in body. Leave eyebrow empty: the player writes the section and the lesson number. lead: one or two sentences that say what the learner will be able to do or why it matters, not a summary. An image must set the scene of the lesson (alt unless decorative); without one, use title. A pre-question in question primes the lesson: ask what the lesson answers, unscored. band and cover put the title over the image: elabora fit measures its contrast.

Template `packages/core/src/components/builtin/opening.html`: fork it (a screen-level component that extends it) to change the markup. Slots: `question` (quiz, reflection), `body` (default).

| Prop | Type | Required | Description |
|---|---|---|---|
| `presentation` | "title" \| "band" \| "split" \| "cover" |  | title: the head alone, in the reading column; band: the title over image, edge to edge, on the theme's scrim; split: the title and lead beside image; cover: image fills the first view of the page, the title over it. Default "title". |
| `eyebrow` | string |  | A short line above the title. Empty: the player writes the section's title and « Leçon {n} sur {total} ». |
| `lead` | markdown |  | One or two sentences under the title: what the lesson brings. |
| `image` | assetPath |  | band, split and cover: the picture of the lesson. |
| `alt` | string |  | What the picture shows. Required with an image unless decorative is true. |
| `decorative` | boolean |  | True when the picture carries no information. Default false. |
| `generated` | boolean |  | True if the picture was produced by an AI model; the player shows a mark and the build report lists it. Default false. |
| `focus` | focus |  | Where the subject of the picture is, kept in view when it is cropped. |
| `duration` | boolean |  | Show the reading time of the page (« 6 min »), computed by the build from its words, its media and its narration. Default true. |
