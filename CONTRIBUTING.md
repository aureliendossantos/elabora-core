# Contributing to Elabora core

Thank you for looking at the code. This page shows how to set up a checkout, run the tests and keep the docs in step.

## Set up

You need Node 24 and pnpm 11 (`npm install -g pnpm`; `package.json` names the exact version).

```bash
git clone https://github.com/aureliendossantos/elabora-core.git
cd elabora-core
pnpm install
node bin/elabora.js help
```

Node runs the TypeScript sources directly, so there is no build step. Media work needs ffmpeg, and the browser suites need Chrome, Edge or Chromium: [Getting started](docs/getting-started.md) says where Elabora finds them.

Read [`AGENTS.md`](AGENTS.md) before a first change. It maps the repository package by package and lists the rules every change follows. It is written for coding agents and holds for people too. [Architecture](docs/architecture.md) is the contract behind it.

## Tests

```bash
pnpm run test:file -- test/unit/edit.test.ts   # one file, a few seconds
pnpm test                # the unit suite, two to five minutes
pnpm run typecheck       # strict TypeScript, every package
pnpm run test:e2e        # in Chrome, tens of minutes
pnpm run test:matrix     # the LMS matrix and the sample courses, a few minutes
pnpm run test:all        # the three suites
pnpm run test:affected   # typecheck, unit suite, and the e2e and matrix files of what you changed
```

Run the test file of what you change while you work. Before you open a pull request, run `pnpm run test:affected`. It runs the typecheck, the unit suite, and the end-to-end and matrix files that cover your changes (mapped in `test/groups.ts`). The full suites run on main and before each release.

What each suite covers:

- **Unit:** schemas, validation rules, the plan, the state codec, deterministic packages, the compiler, edits and undo, LESSON.md, update diffs, the agent interfaces and the links of these docs.
- **End-to-end:** the LMS emulator in Moodle with axe-core, packages that rely on `unload`, runs and objects that get stuck, the free-object gates (with deliberately broken objects), and slides: layout shifts, contrast, captures, steps and resume.
- **Matrix:** the other launch modes (the SuccessFactors popup chain, Docebo's nested iframe), Chrome with `unload` deprecated and allowed, and the sample courses at desktop and phone widths.

Continuous integration (`.github/workflows/ci.yml`) runs the typecheck and the three suites on Linux and macOS for every push to `main` and every pull request, as parallel jobs (the unit suite; the e2e suite and the matrix, each in two halves), with GPL builds of ffmpeg. It runs the typecheck and the unit suite on Windows. A 3D object's gates (a boot budget, 60 s a step) need a real computer: they run on a developer's Mac, not on CI's runners. The app's batch run skips the core's suites on a commit where it is green. `.github/workflows/docs.yml` checks the docs on every pull request.

## Documentation

The docs are the Markdown of [`docs/`](docs/), with [`SPEC.md`](SPEC.md) and the [changelog](CHANGELOG.md). One copy serves everyone: GitHub shows it, the site renders it at [elabora.studio/en/docs/developers](https://elabora.studio/en/docs/developers/), and `elabora docs` serves it to agents.

- **Add a new page to [`docs/index.md`](docs/index.md)**, under its section: `- [Title](file.md): what it helps with.` The site, its `llms.txt` and `elabora docs` read this map. The test `every docs page is on the map` checks it.
- **Use relative links**, such as `[components](components.md)`. They work on GitHub and the site. The test `docs links resolve` checks every link and anchor, and every `docs/….md` path and decision number the code cites.
- **Edit the source of a generated page**, then run `pnpm run docs`. Generated pages say so in their first lines: [blocks](docs/blocks.md), [diagnostics](docs/diagnostics.md), [LMS profiles](docs/lms-profiles.md), the [command line](docs/cli.md), the [agent tools](docs/mcp-tools.md) and the [decision index](docs/decisions.md). CI fails when one is out of date.
- **Record a decision** in a new file `docs/decisions/Dnn.md` that starts with `# Dn. Title (date)`. Say what was decided, why, and *Revisit if:*. Then run `pnpm run docs` to add it to the index. A decision that revises another says so in both. A new runtime dependency needs one.
- **Describe the architecture** in [`docs/architecture.md`](docs/architecture.md) and the pages of [`docs/architecture/`](docs/architecture/). Code comments cite the page (`docs/architecture/media.md`).
- **Write for a reader who has only the repository.** Say what was measured and how. Leave out private notes, people's names and tracker numbers.

## Pull requests

Keep each pull request to one change, with its tests and its docs. Add an English Sampo changeset when a user of the format, the command line or the agent tools would notice the change:

```bash
pnpm exec sampo add -p npm/elabora -p npm/@elabora/core -b patch -t Fixed -m "Explain the corrected behaviour."
```

[Core releases](docs/releases.md) explains changesets and releases. Sampo writes the [changelog](CHANGELOG.md) of each new version. When you change the help or the agent tools, update their recorded copies in `test/fixtures/`.

## Licence

By contributing, you agree to release your contribution under the Apache License 2.0 ([`LICENSE`](LICENSE)), like the code and the specification. The original content of the sample courses in [`examples/`](examples/) is CC0 1.0 ([D44](docs/decisions/D44.md)).
