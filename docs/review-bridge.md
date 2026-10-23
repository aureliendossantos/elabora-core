# The review bridge: `elabora-review/1`

A module built for the Revue talks with the review page that shows it in an iframe (docs/decisions.md D42). The page (`https://revue.elabora.studio`) and the module (`https://<space>.elabora.page/…`) are on two origins: they speak through `postMessage`, with the protocol below. The page draws its own pins, outlines and comment panel over the module; the module tells it where things are and goes where it is told.

The types and the pure functions (origin rule, text sizes, pointing, anchors, words) are `@elabora/player/review-protocol` (`packages/player/src/review-protocol.ts`): a review page may import them. The module's side is `packages/player/src/review.ts`, bundled as `elabora/review.js`.

## Building a module for the Revue

```
elabora build . --target web --review-origin https://revue.elabora.studio
elabora build . --target web --review-origin https://revue.elabora.studio --review-origin http://localhost:5173
```

- `--review-origin` is repeatable (or comma-separated): the production page and the development pages. An origin is `https://host[:port]`; `http://` only for this computer (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`). No path, query, credentials or wildcard: `E_WEB_REVIEW_ORIGIN` otherwise.
- MCP: `elabora_build { target: "web", web: { review: { origins: ["https://revue.elabora.studio"] } } }`. Engine: the build request's `web.review`. Node: `build(dir, { target: 'web', web: { review: { origins } } })`.
- A review build's defaults are a review's: `progress none` (nothing kept), `navigation free` (go to any screen, nothing locked), `noindex`. Each can still be given (`--progress local` to resume a reviewer where they left).
- What changes in the module: `elabora/review.js`, a `<script src="elabora/review.js">` after the player's in `index.html`, and `delivery.review { origins, languages }` in the compiled course (its build id with it). The player's files are the same bytes as in any build; **a build without `--review-origin` is unchanged, byte for byte** (`test/unit/review-bridge.test.ts`).
- The build report says `web.review { origins }`; the proof dossier names the origins.

## Security
- The module takes a message only from **the window that embeds it** (`event.source === window.parent`), only from **an origin the build named**, and, once the page has spoken, only from **that page's origin**. Anything else is ignored, without an answer.
- It posts **only to that origin**: to the embedder's origin when the browser gives it (`location.ancestorOrigins`, Chrome and Safari), else to each named origin until the page speaks (`postMessage` drops a message whose target origin is not the recipient's; never `'*'`). Embedded by a page of another origin, the module says nothing and does nothing it is asked.
- It opens no connection: no `fetch`, no WebSocket, nothing but `postMessage` to its parent (AGENTS.md rule 2). Comments go from the page to the comments API, never through the module.
- Free objects stay in their sandboxed frames (opaque origin): the bridge never talks to them, and they cannot talk to it (their messages do not come from the parent).
- The host should also serve review publications with `Content-Security-Policy: frame-ancestors https://revue.elabora.studio` (and the development origins), so that no other site frames them at all.

## Messages

Every message is a plain object with `protocol: "elabora-review/1"` and a `type`. A page message may carry an `id` (string or number); the answer to it carries it back as `re`. A message of another version (`elabora-review/2`) gets an `error` naming the version the module speaks.

### Module → page

**`ready`**: sent when the module starts, and again after `hello`.
```json
{ "protocol": "elabora-review/1", "type": "ready",
  "build": { "id": "adbd111bc92fc9ea" },
  "course": { "id": "diagnostic-reseau", "version": "1.0.0", "title": "Diagnostiquer une panne d'impression réseau" },
  "language": "fr", "languages": ["fr", "en"], "presentation": "slides",
  "screens": [{ "key": "0", "id": "accueil", "title": "Le ticket de Marc", "section": "decouvrir" }, …] }
```
`key` is the screen's permanent key (D4, `elabora.lock.json`): anchors name it, so a comment survives a renamed screen. `languages`: the course's own, then its translations (`translations/<lang>.xlf`); each is a build of its own.

**`layout`**: after `ready`, on every resize, screen change and `layout` request.
```json
{ "protocol": "elabora-review/1", "type": "layout",
  "frame": { "width": 1600, "height": 744 }, "fontSize": 14, "baseFontSize": 16,
  "sizes": [{ "scale": 0.9375, "maxWidth": 1499, "maxHeight": 839 }, { "scale": 0.875, "maxWidth": 1359, "maxHeight": 759 }, { "scale": 0.9375, "maxWidth": 760, "portraitMaxWidth": 1100 }],
  "column": { "width": 962.5, "max": 962.5, "fullBleed": false }, "widest": 962.5,
  "inset": { "right": 0, "shifted": false }, "chrome": { "top": 57, "bottom": 73 } }
```
- `fontSize`: the root text size the module takes in its frame. It follows the **frame**, not the window: `baseFontSize` (16 px, the browser's) times the scale of the last rule of `sizes` that matches (a rule matches when the frame is at most `maxWidth` wide, at most `maxHeight` high, or in portrait at most `portraitMaxWidth` wide). These are player.css's media queries (a unit test keeps them equal). `textScale(frame)` computes it.
- `column`: the screen shown, its column's width, the cap of the course's columns at this text size (`presentation.wideWidth`, 68.75 rem by default), whether the screen is full bleed (no column). `widest`: the widest column the module can have in this frame, the cap or the room the frame leaves.
- `inset`: the margin the page keeps (see `layout` below) and whether the column moved into the room left.
- `chrome`: the heights of the module's header and footer, its navigation: a floating panel sits between them and never covers them.

**`location`**: whenever the screen, the step, the open layer, the narration's line or word, or its playing state changes (the time alone does not make a message while the narration plays; it does when it is still, after a seek).
```json
{ "protocol": "elabora-review/1", "type": "location",
  "screen": "0", "index": 0, "step": 1, "steps": [1, 2], "layer": null,
  "time": 3.601, "duration": 9.2, "playing": false, "line": "l2", "word": "imprimante",
  "said": "Ni l'imprimante, ni le partage de fichiers ne marchent.", "speaker": "Marc", "held": true }
```
`time`, `duration`, `playing`, `line`, `word`, `occurrence` only on a timed screen; `occurrence` when the word is said for the second time or more in the line. While an open layer speaks on its own timeline (D62), they are the layer's (its time, its line). While a dialogue says a line (D61), `line` is that line (`<node>.<option>` for an answer the learner says aloud) with its `word`, `said` and `speaker`, when the player tells which one is being said. `said`: the line's text, `speaker`: its speaker's name when it has one, as the captions show them (the page says « quand Marc dit « … » »). `held`: the page paused the narration (`pause`) and has not resumed it.

**`blocks`**: the blocks of what is shown, after every change of screen, step, layer, size or scroll, and when a block grows or moves (at most once a frame, only when something changed).
```json
{ "protocol": "elabora-review/1", "type": "blocks", "screen": "0", "step": 1, "layer": null,
  "frame": { "width": 1600, "height": 744 }, "scroll": { "x": 0, "y": 0 },
  "blocks": [
    { "id": "accueil-situation", "type": "text", "kind": "text", "name": "Texte · Marc, comptable, ne peut plus…", "label": "Marc, comptable, ne peut plus…", "order": 1, "rect": { "x": 400.75, "y": 160, "width": 798.5, "height": 120 }, "layer": null, "parent": null, "hidden": false },
    { "id": "accueil-illustration", "type": "image", "kind": "image", "name": "Image · Schéma du réseau", "label": "Schéma du réseau", "order": 2, "rect": { … }, "layer": null, "parent": null, "hidden": false },
    { "id": "lab", "type": "free-object", "kind": "free-object", "name": "Objet interactif · Laboratoire", "label": "Laboratoire", "order": 3, "rect": { … }, "layer": null, "parent": null, "hidden": false, "object": true } ] }
```
- `rect`: CSS px in the module's viewport (add the iframe's position in the page).
- `kind`: the built-in kind (`heading`, `text`, `image`, `video`, `audio`, `quiz`, `numeric`, `decision`, `results`, `free-object`, `accordion`, `button`, `callout`, `math`, `stack`), a course component's from its lineage, `component` when it has none. `name`: a short accessible name in the module's language, the kind and the block's own words (an image's description, a heading, a question's stem, its first words; 40 characters at most), or the kind numbered among those on the screen when it has none (« Texte 2 »). The page may show `name`, or its own words for `kind` with `label`.
- `order`: reading order, from 1 (the screen, then the open layers). Comment mode's Tab goes through the visible blocks in this order.
- `parent`: the component whose slot holds the block. `layer`: the layer it is in.
- `hidden`: not visible now (a step to come, concealed by an event, timed and not there at this time). The page does not point at hidden blocks.
- A free object is one block (`object: true`): its frame is sandboxed, so a comment points at the object, not inside it.

**`went`**: the answer to `go`: `{ "type": "went", "re": "g1", "ok": false, "missing": ["block", "word"] }`. `missing` lists what of the anchor the module no longer has (`screen`, `step`, `layer`, `line`, `word`, `time`, `block`): it went as far as it could (a screen without the block: the screen; a line without the word: the line's start).

**`measured`**: the answer to `measure`: `{ "type": "measured", "re": "m1", "frame": { "width": 1150, "height": 789 }, "fontSize": 14, "widest": 962.5 }`.

**`key`**: `{ "type": "key", "key": "c" }`. The reviewer pressed C while the focus was inside the module: keys pressed there stay in the module's frame and never reach the page, whose shortcut for « Commenter » is C. Not sent for a key typed in a text field, with Ctrl, ⌘ or Alt, held down, or taken by the module (`preventDefault`). The page treats it as its own C.

**`error`**: a message of the protocol the module could not take: `{ "type": "error", "re": 7, "message": "…" }`.

### Page → module

Post to the iframe's window with the module's origin as the target: `frame.contentWindow.postMessage({ protocol: 'elabora-review/1', type: 'hello' }, 'https://<space>.elabora.page')`.

**`hello`**: the page listens: `ready`, `layout`, `location` and `blocks` again (the page's listener may come after the module's first `ready`).

**`go`**: to an anchor (the whole comment anchor, or only its screen and some parts).
```json
{ "protocol": "elabora-review/1", "type": "go", "id": "g1", "highlight": true,
  "anchor": { "screen": "0", "step": 2, "line": "l2", "word": "imprimante", "block": "accueil-illustration" } }
```
The module goes to the screen, reveals the step named (or the block's, when the block is not shown yet), places a timed screen at the word (its start), else at the line's start, else at the time, still (nothing plays, no cue fires); opens the layer (and closes the others: they would hide the screen); a line of a layer's narration opens that layer and places its own timeline at the word or the line; a line of a dialogue scrolls to the dialogue's block (and the player shows the line when it can); scrolls the block into view and outlines it twice (still under reduced motion; `highlight: false` to skip). The page makes its pin ping too.

**`pause`** and **`resume`**: comment mode pauses the narration; while it holds it, a screen that starts playing (`go`, the reviewer's Next) is paused at once. `resume` plays it again only if it was playing when held (or a screen tried to start meanwhile).

**`layout`**: the margin the page keeps on the right, for a floating panel: `{ "type": "layout", "id": "l1", "inset": { "right": 352 } }` (CSS px of the module's frame; `0` gives it back). The module centres its column in the room left **without changing its size** when it fits there (the column and the screen's side padding within `frame.width - right`), and does not move otherwise (`inset.shifted` in the `layout` answer says which). Header, footer, backdrop and full-bleed screens do not move. It holds on every screen until changed.

**`measure`**: what a frame of another size would give: `{ "type": "measure", "id": "m1", "frame": { "width": 1150, "height": 789 } }` → `measured`. For the docking rule (below). The page can also compute it from `layout` (`widestColumn` in review-protocol.ts) without a message; `measure` reads the course's own cap and padding.

**`scroll`**: a wheel turned over the page's overlay (comment mode lays a layer over the module to take the pointer): `{ "type": "scroll", "by": { "x": 0, "y": 120 }, "at": { "x": 640, "y": 300 } }` (CSS px of the module's viewport). What can scroll that way under `at` scrolls, else the page; a `blocks` message follows.

## The anchor

The contract with the comments API of Elabora's hosting. The page builds it with `anchorFor(ready, location, frame, pointed)`; `go` takes it back.

```ts
{ version, language, screen /* key D4 */, block?, step?, layer?, time? /* s */, line?, word? /* D28 */, occurrence?,
  said?, speaker?, point?: { x, y } /* 0..1 in the block's box, or the frame's without a block */, frame: { width, height } }
```
- `version`: `course.version` of `ready`; with `build.id`, the page knows the build commented (a comment on an older version is marked « v2 »).
- `screen`: the permanent key; `block`: the block's id (renames are in the course's journal: the app re-anchors).
- `time`, `line`, `word`, `occurrence`: the moment on a timed screen, from `location`. `go` prefers the word, then the line, then the time, so a comment survives a new take (D28).
- `said`, `speaker`: the line's text and speaker as the module showed them (`location`), so that the page, the app and the author's AI say who said what without the module. `said` is at most 280 characters (`SAID_MAX`): a longer line is cut around the word, at spaces, with « … » (`saidAround`). The comments API keeps them as unknown fields (its anchor is at most 4 KiB).
- **`occurrence`** is an addition to the shared contract: which time `word` is said in the line, when it is said more than once (`ni … ni`); left out for the first. It is the `occurrence` of the format's anchors (D28).
- `point`: where the reviewer clicked, relative to the block's box (so the pin returns to the same place at any size), or to the frame for « Écran entier »; absent when nothing was pointed.
- `frame`: the module's frame, rounded to the pixel: a remark at 375 px is not a remark at 1600 × 900.
- The fields are written in this order (`anchorFor`), for stable JSON.

## What the page does with each message
- **`ready`**: the bar's version (« Version 3 · 7 oct. » from the comments API's record of `build.id`), the language menu from `languages`, « Écran 15 sur 25 » and the list of screens from `screens` (the screen number from `location.index`).
- **`layout`**: the docking rule (decided on 14 October 2026): **dock** the panel when docking changes neither the text size nor the widest column (`measure` the docked frame, or compute it, and compare `fontSize` and `widest`); **else float**, and send `layout { inset: { right: <panel width + gap> } }` so the module moves its column into the free margin; **if it does not move** (`inset.shifted: false`), the panel floats over the edge, folded at first. Place a floating panel between `chrome.top` and `frame.height - chrome.bottom`. Apply the rule to the window (on resize), not screen by screen.
- **`location`**: the panel follows (« Cet écran »), the counter, and the composer's « À 0:10, quand Marc dit « … » » on a narrated screen. Keep the last one to build the anchor.
- **`key`**: what the page's own C does (comment mode), when no menu or dialog of the page is open.
- **`blocks`**: in comment mode, an overlay over the iframe takes the pointer: on each move, `blockAt(blocks, point)` gives the block under it (no message), outlined with its `name`; a click builds the anchor (`anchorFor`) and opens the composer; « Sur » offers the block, its `parent`, « Écran entier ». Tab goes through the visible blocks by `order`. Pins: at `rect` + `point` of each comment's block on this screen, layer and step (or on the screen's edge with « retiré dans la version 3 » when the block is gone); they follow the blocks as new `blocks` messages come (scrolling). In scroll presentation, comments above or below the view are those whose block's `rect` is out of the frame.
- **`went`**: a pin to ping; `missing` to say what moved (a block removed, a word no longer said).

