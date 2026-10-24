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

- Test observable behaviour through public APIs, returned values, emitted events, persisted files or rendered output. A behaviour-preserving refactor must keep tests green. Compare content, not cache identity; replay a diff instead of pinning its chosen operation sequence. Assert ordering or call counts only for documented contracts, such as lock exclusion, restart ordering or request coalescing.
- Use real domain objects and small fixtures. Replace only uncontrolled boundaries (network/services, OS/processes, clock and randomness); prefer stateful fakes to mock-call scripts. Assert the resulting behaviour, including failures and unchanged data after a refusal.
- Give each test one behaviour and a name explaining it. Arrange its own inputs, act, then assert. Use named table cases for variations of that behaviour; share setup without hiding the action or expected outcome.
- Keep tests independent: isolated temporary data, cleanup registered before the action, restored environment/globals and test-scoped fake clocks. Await completion or a subscribed event with a bounded failure timeout; never sleep to guess when work has finished. Pass fixed timestamps through public clock options and use seeded generators that report the seed. Do not mix a globally frozen Date with real process-lifetime lock checks. A filesystem watcher must acknowledge readiness before the first tested write; stop it before deleting its folder.
- Check invariants with property tests (for example diff/apply/invert and encode/decode round trips), plus explicit boundary cases. Add a regression test for every bug fix. Coverage percentages and assertion counts are not targets.
- Remove duplicates and tautologies only when each real behaviour remains checked. Check complete persisted state and identify diagnostic codes/targets/paths rather than checking only a count. Do not weaken assertions or replace a test with a skip to make a run green. Propose substantial production refactors for testability before applying them.

```bash
npm test             # unit and filesystem/service integration tests
npm run typecheck    # strict TypeScript, including tests
npm run test:e2e     # browser behaviour
npm run test:matrix  # LMS launch modes and sample courses
```

Before finishing, pass unit tests, typecheck and e2e. Also run the matrix for player, emulator, layout or sample changes and before releases. Repeat changed async tests and the full suite. With Node 24.19+, use `node --test --test-random-seed=104729 --test-global-setup=test/isolate.ts "test/unit/*.test.ts"` and record the seed; shuffling CLI file arguments alone does not randomize execution. A timeout bounds a failed wait; it must never stand in for synchronization. The [cleanup ledger](TEST-CLEANUP.md) records reviewed files, preserved behaviours and remaining work.

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
