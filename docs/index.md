# Elabora core documentation

> The open core of Elabora: a course format that AI agents write and people review, a validator with stable codes, a SCORM 1.2 and web compiler tested against documented LMS behaviour, and a contract that keeps custom code testable.

Read these pages on GitHub, on [elabora.studio/en/docs/developers](https://elabora.studio/en/docs/developers/), or from the command line with `elabora docs` (MCP tool `elabora_docs`). Pages marked *generated* come from the code: run `pnpm run docs` after changing it.

## Start here

- [Getting started](getting-started.md): install the core, then validate, build, preview and test a sample, and start a course of your own.
- [Working with an agent](agents.md): MCP, shell calls and file edits, choosing tools for a host, and the decisions only people make.

## The format

- [Format specification](../SPEC.md): every file of a course and its rules: plan and versions, screens, blocks, events, components, free objects, tracking, translation, archives.
- [Built-in blocks](blocks.md): each built-in block type, its props and how to fork its template (generated).
- [Components](components.md): block types and screen layouts made from a props schema and a template; forks, slots, fallback and libraries.
- [Dialogues](dialogues.md): branching conversations in a block: lines, nodes and options, modes, scoring, events and the client's export.
- [Charts and diagrams](charts.md): chart blocks that each say one thing, follow the voice and let learners predict; Mermaid diagrams; custom charts with D3.
- [Design layer](design.md): free stylesheets, layouts and generated figures around structured content; window sizes, slides and steps; checks on the rendered course.
- [Free-object contract](free-object-contract.md): custom code such as three.js scenes and mini-games, sandboxed, testable and editable by authors: manifest, protocol, gates, objects that carry on across screens (§4e) and the backdrop's decoration (§4c).
- [JSON Schemas](../packages/format/schemas/0.1.11/): the normative schemas of format 0.1, also served at `https://elabora.studio/schemas/0.1.11/`.

## Delivery

- [SCORM 1.2 and the LMS emulator](delivery-scorm12.md): what a package holds, how the player behaves in an LMS, and what the emulator checks.
- [Web target](delivery-web.md): a module for any web server, with recipes and what the host must provide.
- [LMS profiles](lms-profiles.md): what each documented LMS accepts, with sources and the values still to measure (generated).
- [Review bridge](review-bridge.md): the `postMessage` protocol between a module built for review and the review page that shows it.

## Reference

- [Command line](cli.md): every `elabora` command and its options (generated).
- [Agent tools](mcp-tools.md): every agent operation, as an MCP tool or a shell call, with its arguments (generated).
- [Diagnostic codes](diagnostics.md): every finding's code, title and fix, and the rules they enforce (generated).
- [Changelog](../CHANGELOG.md): what changed in each version.
- [Development history](development-history.md): the work done before versioned releases.

## Architecture

- [Architecture](architecture.md): goals and constraints, the packages and what each may import, the project model; the contract every change follows.
- [Operations, journal and identifiers](architecture/operations.md): changes as operations with an author, a batch and an inverse; the project lock and journal; permanent ids, renames and format migrations.
- [Media](architecture/media.md): imports and canonical formats, quality presets, the encoder, narration audio, voices and word times, and how media reach packages.
- [Delivery targets and hosting](architecture/delivery.md): the SCORM and web targets of one build, review builds, and the client of Elabora's hosting.
- [The plan and its versions](architecture/plan.md): the plan as a working copy, versions frozen by a person, what changed between them, and the plan's document.
- [Backups, sources and the project library](architecture/storage.md): versions in a content-addressed store, the author's sources, the project library, `.elabora` archives and machine-local data.
- [Importing Storyline and Rise modules](architecture/import.md): how Storyline 360 and Rise 360 modules become Elabora modules, with a report of every loss.
- [Rendering, browsers and captures](architecture/rendering.md): the browser behind measures, captures and tests, and how one screen is rendered for the app and for looks.
- [Engine](architecture/engine.md): the desktop app's editing session: the project in memory, one write queue, incremental validation, other writers and the message protocol.

## Decisions

- [Decision log](decisions.md): every design decision from D1 on, each with its reasons and what would make us revisit it (index generated).

## Contributing

- [Core releases](releases.md): changesets, preparing a release, version checks and publishing from an exact merged commit.
- [Contributing](../CONTRIBUTING.md): set up a checkout, the rules every change follows, the test suites, and keeping the docs in step with the code.
