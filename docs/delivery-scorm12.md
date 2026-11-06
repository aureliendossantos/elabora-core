# Delivery: SCORM 1.2 and the LMS emulator

## Package

SCORM 1.2 is the format Elabora picks when the course names no LMS, and for Moodle, Totara and Teach Up ([Delivery formats](delivery.md)). `elabora build` writes three files to the course's `dist/` folder: `<id>-<version>-scorm12.zip`, its `.report.json` (the build report for tools) and its `.proof.md` (the proof dossier). The ZIP is deterministic. It holds:

```
imsmanifest.xml               SCORM 1.2, one SCO, schemaversion 1.2, masteryscore when set
index.html                    the launch file
elabora/player.js|css         the player (Apache-2.0)
elabora/theme.css             the course's theme
elabora/course.js             the compiled course (window.ELABORA_COURSE)
elabora/object-frame.js       the sandbox bridge for free objects
elabora/vendor/three-r186.js  three.js r186 (MIT) and its licence, when a free object needs it
theme/…                       the theme's stylesheet and fonts, with their licences
components/…                  the stylesheets of the course's components
assets/…                      the media the course uses
objects/<id>/…                compiled free objects and their frames
```

## Runtime behaviour

The last column gives the line of the [LMS checklist](diagnostics.md#rules) (LMS-n) that each behaviour meets.

| Topic | Behaviour | LMS-n |
|---|---|---|
| API discovery | Parent frames (up to 12 levels), then `top.opener`, `top.opener.opener` and their parents. The content opens no window of its own. | 6 |
| Initialise | Once. A page the browser restores from its back-forward cache after `LMSFinish` shows a message. | 5 |
| Commits | After every significant change (grouped within one tick), on `visibilitychange: hidden`, on `pagehide` and every `heartbeatSeconds`. Only changed values are sent. | 1 |
| Exit | `cmi.core.exit = suspend` from the start. After completion, `""` when `exitAfterCompletion` is `normal`. `logout` is left unused. | 1 |
| Quit | A visible button: commit, `LMSFinish`, then an end message. | 1 |
| Status | Follows the `reportAs` pair. The final status is sent once decided and never regresses. The score (0–100) is sent once every scored item is decided. | 13 |
| Interactions | Quizzes and decisions as `choice` with letters. Fill-ins one per blank (`fill-in` when typed, `choice` from menus and words to place). Sorts as `matching` (`1.a,2.c`) or `sequencing` (`b,a,c`). Reflections as `fill-in` (255 characters, one line) or `likert`. Free-object events as declared (choices with responses other than letters become `performance`). | — |
| Time | `cmi.core.session_time` (HHHH:MM:SS.SS) at every commit. | 14 |
| State | Compact keyed JSON. The build checks its worst case against the strictest target profile. | 3, 7 |

Other formats: [Delivery formats](delivery.md) (SCORM 2004, and how Elabora picks a format). `cmi.objectives` (SuccessFactors requires ids created beforehand), LTI and dispatch or proxy mode come later.

## LMS profiles

`profiles/*.json` (schema `lms-profile`) record what each LMS accepts, with sources and dates: standards, launch topology, `suspend_data` limits and how they are enforced, mastery override, package limits, how updates behave, cookies. Values still unknown are listed in `toMeasure` and printed as warnings, to be measured in a real instance. Run `elabora profiles` to list them, and read [LMS profiles](lms-profiles.md) for the details.

## Emulator (`elabora test`)

```bash
elabora test examples/phishing-by-numbers --profile moodle,successfactors
```

For each profile, launch mode and browser variant, a fake LMS page (scorm-again's `Scorm12API` plus the profile's quirks) launches the package and checks:

1. The API is found in this topology, `LMSInitialize` runs once, and the content has no `unload`/`beforeunload` listener and no synchronous XHR.
2. Navigation with the real Next button, then an abrupt close with no `beforeunload`: the LMS already holds `lesson_location`, `suspend_data` and `exit = suspend`.
3. Relaunch: the learner is back on the same screen.
4. Completion through the real interface with the correct answers: the expected status and a score of 100.
5. Quit: `LMSFinish` is called and the LMS accepts every `LMSSetValue` (a suspend data above the profile's limit would be rejected).
6. A review session after completion: the status holds.
7. axe-core (WCAG 2.2 A and AA) on every screen, before and after answering, on the first run.

After the runs, `test` measures the course at its fit sizes and adds the results to the build report.

Chromium runs twice: with `unload` deprecated and with it allowed. Run Firefox and WebKit with `--browser firefox,webkit`, after `pnpm exec playwright-core install firefox webkit`.

`elabora test --package file.zip` checks any SCORM 1.2 ZIP, from Storyline, Rise or elsewhere, with the generic checks: initialise, unload listeners, rejected values, and data committed before the close.

## Preview (`elabora preview`)

```bash
elabora preview examples/canal-locks
```

The preview serves the course on its own and inside the emulator's page. The emulator plays the course's LMS (the first of `delivery.lms`, or `--profile`) and launches the course in a frame as that LMS does. An LMS that opens its own window is played in a frame too.

Pages reload after each rebuild. In the emulator, the page reloads like a learner relaunching: back on the same screen, step and scroll position. When that screen was removed, or renamed without its key, the learner lands on the screen now in its place.

The preview keeps its own copy of the lock while it runs: `elabora.lock.json` as it was, plus the keys of what was added since. Only a delivery writes the lock. So a screen added between two rebuilds, before screens that have no key yet, leaves their keys, the learner's place and the answers as they were.

`--navigation free` opens every screen, whatever the course's rules (the web target's free navigation, D41). A running preview switches with `setNavigation`, as the desktop app's « Déverrouiller la progression » does.

### Messages to a parent page

When the emulator's page runs in a frame (the desktop app's Aperçu), it tells its parent what happens with `postMessage` messages `{ type: 'elabora/lms', kind, … }`:

| `kind` | When | What |
|---|---|---|
| `session` | the page starts | `session`: the registration, launch mode, profile (`id`, `name`, its own launch mode), `suspend_data` limit and enforcement, `entry` (`ab-initio` or `resume`) and what the LMS gave back (`location`, `status`, `suspendData`, or `null`) |
| `call` | every API call | `call`: its time, method, arguments and result, as `window.__lmsLog` keeps them |
| `course` | each course the page shows | `course`: the course data (`window.__elabora.course`) |
| `state` | every commit, and on request | `state`: `window.__elabora.state()` (screen, step, status, score, `suspendData`, the variables' values) |
| `events` | events run | `entries`: new entries of `window.__elabora.trace` (the trigger's type and what happened, the screen, and each event whose trigger matched, with whether its conditions held) |

The parent sets a variable with `{ type: 'elabora/lms-ask', ask: 'set-variable', id, value }`. Its « when it changes » events run as if an event had set it (`__elabora.setVariable`).

## Beyond the emulator

The emulator reproduces documented LMS behaviour on top of scorm-again. Two checks remain before delivery: a smoke test in SCORM Cloud, then a test learner in the client's LMS. Record what you measured in the profile's `toMeasure` fields.
