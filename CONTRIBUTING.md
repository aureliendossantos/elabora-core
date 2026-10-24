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

[`AGENTS.md`](AGENTS.md) is the map of the repository, package by package, and the rules every change follows. It holds operational instructions for agents; the standards on this page apply to everyone. [Architecture](docs/architecture.md) is the contract behind it.

## Tests

- Test observable behaviour: public results, events, persisted content and visible output. A behaviour-preserving refactor must keep tests green. Check decoded captures and restored files rather than byte quotas, private caches or animation objects. Assert ordering and counts only when they are documented behaviour.
- Use real domain objects and small fixtures. Fake only uncontrolled boundaries such as services, subprocesses, clocks and randomness; prefer stateful fakes. Assert outcomes and unchanged data after refusals, rather than mock calls.
- Name each test after one behaviour. Arrange its own inputs, act, then assert; use named table cases for variations. Remove duplicates only when every distinct behaviour remains checked. Coverage and assertion counts are not targets.
- Own temporary data and processes immediately, register failure cleanup, and restore globals/environment. Give each case fresh service quota/cache state and its own prerequisites. Isolate process-lifetime registries in a child process when no public reset exists.
- Await completion, browser events or protocol acknowledgements; subscribe before acting. Never use sleep or elapsed-time budgets to synchronize. Use scoped virtual clocks for timers and fixed timestamps or reported seeds for generated data. A timeout only bounds failure. Await watcher readiness before writes and stop watchers before removing their folders.
- Use property tests for invariants and explicit boundary cases; add a regression test for every bug fix. Check complete persisted state and diagnostic codes/paths. Propose substantial production refactors for testability before applying them; never weaken assertions or add skips to hide failures.

```bash
npm test             # unit and filesystem/service integration tests
npm run typecheck    # strict TypeScript, including tests
npm run test:e2e     # browser behaviour
npm run test:matrix  # LMS launch modes and sample courses
```

Before finishing, pass unit tests, typecheck and e2e. Run the matrix for player, emulator, layout or sample changes and before releases. Repeat changed async tests and complete suites in native random order. On Node 24.19+, use `node --test --test-random-seed=104729 --test-global-setup=test/isolate.ts "test/unit/*.test.ts"`; record seeds, failures and unavailable checks in the [cleanup ledger](TEST-CLEANUP.md). Shuffling file arguments alone does not randomize execution.

CI (`.github/workflows/ci.yml`) runs all three suites and typecheck on Linux, unit tests and typecheck on Windows, and all checks on macOS weekly and on demand. The docs workflow also checks Markdown-only changes.

## Documentation

The documentation is the Markdown of [`docs/`](docs/), plus [`SPEC.md`](SPEC.md) and the [changelog](CHANGELOG.md). There is one copy: GitHub shows it as it is, the site renders the same files at [elabora.studio/en/docs/developers](https://elabora.studio/en/docs/developers/), and `elabora docs` serves them to agents. So:

- **[`docs/index.md`](docs/index.md) is the map.** A new page gets one line there, `- [Title](file.md): what it helps with.`, under its section; the site's navigation, its `llms.txt` and `elabora docs` read it. The test `every docs page is on the map` fails otherwise.
- **Links are relative** (`[components](components.md)`, `[the schemas](../packages/format/schemas/0.1/)`): they work on GitHub, and the site turns them into its own pages or into GitHub links. The test `docs links resolve` checks every link and anchor, and every `docs/….md` path and `Dn` named in the code, the skills and the course rules.
- **Generated pages say so in their first lines**: [blocks](docs/blocks.md), [diagnostics](docs/diagnostics.md), [LMS profiles](docs/lms-profiles.md), the [command line](docs/cli.md), the [agent tools](docs/mcp-tools.md) and the [decision index](docs/decisions.md). Change their source (schemas, the code catalogue, profiles, the help, the tools, a decision) and run `npm run docs`; CI fails when a generated page is out of date.
- **A decision** is a new file `docs/decisions/Dnn.md` that starts with `# Dn. Title (date)`: what was decided, why, and *Revisit if:*. Run `npm run docs` to add it to the index. A decision that replaces or revises another says so in both. New runtime dependencies need one.
- **Architecture** lives in [`docs/architecture.md`](docs/architecture.md) and one page per subsystem in [`docs/architecture/`](docs/architecture/). Code comments cite the page and section (`docs/architecture/media.md`).
- Write for a reader who has only the repository: no private notes, people's names or tracker numbers; say what was measured and how instead.

## Pull requests

Keep a pull request to one change, with its tests and its docs. Add an English Sampo changeset for anything a user of the format, the command line or the agent tools would notice; [Core releases](docs/releases.md) explains the format and release PR workflow. Sampo generates the new version's [changelog](CHANGELOG.md). Interfaces recorded in `test/fixtures/` (the help and the agent tool catalogue) are updated with the interface.

## Licence

By contributing, you agree that your contribution is released under the Apache License 2.0 ([`LICENSE`](LICENSE)), like the code and the specification. The original content of the sample courses in [`examples/`](examples/) is released under CC0 1.0 ([D44](docs/decisions/D44.md)).
