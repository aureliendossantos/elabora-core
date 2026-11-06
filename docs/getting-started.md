# Getting started

Clone the core, check and build a sample course, then open it in your browser. Then start a course of your own and hand it to an agent.

## Requirements

- **Node 24** or later.
- **pnpm 11**: `npm install -g pnpm`.
- **A browser** for looks, layout checks and LMS tests. Elabora uses the Elabora desktop app's own engine once the app has been opened, else Chrome, Edge or Playwright's Chromium ([Browsers](#browsers)).
- **ffmpeg and ffprobe** on the `PATH` for media: imports, narration and quality presets. Validation and builds only need them for new media.

## Install

```bash
git clone https://github.com/aureliendossantos/elabora-core.git
cd elabora-core
pnpm install
```

Node runs the TypeScript directly. In a checkout, `node bin/elabora.js` is the `elabora` command. Run `node bin/elabora.js help` to list every command ([Command line](cli.md)).

## Validate a sample

[`examples/canal-locks`](../examples/canal-locks/) is a five-minute English module on how canal locks work: four slides, a 3D lock the learner operates, a cross-section and a dialogue with a lock keeper.

```bash
node bin/elabora.js validate examples/canal-locks --profile moodle,successfactors
```

Each finding has a stable code and a fix ([Diagnostic codes](diagnostics.md)). `--profile` names the LMSs you deliver to, and applies their limits ([LMS profiles](lms-profiles.md)).

## Build a package

```bash
node bin/elabora.js build examples/canal-locks --profile moodle,successfactors
```

The build writes three files to the course's `dist/` folder:

- `canal-locks-0.1.0-scorm12.zip`, the package for your LMS, in SCORM 1.2: the course names no LMS, and every LMS takes SCORM 1.2 ([Delivery formats](delivery.md): with `delivery.lms` set, Elabora picks the best format for that LMS);
- `canal-locks-0.1.0-scorm12.report.json`, the build report for tools;
- `canal-locks-0.1.0-scorm12.proof.md`, the proof dossier: plan coverage screen by screen, tracking, accessibility and the checks left to a person.

The same sources always give the same bytes. Add `--target web` for a module you serve from any web server ([Web target](delivery-web.md)).

## Preview it

```bash
node bin/elabora.js preview examples/canal-locks
```

Open the first address it prints. The second one shows the course inside the LMS emulator. Pages reload after each change to the course's files. Press Ctrl+C to stop.

## Look at one screen

```bash
node bin/elabora.js look examples/canal-locks --screen lock-lab
```

`look` writes a capture of the screen to the course's `.elabora/look/` folder. The first look starts a look server that keeps a browser open for the course. The next looks take well under a second.

On a narrated screen, `timeline` lists the steps, lines and cues, and `--sheet` draws them as a storyboard:

```bash
node bin/elabora.js timeline examples/phishing-by-numbers funnel
node bin/elabora.js look examples/phishing-by-numbers --screen funnel --sheet
```

## Test in the LMS emulator

```bash
node bin/elabora.js test examples/canal-locks --profile moodle,successfactors
```

`test` builds the package, then runs it in an LMS emulator. Each profile replays its LMS's launch modes, an abrupt close and a resume ([SCORM 1.2 and the LMS emulator](delivery-scorm12.md)). It takes a few minutes.

## More samples

| Sample | Language | What it shows |
|---|---|---|
| [`canal-locks`](../examples/canal-locks/) | English | A 3D free object reused on every slide, a dialogue, a French translation |
| [`phishing-by-numbers`](../examples/phishing-by-numbers/) | English | The twelve [chart blocks](charts.md) on narrated slides, following the voice word by word |
| [`coffee-in-brief`](../examples/coffee-in-brief/) | English | A scroll course that uses every [starter block](blocks.md) and each of its presentations |
| [`clockwork`](../examples/clockwork/) | English | One 3D object that carries on from screen to screen ([continuity](free-object-contract.md)), controls that change with each screen, a numeric question, a French translation |
| [`orbital-rendezvous`](../examples/orbital-rendezvous/) | English | Orbits on slides, with a 3D phasing lab |
| [`medieval-charts`](../examples/medieval-charts/) | English | A scroll course on medieval sea charts |
| [`diagnostic-reseau`](../examples/diagnostic-reseau/) | French | A plan, a decision, a 3D simulation, an assessment and three narrated screens |

## Start a course

```bash
node bin/elabora.js init my-course --id my-course --title "My course" --lang en
```

`init` writes `course.json`, a starter `plan.json`, a first screen and `AGENTS.md`: the rules every agent working on the course follows. The [format specification](../SPEC.md) explains each file.

To start from a ready-made look, list the module templates and pick one ([D68](decisions/D68.md)):

```bash
node bin/elabora.js templates
node bin/elabora.js init my-course --template flow --id my-course --title "My course" --lang en
```

Each template gives a charter (theme, fonts, components, an animated backdrop and its variants) and the same 14 screens of placeholder text. Templates come in English and French. The course's `README.md` explains its charter and how to make it a brand's.

To reuse the look of a course you already have, create a blank course in its charter ([D69](decisions/D69.md)). It copies the theme, fonts, components, backdrop and player bars, and starts with one screen:

```bash
node bin/elabora.js projects create --title "My course" --charter examples/canal-locks
```

`projects create` writes the course to the Elabora library (`node bin/elabora.js projects path` prints where). `--charter` takes a library project's id or a course folder, absolute or relative to the folder you run the command in.

## Work with an agent

Agents use the same operations as the command line, as MCP tools or from the shell:

```bash
node bin/elabora.js mcp examples/canal-locks                       # an MCP server on stdio for one course
node bin/elabora.js tools list --json                              # every operation and its input schema
node bin/elabora.js tools call elabora_overview examples/canal-locks
```

Open a Claude Code session in [`examples/diagnostic-reseau`](../examples/diagnostic-reseau/) to try it: its `.mcp.json` connects the `elabora` tools. An agent starts with `elabora_overview`, follows the course's `AGENTS.md` and loads the skills it needs. [Working with an agent](agents.md) explains the options, and [Agent tools](mcp-tools.md) lists every operation.

## Browsers

Elabora looks for a browser in this order:

1. The Elabora desktop app's own Electron, once the app has been installed and opened. The app's bundled `elabora` command brings its own Node and browser.
2. Chrome, then Edge.
3. Playwright's Chromium: `pnpm exec playwright-core install chromium`.

`--browser chrome`, `msedge`, `playwright`, `firefox` or `webkit` picks an engine for `test` and `object test`. `electron` asks for the app's engine. `ELABORA_BROWSER=external` skips the app for every command. App developers can point `ELABORA_ELECTRON_EXECUTABLE` and `ELABORA_ELECTRON_ENTRY` at an Electron executable and the app's browser worker. Results name the engine and version that ran, and object baselines are kept per engine and OS. [Rendering, browsers and captures](architecture/rendering.md) has the details.

Elabora finds ffmpeg and ffprobe on the `PATH`. Set `ELABORA_FFMPEG` and `ELABORA_FFPROBE` to use other binaries.

## What 0.1 does not do yet

- Elabora delivers SCORM 1.2, SCORM 2004, cmi5 and xAPI for LMSs ([D2](decisions/D02.md), [Delivery formats](delivery.md)) and a web target for static hosting ([D41](decisions/D41.md)). LTI and dispatch come later.
- The emulator reproduces documented LMS behaviour on top of scorm-again. Before delivery, still run a smoke test in SCORM Cloud and a test learner in the client's LMS. Each profile lists the values still to measure.
- Firefox and WebKit need their binaries: `pnpm exec playwright-core install firefox webkit`. WebKit passed the LMS and object probes on macOS, with snapshots that differ from Chromium's. On recent macOS, the protection of Firefox's app-data folder may block it at startup.
- Storyline and Rise imports are in beta ([D47](decisions/D47.md)).
- Media encoding was tested with Homebrew's ffmpeg on macOS. Without libwebp, images fall back to JPEG or PNG. Without zimg, HDR video is converted without tone mapping. Windows encoders are untested.