## A minimal host page

```html
<!doctype html>
<meta charset="utf-8">
<title>Revue</title>
<iframe id="module" src="https://demo.elabora.page/diagnostic-reseau/" style="width:100%;height:calc(100vh - 46px);border:0"></iframe>
<script type="module">
  const PROTOCOL = 'elabora-review/1';
  const MODULE = 'https://demo.elabora.page';
  const frame = document.getElementById('module');
  const state = {};
  const send = (message) => frame.contentWindow.postMessage({ protocol: PROTOCOL, ...message }, MODULE);

  window.addEventListener('message', (event) => {
    if (event.origin !== MODULE || event.source !== frame.contentWindow || event.data?.protocol !== PROTOCOL) return;
    state[event.data.type] = event.data; // ready, layout, location, blocks, went, measured
    if (event.data.type === 'ready') console.log(`${event.data.course.title}, version ${event.data.course.version}`);
  });
  frame.addEventListener('load', () => send({ type: 'hello' }));

  // Comment mode: the narration pauses; a click on the overlay becomes an anchor.
  function comment(point /* in the frame's viewport */) {
    send({ type: 'pause' });
    const block = blockAt(state.blocks.blocks, point);
    return anchorFor(state.ready, state.location, state.layout.frame, { block, point });
  }
  // Going to a comment.
  const show = (anchor) => send({ type: 'go', id: crypto.randomUUID(), anchor });
  // A floating panel of 352 px.
  const float = () => send({ type: 'layout', inset: { right: 352 } });
  // blockAt and anchorFor: @elabora/player/review-protocol (copy them, or bundle that file).
</script>
```

## Limits
- The module learns of the narration's time a few times a second (a timer while a timed screen is shown); a `location` while it plays comes with each new word.
- Panels of the course's layers (`presentation: panel`) open on the right, under a floating review panel; they do not move with the column.
- `measure` and `widest` assume the screen's side padding in rem as at the current size (a theme that changes it with the frame's size is read at the current one), and the phones' smaller padding is not applied.
- `go` to a block inside a free object is the object: free objects do not report their parts.
