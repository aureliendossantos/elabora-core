# Free-object contract 0.1

A free object is custom code (a three.js simulation, a mini-game, an interaction outside the catalogue) that stays **testable, editable without code, sandboxed and tracked**. It derives from an earlier free-scene contract (v0.1), renamed "free object" as in the app (the counterpart of a Storyline Web Object, without colliding with Storyline "scenes").

## 1. Files (`objects/<id>/`)

| File | Role | Who reads it |
|---|---|---|
| `object.manifest.json` | Machine contract: props, objects, state, events, tracking, budgets, a11y, sandbox | Validator, editor, host, tests |
| `object.js` | ES module exporting `mount` | Build, sandbox |
| `object.tests.json` | Behaviour sequences and snapshots | `elabora object test` |
| `object.notes.md` | Pedagogical role in 2–3 sentences | Client review (the client sees props and notes, not code) |
| `__snapshots__/*.png` | Visual baselines (gate 5), one per system (`<test>--<step>-darwin.png`, `-win32`, `-linux`; without suffix: made on macOS) | `elabora object test` |

The build bundles `object.js` and what it imports into one minified classic script. Code from elsewhere keeps its licence in a legal comment (`/*! … */`, or one with `@license` or `@preserve`): comments are dropped, legal comments are gathered at the end of the built `object.js`, so the notice ships with every package.

## 2. Manifest essentials
See [`object-manifest.schema.json`](../packages/format/schemas/0.1/object-manifest.schema.json).

