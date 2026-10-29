# Elabora core documentation

> The open core of Elabora: an e-learning source format that AI agents write and people review, a validator with stable codes, a SCORM 1.2 and web compiler tested against documented LMS behaviour, and a contract that keeps custom code testable.

This page is the map of the documentation. Each page is a Markdown file of this folder, read on GitHub, on [elabora.studio/en/docs/developers](https://elabora.studio/en/docs/developers/), and by agents through `elabora docs` (the MCP tool `elabora_docs`). Pages marked *generated* are written from the code by `pnpm run docs`: change the code, not the page.

## Start here

- [Getting started](getting-started.md): requirements, install, then validate, build, test and preview the sample courses, and start a course of your own.
- [Working with an agent](agents.md): MCP, shell calls and direct file edits, the workflows each covers, tool selection for hosts, and the decisions only people make.

## The format

- [Format specification](../SPEC.md): the files of a course and their rules: the plan and its versions, screens, blocks, events, components, free objects, tracking, translation and archives.
- [Built-in blocks](blocks.md): every built-in block type with its props and how to fork its template (generated).
- [Components](components.md): course components, block types and screen layouts made from a props schema and a template without code; forks, slots, fallback and libraries.
- [Dialogues](dialogues.md): branching conversations held in a block: lines, nodes and options, the walk replayed from the choices, modes and going back, the first run scored, events with the screen, `show`, `play`, `paths` and the client's export.
- [Charts and diagrams](charts.md): the chart blocks, each saying one thing; how they move, follow the voice and let learners predict; Mermaid diagrams; charts agents make with D3 and the kit.
- [Design layer](design.md): free stylesheets, layouts and generated figures around structured content; window sizes, slides and steps; checks on the rendered course.
- [Free-object contract](free-object-contract.md): custom code such as three.js scenes and mini-games, kept sandboxed, testable and editable without code: manifest, protocol, gates; what persists from one screen to the next (an object that carries on, §4e; the backdrop's decoration, mounted once, §4c).
- [JSON Schemas](../packages/format/schemas/0.1.5/): the normative schemas of format 0.1, also served at `https://elabora.studio/schemas/0.1.5/`.

## Delivery

- [SCORM 1.2 and the LMS emulator](delivery-scorm12.md): what a package holds, how the player behaves in an LMS, and what the emulator proves and cannot prove.
- [Web target](delivery-web.md): a module for a plain web server, with recipes and what the host must provide.
- [LMS profiles](lms-profiles.md): what each documented LMS accepts, with sources and the values still to measure (generated).
- [Review bridge](review-bridge.md): the `postMessage` protocol between a module built for review and the review page that shows it.

## Reference

- [Command line](cli.md): every `elabora` command and its options (generated).
- [Agent tools](mcp-tools.md): every agent operation, as an MCP tool or a shell call, with its arguments (generated).
- [Diagnostic codes](diagnostics.md): every finding's code, title and fix, and the guardrails they enforce (generated).
- [Changelog](../CHANGELOG.md): what changed in each version.
- [Development history](development-history.md): the work recorded before versioned releases.

## Architecture

- [Architecture](architecture.md): goals and constraints, the packages and what they may import, the project model; the contract every change follows.
- [Operations, journal and identifiers](architecture/operations.md): changes as operations with an author, a batch and an inverse; the project lock and journal; permanent ids, renaming and format migrations.
- [Media](architecture/media.md): imports and canonical formats, quality presets, the encoder, narration audio, voices and word times, and how media reach packages.
- [Delivery targets and hosting](architecture/delivery.md): the SCORM and web targets of one build, review builds, and the client of Elabora's hosting.
- [The plan and its versions](architecture/plan.md): the plan as a working copy, versions frozen by a person, what changed between them, and the plan's document.
- [Backups, sources and the project library](architecture/storage.md): versions in a content-addressed store, the author's sources, the project library, `.elabora` archives and machine-local data.
- [Importing Storyline and Rise modules](architecture/import.md): how Storyline 360 and Rise 360 modules become Elabora modules, with a report of every loss.
- [Rendering, browsers and captures](architecture/rendering.md): the browser that measures, captures and tests use, and how one screen is rendered for the app and for looks.
- [Engine](architecture/engine.md): the desktop app's editing session: the project in memory, one write queue, incremental validation, other writers and the message protocol.

## Decisions

- [Decision log](decisions.md): every design decision since the first version, D1 onwards, each with why and what would make us revisit it (index generated).

## Contributing

- [Core releases](releases.md): changesets, release preparation, version checks and publication from an exact merged commit.
- [Contributing](../CONTRIBUTING.md): set up a checkout, the rules every change follows, the test suites, and how the docs are kept in step with the code.
