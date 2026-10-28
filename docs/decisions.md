# Decisions

Generated from `docs/decisions/` by `pnpm run docs`. One file per decision: what was decided, why, and what would make us revisit it (*Revisit if*). Code, docs and changelog cite them by number (D24); a decision replaced or revised says by which one.

| | Decision | Date |
|---|---|---|
| [D1](decisions/D01.md) | JSON Schema 2020-12 is the source of truth |  |
| [D2](decisions/D02.md) | SCORM 1.2 only, one SCO, no sequencing |  |
| [D3](decisions/D03.md) | Session end without `unload` |  |
| [D4](decisions/D04.md) | Permanent state keys (`elabora.lock.json`) |  |
| [D5](decisions/D05.md) | Contract layer frozen by a hash; changes as JSON Patch (revised by D52) |  |
| [D6](decisions/D06.md) | Free objects: vanilla three.js r186, vendored, sandboxed, deterministic |  |
| [D7](decisions/D07.md) | Course data shipped as JavaScript |  |
| [D8](decisions/D08.md) | Deterministic packages |  |
| [D9](decisions/D09.md) | Executable LMS profiles |  |
| [D10](decisions/D10.md) | Agent interface: MCP + short skills + AGENTS.md |  |
| [D11](decisions/D11.md) | LESSON.md for simple blocks |  |
| [D12](decisions/D12.md) | TypeScript workspace packages, run directly by Node | revised 6 Oct 2026 |
| [D13](decisions/D13.md) | Free design, structured content (design layer prototype) |  |
| [D14](decisions/D14.md) | One component model, headless behaviours (prototype) |  |
| [D15](decisions/D15.md) | Files are the source of truth; every change is an operation | 6 Oct 2026 |
| [D16](decisions/D16.md) | Media inside the package, one master per file at the high preset | 6 Oct 2026 |
| [D17](decisions/D17.md) | Backups in a content-addressed version store, not git | 6 Oct 2026 |
| [D18](decisions/D18.md) | Desktop app: Electron, one engine, React | 6 Oct 2026 |
| [D19](decisions/D19.md) | A project library managed by the app, and project archives | 6 Oct 2026 |
| [D20](decisions/D20.md) | Format versions migrate; renaming is a command | 6 Oct 2026 |
| [D21](decisions/D21.md) | A GPL ffmpeg, run as a separate program | 7 Oct 2026 |
| [D22](decisions/D22.md) | Vetted fonts shipped with Elabora | 7 Oct 2026 |
| [D23](decisions/D23.md) | A project is watched once open | 7 Oct 2026 |
| [D24](decisions/D24.md) | The slide timeline: narration and timed steps | 8 Oct 2026 |
| [D25](decisions/D25.md) | Free local voices: Kyutai's Pocket TTS, run with ONNX Runtime | 8 Oct 2026 |
| [D26](decisions/D26.md) | The full app supplies the browser for agents and tests | 10 Oct 2026 |
| [D27](decisions/D27.md) | Word times by forced alignment: wav2vec2 character models and a Viterbi search in TypeScript | 12 Oct 2026 |
| [D28](decisions/D28.md) | The fine timeline: timed blocks, anchors to words, effects set to the time | 11 Oct 2026 |
| [D29](decisions/D29.md) | ElevenLabs voices with the author's key: stage directions, dialogue, credits asked before spending | 12 Oct 2026 |
| [D30](decisions/D30.md) | Paid AI services speak in shares of the author's quota, with one threshold | 13 Oct 2026 |
| [D31](decisions/D31.md) | Warnings the author ignores: in course.json, by a key that lapses | 13 Oct 2026 |
| [D32](decisions/D32.md) | The theme's rules are defaults under the components; overrides are said | 13 Oct 2026 |
| [D33](decisions/D33.md) | A figure's SVG in the page, rebuilt from an allowlist | 13 Oct 2026 |
| [D34](decisions/D34.md) | A course's rules for agents follow the Elabora that runs; an author's edits are never overwritten | 13 Oct 2026 |
| [D35](decisions/D35.md) | A plan never validated is a draft the agent writes; validated, it is the contract | 13 Oct 2026, replaced by D52 |
| [D36](decisions/D36.md) | What paid AI services charge is a ledger of measured requests, read only within its price period | 13 Oct 2026 |
| [D37](decisions/D37.md) | A local voices' model can be removed, never under a generation; the lines made stay | 13 Oct 2026 |
| [D38](decisions/D38.md) | Every optional download is listed, sized and removable in Elabora settings; removing it never touches a module | 13 Oct 2026 |
| [D39](decisions/D39.md) | The product is called Elabora | 13 Oct 2026 |
| [D40](decisions/D40.md) | The author's ElevenLabs key lives in one place; the keychain is used only after the author's gesture | 14 Oct 2026 |
| [D41](decisions/D41.md) | A web target beside SCORM 1.2: one build, a module for a plain web server | 14 Oct 2026 |
| [D42](decisions/D42.md) | The Revue talks to its module through a versioned postMessage bridge, shipped in review builds only | 14 Oct 2026 |
| [D43](decisions/D43.md) | The core is the client of Elabora's hosting; the author's AI reads review comments placed in the sources, and only people publish, share and resolve | 14 Oct 2026 |
| [D44](decisions/D44.md) | Everything is Apache-2.0, the sample projects' original content is CC0 | 14 Oct 2026 |
| [D45](decisions/D45.md) | The author's AI reads reviews with a read-only key of its own; the session stays the author's | 14 Oct 2026 |
| [D46](decisions/D46.md) | What a recording says, heard on this computer: NVIDIA's Parakeet TDT 0.6B v3, downloaded once; ElevenLabs' Scribe v2 only when the author asks | 15 Oct 2026 |
| [D47](decisions/D47.md) | Storyline and Rise modules are imported as Elabora modules: a slide is read, not traced; what has no block yet falls back to a text, a picture or a note | 15 Oct 2026, beta |
| [D48](decisions/D48.md) | The plan's document: one model for the app, Word and PDF; Word written by hand, the PDF printed by Chromium | 15 Oct 2026 |
| [D49](decisions/D49.md) | The author's sources live in sources/, outside the course, each with a readable version made on this computer | 15 Oct 2026 |
| [D50](decisions/D50.md) | The plan reads as an outline: parts, short names, a duration estimated from the screens, and screens that follow their items | 15 Oct 2026 |
| [D51](decisions/D51.md) | A new course keeps what the author said of it; the agent's draft says what it decided alone and asks one question at a time | 15 Oct 2026 |
| [D52](decisions/D52.md) | The plan is written at any time; its versions are made by hand, one is validated, and what changed is computed | 16 Oct 2026 |
| [D53](decisions/D53.md) | One agent operation catalogue, several transports and explicit workflow coverage | 17 Oct 2026 |
| [D54](decisions/D54.md) | Ship Intel Macs with media tools, without local AI | 17 Oct 2026 |
| [D55](decisions/D55.md) | Exact compatible model releases, background upgrades and one app status panel | 17 Oct 2026 |
| [D56](decisions/D56.md) | Changesets, release PRs and public release records | 17 Oct 2026 |
| [D57](decisions/D57.md) | Local models published by individuals are downloaded from Elabora's own copy on Hugging Face | 19 Oct 2026 |
| [D58](decisions/D58.md) | The learner's player: two configurable bars, resources, a glossary, an AI mention and credits | 19 Oct 2026 |
| [D59](decisions/D59.md) | One package in every approved language, which learners switch in place | 20 Oct 2026 |
| [D60](decisions/D60.md) | Charts and diagrams: blocks that each say one thing, drawn at build time, moved by the player, in step with the voice | 23 Oct 2026 |
| [D61](decisions/D61.md) | Branching dialogues: a block that holds its graph, one pure walk replayed from the choices, the first run scored | 23 Oct 2026 |
| [D62](decisions/D62.md) | Layer timelines and voice lines on every track of a screen | 23 Oct 2026 |
| [D63](decisions/D63.md) | Starter blocks for scroll courses: few blocks with presentations, three primitives, three activities | 24 Oct 2026 |
| [D64](decisions/D64.md) | Schemas have a patch version: additive changes are published as 0.1.1 | 26 Oct 2026 |
| [D65](decisions/D65.md) | Continuity between screens: a block that carries on from one screen to the next | 28 Oct 2026 |
| [D66](decisions/D66.md) | pnpm installs the checkouts, in npm's flat layout | 28 Oct 2026 |