- **props**: every setting an author may change; `default` and `description` required, `title` (a short label in the editor) recommended. `x-group` (panel group), `x-control` (`text`, `textarea`, `slider`, `range`, `number`, `toggle`, `select`, `color`, `vec2`, `vec3`, `vec3-gizmo`, `asset`, `list`), `x-token` (theme token used by default, e.g. `color.accent`), `x-text-on` (below), `x-object-id` (clicking that object in the preview opens this prop), `x-editable-by` (`author` or `developer`), `x-translatable`, `x-enum-labels` (below). The control fits the type (`W_OBJECT_PROP_CONTROL`): `select` needs an enum or an integer range, `slider` a minimum and a maximum, `color` a string of `format: "color"`.
- **Controls of numbers**: `slider` for one number on a scale (`minimum`, `maximum`, a `multipleOf` for its step), `number` when there is no scale. `range` for a low and a high value on the same scale (a window of time, the band a value must fall in): `{ "type": "array", "items": { "type": "number", "minimum": 0, "maximum": 24, "multipleOf": 0.5 }, "minItems": 2, "maxItems": 2, "default": [8, 18], "x-control": "range" }`, low first; the editor shows one slider with two handles. `vec2` and `vec3` for a point or a size of two or three numbers (`[x, y]`, `[x, y, z]`, `minItems` and `maxItems` 2 or 3): X, Y and Z on one row. `vec3-gizmo` is a `vec3` the object can also move in its preview. Two or three number fields named `x`, `y` and `z` that follow each other (in a list's items) are shown on one row the same way, without a control.
- **Choices in words**: an enum holds values for the code (`parefeu`, `30-78`); `x-enum-labels` says how each reads in the editor, in the manifest's language: `"failingDevice": { "type": "string", "enum": ["commutateur", "routeur", "parefeu", "serveur"], "x-enum-labels": { "parefeu": "Pare-feu", "serveur": "Serveur d'impression" }, … }`. Keys are values of the enum (numbers written as text, `E_OBJECT_ENUM_LABELS`); a value without words shows capitalised (`Commutateur`). It works on a prop, on the items of a list of simple values and on a field of a list's items. A block rewords them with `props.enumLabels` (`{ "failingDevice": { "parefeu": "Firewall" } }`, `"voyages.from"` for a field of a list), and translations write there (units `block.<id>.enumLabels.<prop>.<value>`): authors of the translated course read them in its language. They are the editor's words: the object receives values, never these labels, and « Rechercher » does not find them.
- **Lists**: a setting that repeats (the voyages of a chart, the stations of a route) is one prop of `type: "array"` with `x-control: "list"`, never numbered props. `items` is a simple value (`{ "type": "string", "enum": […] }`) or an object whose fields are simple values, each with a `type` and a `title` (and `enum`, `minimum`, `maximum`, `maxLength`, `pattern`, `format: "color"`, `x-control`, `x-translatable`, a `default` for new items); `required` lists the fields every item has; `minItems` and `maxItems` bound the list. Items take no field the manifest does not declare. A block's list, an event's `set-object-props`, a test's props and the default are checked item by item (`E_OBJECT_PROP_VALUE`, `E_OBJECT_PROP_DEFAULT`); fields marked `x-translatable` are translation units (`block.<id>.props.<prop>.<item id or index>.<field>`). The object receives the list as an array in `ctx.props` and `update()`.
- **Colours**: a colour an author may change is a prop (`type: "string"`, `format: "color"`, `x-control: "color"`), never a literal in the code (`W_OBJECT_LITERAL_COLOR`). Bind it to a theme token (`x-token`) when it carries the course identity (accent, inks of the charter): a charter change follows. A **material colour** of the scene (the brass of a pair of dividers, a wood, a hull) keeps a literal default and no token: authors change it in the block, the object stays portable, and the course theme is not filled with a token per shade. A colour the object draws **text** in names the colour that text is read on with `x-text-on` (another colour prop, or a token such as `color.surface`): the validator checks they reach 4.5:1 with the defaults and with every block's or event's values (`E_OBJECT_TEXT_CONTRAST`). Text of the object's DOM is also checked by axe at gate 6.
- **objects**: parts with stable ids; the code sets the same id (`userData.id` and `host.registerObject`).
- **state** (schema of `getState()`) and **persistState** (`enabled`, `maxLength`): the state is saved in the learner's suspend data after each declared event.
- **events**: only declared events are accepted by the host; `tracking.interaction` writes `cmi.interactions` (objective from `planRefs`), `tracking.score` gives a 0–1 score, `tracking.completion` completes the object.
- **planRefs**, **pedagogicalRole**: what the object serves in the plan (its objectives and items, which the plan defines). `pedagogicalRole: "decoration"` makes a backdrop object (below): no planRefs, no events.
- **strings** and **language**: every word the object shows that is not a prop (buttons, status lines, units), with a description for translators, in ICU message syntax: `{gap}`, `{n, plural, one {# orbit} other {# orbits}}`, `{kind, select, a {…} other {…}}`. The code reads them with `ctx.t(key, values)`; a block rewords them with `props.strings` (same placeholders, `E_OBJECT_STRINGS`), and translations write there. A manifest in another language than the course needs its strings worded by the block (`W_OBJECT_STRINGS_LANGUAGE`); keys read in the code must be declared (`W_OBJECT_STRING_UNDECLARED`). The a11y description and keyboard text can be worded per block too (`props.a11y`).
- **budgets** (draw calls, triangles, boot time, WebGL contexts), **a11y** (description, keyboard, drag alternative, motion), **sandbox** (`network: "none"`).

## 3. Module interface

```js
import * as THREE from 'three';            // mapped to the vendored r186 build

export function mount(container, ctx) {
  // ctx.props, ctx.tokens, ctx.objects, ctx.locale, ctx.reducedMotion, ctx.testMode, ctx.savedState
  // ctx.safeArea {top, right, bottom, left}: px of the frame covered by the course layout
  // ctx.t(key, values), ctx.strings                        (words: manifest strings, as the block words them)
  // ctx.context {screen, section, step, variant}           (decorations of the backdrop)
  // ctx.view {visible, ratio, progress, entry, exit}       (where the frame is in the window)
  // ctx.host.onFrame((dt, frame) => …)  → unsubscribe     (all animation and time)
  // ctx.host.random(), ctx.host.now()                      (determinism)
  // ctx.host.emit(name, payload)                           (declared events only)
  // ctx.host.asset(id) → Promise<ArrayBuffer>              (declared assets, no network)
  // ctx.host.registerRenderer(r) / registerCamera(c) / registerObject(id, obj3d)
  // ctx.host.requestHeight(px)                             (blocks with aspectRatio "auto")
  // ctx.host.onSafeArea((area) => …)  → unsubscribe        (the layout covers another part)
  // ctx.host.onContext((context) => …) → unsubscribe       (decorations: the learner moved)
  // ctx.host.onView((view) => …) → unsubscribe             (the learner scrolled: entrances, parallax)
  return {
    update(nextProps) {},   // apply props without remounting
    getState() {},          // matches manifest.state
    setState(snapshot) {},  // resume
    pause() {}, resume() {},// optional
    dispose() {}            // free geometries, textures, renderer
  };
}
```

`mount` must return quickly. The player waits up to 15 s for the frame to answer `object/initialize` (font loading included), then shows the text version; boot time (budget `bootMsMax`, 3 s by default) is measured up to the return of `mount`. Learners on virtual desktops and locked-down laptops often have no GPU: WebGL runs in software, many times slower. Build the scene, render a first frame, and spread heavy work (procedural textures, large geometries) over the next frames with `host.onFrame`. An object that answers after the timeout recovers, and errors raised once the object runs are logged without hiding it.

## 4. Host ⇄ object protocol (JSON-RPC 2.0 over postMessage)

| Direction | Method | Purpose |
|---|---|---|
| object → host | `object/ready` | Frame loaded; the host may initialise |
| host → object | `object/initialize` | props, seed, locale, reducedMotion, tokens, objects, testMode, savedState, fonts (ArrayBuffers of the course fonts), rootSize (px of 1rem in the course page: the frame sets its own 1rem to it) |
| host → object | `object/context` | context `{screen, section, step, variant}` of a decoration, when the learner moves |
| host → object | `object/safe-area` | safeArea `{top, right, bottom, left}` in px, when the part of the frame covered by the layout changes |
| host → object | `object/set-root-size` | rootSize, when the course window changes size class (1rem of 16, 15 or 14 px): text in rem follows |
| host → object | `object/view` | view `{visible, ratio, progress, entry, exit}`: where the frame is in the window, when it changes (at most once a frame; also in initialize) |
| host → object | `object/update-props`, `object/pause`, `object/resume`, `object/get-state`, `object/set-state`, `object/step`, `object/dispose` | Lifecycle and tests |
| host → object | `object/perf`, `object/test-click`, `object/test-key`, `object/test-dry` | Budgets and test input; frames dry or drawn (test mode, see §6) |
| object → host | `object/event` | `{name, payload}`, checked against the manifest (name and payload schema) |
| object → host | `object/asset` (request) | Declared asset, answered with an ArrayBuffer |
| object → host | `object/resize` | `{height}` wanted by the object (used when the block shape is `auto`) |
| object → host | `object/error`, `object/log` | Diagnostics |

The frame has an opaque origin: messages use target origin `*` and are authenticated by `event.source` (the host only talks to its own iframe; the frame only to its parent).

## 4b. Size, theme and UI kit
- **Size.** The block chooses the frame shape: `aspectRatio` (`16:9`, `21:9`, `3:2`, `4:3`, `1:1`, `3:4`, `2:3`, `9:16`), `auto` (the object calls `host.requestHeight(px)`; the host clamps to `minHeight`/`maxHeight`) or `fill` (height of the layout slot), and `narrowAspectRatio` when the block is narrower than 640 px. A responsive object watches its container (`ResizeObserver`), switches to a stacked layout under 640 px and requests the height it needs.
- **Theme.** Before `mount`, the frame receives the course tokens as CSS variables (`--t-primary`, `--t-color-<custom>`…, same names as the player) and the embedded fonts, registered with `FontFace` from ArrayBuffers sent by the host (the sandbox has no network and an opaque origin, so fonts cannot be fetched by URL).
- **UI kit.** Classes that look like the player and follow the theme: `t-ui` (root), `t-ui-panel`, `t-ui-card`, `t-ui-eyebrow`, `t-ui-title`, `t-ui-muted`, `t-ui-btn` (`--primary`, `--ghost`), `t-ui-seg` + `t-ui-seg-options` (radio group as segmented buttons), `t-ui-meters` + `t-ui-meter` (`small`, `b`, `em`), `t-ui-status` (`is-ok`, `is-ko`), `t-ui-badge`. Focus rings and reduced motion are handled.
- **Safe area.** A layout may float its own content over a stage (a title over a 3D scene). It declares the covered part of the frame in CSS, on the slot or the block, with `--t-safe-top`, `--t-safe-right`, `--t-safe-bottom` and `--t-safe-left` (any length, for example `--t-safe-left: 30rem`, set back to `0` where the layout stacks). The host resolves them to px and gives them to the object as `ctx.safeArea`, then through `host.onSafeArea` whenever they change. The object keeps key content (the subject of the scene, labels, controls) out of it; backgrounds may run under it. Best effort, checked by snapshots: tests set it with `safeArea` or the step `set-safe-area`.
- **View (scroll presentation).** On a page longer than the window, an object can follow the scroll: `ctx.view` and `host.onView` give where its frame is, measured like a CSS `view()` timeline on the frame's box: `visible` (some of it is in the window), `ratio` (the share of its height in the window), `progress` (0 when its top reaches the bottom of the window, 1 when its bottom leaves the top), `entry` (0 to 1 while it comes in from below; 1 once it is wholly in the window, or fills it) and `exit` (0 to 1 while it leaves at the top). Use `entry` for an entrance as the learner scrolls to the object (an unrolling, a drawing), `progress` for a slow parallax. Keep entrances one way (what has appeared stays when the learner scrolls back), skip them under `ctx.reducedMotion`, and draw only when visible or when something changed: browsers stop running frames out of view, and the last picture stays. Without a host that measures it (slides, object tests), the frame is wholly in view.
- **Tests.** Time is virtual in tests (frames advance on `step`): CSS transitions and animations of the object's DOM end at once (zero duration), so snapshots and the accessibility gate never catch a panel half-faded. Each test may set the frame `size: [width, height]` (default `[960, 600]`): test the narrow layout with `[375, 860]`. A test may also set `safeArea`, `context`, `view`, `strings` (rewording) and `locale`; steps `set-safe-area`, `set-context` and `set-view` change them on the way (`set-view` keeps the values it leaves out: `{ "action": "set-view", "view": { "entry": 0.4, "progress": 0.25 } }`). Event expectations read the events once the frame has answered the gate, so every event the earlier steps emitted at once is in, those emitted in answer to `set-props`, `set-view` and the other notifications included; an expected event that comes a moment later (once an asset has arrived) is awaited up to 5 s, virtual time standing still; `expect-no-event` does not wait for events still to come. A snapshot has the stall guard's 60 s.

## 4c. Decorations (course backdrop)
A free object with `pedagogicalRole: "decoration"` is mounted once behind the course by `theme.backdrop.object` (see design.md, Backdrop), never in a block. It is hidden from screen readers and out of the tab order; it has no planRefs, no events (`events: []`), no saved state and no focusable element (gate 6 checks it); its default budgets are smaller (30 draw calls, 60,000 triangles). It receives `ctx.context` and `host.onContext` (screen, section, step, variant) to follow the course. Under reduced motion, and on a machine that renders below 24 frames per second, the frame runs it in still mode: a few frames after mount and after each change of context, props or safe area, then nothing.

## 4d. Replay in the course
`elabora object replay . <id> [--test <name>] [--block <id>] [--size 1600x900]` (MCP `elabora_replay_object`) replays one test of `object.tests.json` where learners meet the object: the built course, on the page that places it, scrolled into view, in real time, with the course around it. `step` waits its frames in real time, `click`, `key`, `set-props` and `set-state` drive the object, `set-view` scrolls the page to that view, `snapshot` captures the window; expectations are checked as they come, waiting a moment for an object a little behind (software WebGL). The result is a contact sheet of the snapshots and the end, with the expectations that failed. It shows; the gates stay `elabora object test`.

## 5. Sandbox
`<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer">` (no `allow-same-origin`; `allow-pointer-lock` only if declared) and a frame CSP `default-src 'none'; script-src 'self'; connect-src 'none'; …`. The object cannot reach the course page, the LMS API, cookies, storage or the network. Only the host talks to the LMS. Objects are compiled into classic scripts because module scripts would need CORS headers from the LMS server.

## 6. Gates

| # | Gate | Automated by | Blocking |
|---|---|---|---|
| 1 | Manifest: schema, coherence of objects/props/events/tokens, `planRefs` in the plan, static analysis of the code | `elabora validate` | yes |
| 2 | Smoke: mount, 300 frames, `getState()` matches the state schema, dispose, no console error; every call answered within 60 s (an object stuck in a loop fails here, the other gates are not run) | `elabora object test` | yes |
| 3 | Behaviour: `object.tests.json` replayed (clicks on declared objects, keys, props, state, expected events) | `elabora object test` | yes |
| 4 | Budgets: draw calls, triangles, WebGL contexts, boot time (median of the mounts of the run, the smoke test's and one per test; over the budget a warning, `W_GATE_BOOT_SLOW`, as learners without a GPU see the loading indicator; over 10 s an error) | `elabora object test` | yes |
| 5 | Visual: snapshots against the baselines of the system running the gates (0.1 % pixel tolerance; fonts and WebGL differ between systems); a system's first run records its baselines | `elabora object test` | yes |
| 6 | Accessibility: axe-core (WCAG 2.2 A/AA) on the object DOM, keyboard reachability | `elabora object test` | yes |
| 7 | Signal: multimodal judge with a checklist | not in 0.1 | never alone |
| 8 | Human: pedagogical review and code review | proof dossier checklist | yes |

**Frames drawn.** The gates draw WebGL in software, as on machines without a GPU and with the same pixels on every machine, and drawing is nearly all their time; yet a test only looks at the last frame before each snapshot. The others run **dry**: the object's code runs every frame (its state, events, uploads, shaders and their errors), its draws, clears and blits are skipped (`object/test-dry`, `@elabora/player` `dry-frames.ts`). What a skipped operation would have drawn is tracked as stale until drawn again, and a run decides only if nothing it saw depended on it: a canvas still showing a stale drawing at a snapshot, a draw on a stale framebuffer or sampling a stale texture, a read of a stale drawing (`readPixels`, a copy or blit, a WebGL canvas drawn into a 2D canvas, uploaded or turned into an image), a query or `getError` after a skipped draw, transform feedback. A dry run that saw one of these, or that fails, or whose snapshot differs, is done again with every frame drawn, and that run decides; when only the drawing of a render target was reused (a texture baked over the first frames), it is first tried again with render targets drawn and only the canvas dry, as are the object's next tests. Runs that record baselines (`--update-snapshots`, a system's first run) draw every frame. So verdicts are those of every frame drawn; a test that draws only when something changed, or reads its drawing back, is just slower. In test mode (`ctx.testMode`) draw every frame, and pick with raycasting rather than by reading pixels back. A step waits until its frames are drawn.

A full run of `elabora object test` is recorded in `objects/<id>/object.gates.json` (date, Elabora version, gates, boot time, fingerprint of the object folder); the proof dossier reports it as passed, failed, stale (the object changed since) or never run. `--only <name>` runs the tests whose name contains it, without recording. The behaviour tests run side by side in several pages; their mounts run one at a time, so that each boot time is measured alone.

An object unchanged since its last full run on this computer is not run again: its result comes back at once, `unchanged since <date>, not run again` (`reused`). Unchanged means the object folder (its fingerprint) and what the gates take from the course and the computer: the theme tokens, the fonts and their files, the language, the Elabora code and what it runs the object with (esbuild, three.js, axe-core, the snapshot comparison), the browser and its version, the system. That run is kept in the course's machine-local `.elabora/cache/objects/`, unless it wrote baselines or an object stuck in a call or a boot near the timeout failed it (a loaded computer may cause those). `--force` (MCP `force`) runs the gates anyway; `--update-snapshots` always runs them.

`--update-snapshots` also removes the baselines of states no test names any more (a test or a snapshot step renamed or removed), for every engine and system. It keeps, and lists, the baselines of the states that exist made by another engine or on another system (Chrome's `-darwin.png` next to the app's Electron `-electron-darwin.png`): runs on that browser or system still compare with them.

## 7. Lifecycle
Semver on the manifest: removing or renaming a prop, state field or event is a major change and needs a migration of the values stored in screens. Authors change **values** (block `props.props`); behaviour changes go through an agent as a localized diff and replay gates 2–6. An object reused in three modules or more is a candidate for promotion into the native catalogue.
