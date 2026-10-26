# Contributing to Elabora core

Thank you for looking at the code. This page says how to set up a checkout, what every change must keep true, and how the documentation stays in step with the code.

## Set up

```bash
git clone https://github.com/aureliendossantos/elabora-core.git
cd elabora-core
npm install
node bin/elabora.js help
```

Node 24 or later runs the TypeScript sources directly: there is no build step. ffmpeg is needed for media work and a browser for the browser suites; [Getting started](docs/getting-started.md) says where they are found.

[`AGENTS.md`](AGENTS.md) is the map of the repository, package by package, and the rules every change follows. It is written for coding agents and holds for people too: read it before a first change. [Architecture](docs/architecture.md) is the contract behind it.

## Tests

```bash
npm test             # unit suite, seconds
npm run typecheck    # strict TypeScript, every package
npm run test:e2e     # Chrome, about a minute
npm run test:matrix  # the LMS matrix and the sample courses, a few minutes
npm run test:all     # the three suites
```

A change is finished when the unit suite, the typecheck and the end-to-end suite pass. Run the matrix as well when a change touches the player, the emulator, the player's layout or a sample course, and before a release.

The unit suite covers the schemas, the validator's rules, the plan, the state codec, the determinism of packages, the compiler, the status machine, edits and undo, LESSON.md, update diffs, the agent interfaces and these docs' links. The end-to-end suite runs the LMS emulator in Moodle with axe-core, checks that a package relying on `unload` is caught and that stuck runs and objects fail instead of hanging, runs the free-object gates (deliberately broken objects included), and checks slides: no layout shift when answering, contrast, captures, steps and resume. The matrix runs the other launch topologies (the SuccessFactors popup chain, Docebo's nested iframe), Chrome with `unload` deprecated and allowed, and the sample courses at desktop and phone widths.

Continuous integration (`.github/workflows/ci.yml`) runs the typecheck and the three suites on Linux for every push to `main` and every pull request, the typecheck and the unit suite on Windows, and everything on macOS weekly and on demand, with GPL builds of ffmpeg. `.github/workflows/docs.yml` checks the documentation on every pull request, including those that change only Markdown.

## Documentation

The documentation is the Markdown of [`docs/`](docs/), plus [`SPEC.md`](SPEC.md) and the [changelog](CHANGELOG.md). There is one copy: GitHub shows it as it is, the site renders the same files at [elabora.studio/en/docs/developers](https://elabora.studio/en/docs/developers/), and `elabora docs` serves them to agents. So:

- **[`docs/index.md`](docs/index.md) is the map.** A new page gets one line there, `- [Title](file.md): what it helps with.`, under its section; the site's navigation, its `llms.txt` and `elabora docs` read it. The test `every docs page is on the map` fails otherwise.
- **Links are relative** (`[components](components.md)`, `[the schemas](../packages/format/schemas/0.1.1/)`): they work on GitHub, and the site turns them into its own pages or into GitHub links. The test `docs links resolve` checks every link and anchor, and every `docs/….md` path and `Dn` named in the code, the skills and the course rules.
- **Generated pages say so in their first lines**: [blocks](docs/blocks.md), [diagnostics](docs/diagnostics.md), [LMS profiles](docs/lms-profiles.md), the [command line](docs/cli.md), the [agent tools](docs/mcp-tools.md) and the [decision index](docs/decisions.md). Change their source (schemas, the code catalogue, profiles, the help, the tools, a decision) and run `npm run docs`; CI fails when a generated page is out of date.
- **A decision** is a new file `docs/decisions/Dnn.md` that starts with `# Dn. Title (date)`: what was decided, why, and *Revisit if:*. Run `npm run docs` to add it to the index. A decision that replaces or revises another says so in both. New runtime dependencies need one.
- **Architecture** lives in [`docs/architecture.md`](docs/architecture.md) and one page per subsystem in [`docs/architecture/`](docs/architecture/). Code comments cite the page and section (`docs/architecture/media.md`).
- Write for a reader who has only the repository: no private notes, people's names or tracker numbers; say what was measured and how instead.

## Pull requests

Keep a pull request to one change, with its tests and its docs. Add an English Sampo changeset for anything a user of the format, the command line or the agent tools would notice; [Core releases](docs/releases.md) explains the format and release PR workflow. Sampo generates the new version's [changelog](CHANGELOG.md). Interfaces recorded in `test/fixtures/` (the help and the agent tool catalogue) are updated with the interface.

## Licence

By contributing, you agree that your contribution is released under the Apache License 2.0 ([`LICENSE`](LICENSE)), like the code and the specification. The original content of the sample courses in [`examples/`](examples/) is released under CC0 1.0 ([D44](docs/decisions/D44.md)).
