# Getting started

Run the core from a checkout: validate, build, test and preview the sample courses, then point an agent at one.

## Requirements

- **Node 24 or later.** The core is TypeScript run directly by Node (type stripping): there is no build step.
- **ffmpeg and ffprobe** for media (imports, narration, quality presets), found through `ELABORA_FFMPEG` and `ELABORA_FFPROBE` or on the `PATH`. Validation and builds of courses without new media do not need them.
- **A browser** for looks, captures, layout checks, LMS tests and free-object gates only. Validation and builds need none.
  - With the Elabora desktop app installed and opened once, these workflows use isolated workers of its own Electron: nothing else to install. The app's bundled command needs no separate Node, Chrome or Edge.
  - Without the app, the default tries Chrome, Edge, then Playwright's downloaded Chromium (`npx --no-install playwright-core install chromium`).
  - `--browser chrome`, `msedge`, `playwright`, `firefox` or `webkit` selects an external engine for package and object tests; `electron` requires the app; `chromium` is the default provider. `ELABORA_BROWSER=external` turns off the discovery of the app for every workflow, and developers can point `ELABORA_ELECTRON_EXECUTABLE` and `ELABORA_ELECTRON_ENTRY` at an Electron executable and the app's browser worker. Results name the engine and version that ran; object baselines are kept per engine and OS. See [Rendering, browsers and captures](architecture/rendering.md).

## Install

```bash
git clone https://github.com/aureliendossantos/elabora-core.git
cd elabora-core
pnpm install --frozen-lockfile
```

`node bin/elabora.js` is the `elabora` command in a checkout; `node bin/elabora.js help` lists every command ([Command line](cli.md)).

## Validate, build and test a sample

[`examples/diagnostic-reseau`](../examples/diagnostic-reseau/) is a short French module: a plan, six screens, a decision, a 3D free object, an assessment and two narrated screens.

```bash
node bin/elabora.js validate examples/diagnostic-reseau --profile moodle,successfactors
```

Every finding has a stable code and a fix ([Diagnostic codes](diagnostics.md)). `--profile` names the target LMSs: their limits apply ([LMS profiles](lms-profiles.md)).

```bash
node bin/elabora.js build examples/diagnostic-reseau --profile moodle,successfactors
```

The build writes `dist/<id>-<version>-scorm12.zip`, a machine-readable report and a proof dossier (plan coverage screen by screen, tracking, accessibility, the human checks still to do). The same sources always give the same bytes. `--target web` adds a module for a plain web server ([Web target](delivery-web.md)).

```bash
node bin/elabora.js test examples/diagnostic-reseau --profile moodle,successfactors,docebo
```

`test` runs the package in an LMS emulator that replays each profile's launch topology, abrupt closes and resume ([SCORM 1.2 and the LMS emulator](delivery-scorm12.md)).

## Look at it

```bash
node bin/elabora.js preview examples/diagnostic-reseau
node bin/elabora.js look examples/diagnostic-reseau --screen simulation
```

`preview` serves the course live, standalone and in the LMS emulator, and reloads after each rebuild. While designing, `look` shows one screen in well under a second once warm (a look server keeps one browser for the course; no build; free objects included). A narrated screen has its timeline: `node bin/elabora.js timeline examples/diagnostic-reseau chemin` lists its steps, lines and cues, and `look … --screen chemin --sheet` draws it as a storyboard.

[`examples/planetary-gearset`](../examples/planetary-gearset/) is an English engineering module that uses the [design layer](design.md) and [components](components.md): layouts, a quiz fork with generated diagrams, maths, numeric questions and a responsive 3D test bench. [`examples/orbital-rendezvous`](../examples/orbital-rendezvous/) and [`examples/medieval-charts`](../examples/medieval-charts/) are two more. [`examples/phishing-by-numbers`](../examples/phishing-by-numbers/) shows the twelve [chart blocks](charts.md) on narrated slides: a short English module on spotting and reporting phishing, told through a fictional company's numbers, whose charts follow an ElevenLabs voice word by word.

## Start a course

```bash
node bin/elabora.js init my-course --id my-course --title "My course" --lang en
```

`init` writes `course.json`, a placeholder `plan.json` and the course's `AGENTS.md`, the rules every agent working on it follows. The [format specification](../SPEC.md) explains each file.

## Work with an agent

Agents work through the same operations, as MCP tools or from the shell:

```bash
node bin/elabora.js mcp examples/diagnostic-reseau            # an MCP server on stdio, scoped to one course
node bin/elabora.js tools list --json                          # the operations and their input schemas
node bin/elabora.js tools call elabora_overview examples/diagnostic-reseau
```

`examples/diagnostic-reseau/` holds a `.mcp.json`: a Claude Code session opened there has the `elabora` tools. Agents start with `elabora_overview`, follow the course's `AGENTS.md` and load the skills served as MCP resources. [Working with an agent](agents.md) explains the transports, and [Agent tools](mcp-tools.md) lists every operation.

## What 0.1 does not do yet

- SCORM 1.2 for LMSs ([D2](decisions/D02.md)) and a web target for static hosting ([D41](decisions/D41.md)); no cmi5, xAPI, LTI or dispatch yet.
- The emulator reproduces documented behaviour on scorm-again; it does not replace a smoke test in SCORM Cloud and a test learner in the client's LMS. Profiles list what remains to be measured.
- Firefox and WebKit runs need their binaries (`npx --no-install playwright-core install firefox webkit`). WebKit passed the LMS and object probes on macOS but differs from Chromium's snapshots; Firefox may be blocked at startup on recent macOS by the protection of its app-data folder.
- Storyline and Rise imports are in beta ([D47](decisions/D47.md)).
- Media encoding was exercised with Homebrew's ffmpeg on macOS (without libwebp, images fall back to JPEG or PNG; without zimg, HDR is converted without tone mapping); Windows encoders are untested.
