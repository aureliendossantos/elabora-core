# Delivery: SCORM 1.2 and the LMS emulator

## Package
`elabora build` produces `dist/<id>-<version>-scorm12.zip`, `.report.json` (machine-readable build report) and `.proof.md` (proof dossier). The ZIP is deterministic and contains:

```
imsmanifest.xml            SCORM 1.2, one SCO, schemaversion 1.2, masteryscore if set
index.html                 launch file
elabora/player.js|css        player (Apache-2.0)
elabora/course.js            compiled course (window.ELABORA_COURSE)
elabora/object-frame.js      sandbox bridge for free objects
elabora/vendor/three-r186.js three.js r186 (MIT) when a free object needs it
assets/…                   media referenced by blocks only
objects/<id>/…             compiled free objects and their frames
```

## Runtime behaviour

| Topic | Behaviour | [LMS checklist](diagnostics.md#rules) |
|---|---|---|
| API discovery | Parent frames (up to 12 levels), then `top.opener`, `top.opener.opener` and their parents. The content never opens a window. | 6 |
| Initialise | Once. Never after `LMSFinish` (back-forward cache restore shows a message instead). | 5 |
| Commits | After every significant change (coalesced in the same tick), on `visibilitychange: hidden`, on `pagehide`, every `heartbeatSeconds`. Identical values are not re-sent. | 1, 12 |
| Exit | `cmi.core.exit = suspend` from the start; `""` after completion only if `exitAfterCompletion: normal`. Never `logout`. | 1 |
| Quit | Visible button: commit, `LMSFinish`, end message. | 1 |
| Status | `reportAs` pair; final status sent when decided; no regression; score 0–100 sent when every scored item is decided. | 13 |
| Interactions | Quizzes and decisions as `choice` with letters; fill-ins one per blank (`fill-in` typed, `choice` from menus and words to place), sorts as `matching` (`1.a,2.c`) or `sequencing` (`b,a,c`), reflections as `fill-in` (255 characters, one line) or `likert`; free-object events as declared (choices with non-letter responses become `performance`). | — |
| Time | `cmi.core.session_time` (HHHH:MM:SS.SS) at every commit. | 14 |
| State | Compact keyed JSON; worst case checked at build against the strictest profile. | 3, 7 |

Not in 0.1: `cmi.objectives` (SuccessFactors requires pre-existing ids), SCORM 2004, cmi5, xAPI, LTI, dispatch/proxy mode.

## LMS profiles
`profiles/*.json` (schema `lms-profile`) document, with sources and dates, what each LMS accepts: standards, launch topology, `suspend_data` limits and enforcement, mastery override, package limits, update family, cookies. Values marked unknown are listed in `toMeasure` and printed as warnings: they must be measured in a real instance. Run `elabora profiles`.

## Emulator (`elabora test`)
For each profile × launch mode × browser variant, a fake LMS page (scorm-again `Scorm12API` plus the profile quirks) launches the package and runs:

1. API found in this topology; one `LMSInitialize`; no `unload`/`beforeunload` listener and no synchronous XHR in the content.
2. Navigation with the real Next button; abrupt close (no beforeunload) — the LMS must already hold `lesson_location`, `suspend_data` and `exit = suspend`.
3. Relaunch: the learner is back on the same screen.
4. Completion through the real UI (correct answers): expected status and score 100.
5. Quit: `LMSFinish` called; no `LMSSetValue` rejected (e.g. suspend data above the profile limit).
6. Review session after completion: the status does not regress.
7. axe-core (WCAG 2.2 A/AA) on every screen before and after answering (first run only).

Chromium runs twice: with `unload` deprecated and with it allowed. Firefox and WebKit run with `--browser firefox,webkit` after `npx playwright install firefox webkit`. Any SCORM 1.2 ZIP (Storyline, Rise…) can be checked with `elabora test --package file.zip` (generic checks: initialise, unload listeners, rejected values, data committed before close).

## Preview (`elabora preview`)
The preview serves the course standalone and in the emulator's page, which plays the course's LMS (`delivery.lms`, the first; `--profile` for another) and launches it in a frame as that LMS does (an LMS that opens a window of its own is played in a frame too). Pages reload after each rebuild: in the emulator, its page reloads, as a learner relaunching, back on the screen shown and its step, at the same scroll (a screen taken out of the course, or renamed without its key: the one now at its place). The preview keeps its own lock while it runs: `elabora.lock.json` as it was, then the keys of what is added since. It writes no lock (only a delivery does), and a screen added between two rebuilds, before others that have no key in the project's lock yet, leaves their keys, and the learner's place and answers, as they were. `--navigation free` builds it with every screen open, whatever the course's rules (the web target's free navigation, D41); a running preview switches with `setNavigation` (the desktop app's « Déverrouiller la progression »).

Shown in a frame (the desktop app's Aperçu), the emulator's page tells its parent page what happens, with `postMessage` messages `{ type: 'elabora/lms', kind, … }`:

| `kind` | When | What |
|---|---|---|
| `session` | the page starts | `session`: the registration, launch mode, profile (`id`, `name`, its own launch mode), `suspend_data` limit and enforcement, `entry` (`ab-initio` or `resume`) and what the LMS gave back (`location`, `status`, `suspendData`, or `null`) |
| `call` | every API call | `call`: its time, method, arguments and result, as `window.__lmsLog` keeps them |
| `course` | each course the page shows | `course`: the course data (`window.__elabora.course`) |
| `state` | every commit, and when asked | `state`: `window.__elabora.state()` (screen, step, status, score, `suspendData`, the variables' values) |
| `events` | events run | `entries`: new entries of `window.__elabora.trace` (the trigger's type and what happened, the screen, and each event whose trigger matched, with whether its conditions held) |

The parent sets a variable with `{ type: 'elabora/lms-ask', ask: 'set-variable', id, value }`: its « when it changes » events run as if an event had set it (`__elabora.setVariable`).

## What the emulator cannot prove
It reproduces documented behaviour on top of scorm-again; it is not the LMS. Keep the last two levels of the test pyramid: a smoke test in SCORM Cloud and a test learner in the client's LMS, then update the profile's `toMeasure` fields with what you measured.
