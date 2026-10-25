# Test cleanup ledger

Branch: `test-policy-cleanup`. Baseline: `96df988`. Worktree: `.test-policy/elabora-core` in the parent workspace. Counts include blank lines. Commit each completed test file with its ledger update. The inventory below lists all test files; reviewed changes started with edit/undo and session consistency, then the larger suites. All 119 automated test files have been reviewed; rows distinguish completed validation from the remaining final checks.

## Policy and scope

Test public behaviour, use real domain objects, fake only uncontrolled boundaries, own and clean up each test's state, and use seeded invariants. No production changes without a ledger entry; propose substantial testability refactors for human review. Core owns the shared standards in CONTRIBUTING; app CONTRIBUTING adds its commands.

## Validation

- Baseline: **769 passed, 6 skipped** (775 unit cases).
- Completed full native random-order unit runs: **791 passed, 6 skipped** (797 cases) with seeds **104729** and **130363**. Seed **155921** is running. Reproduce with `node --test --test-random-seed=<seed> --test-concurrency=2 --test-global-setup=test/isolate.ts "test/unit/*.test.ts"`.
- Random order reproduced three setup defects: ElevenLabs estimates needed a previous library search; account quota included another case's spending; a custom download kind leaked into a built-in registry assertion. Fresh per-case service/cache/quota state, explicit prerequisites and a disposable extension process fixed them. Focused reruns and completed full runs pass.
- Focused native-seeded browser groups pass: canvas/live/web 16 cases, object/look/LMS 24, design/layer timelines 26, player/items 11, review protocol, fonts, engine canvas and workflow. Narration and timeline each pass all ten cases. Final dialogue integration and complete browser repeats are running.
- Matrix: **8 passed** on both native seeds **130363** and **155921**. Strict typecheck and `npm run release:check` passed.
- First-checkpoint complete browser suite: **118 passed, 3 skipped** (121 cases). Final complete-browser seed **104729** is running. Two Edge cases require installed Microsoft Edge; Electron PDF requires `ELABORA_ELECTRON_EXECUTABLE`. No unavailable/native Windows or paid-provider checks are claimed as passes.
- Earlier repeats with shuffled CLI arguments are repeat evidence only: Node sorts arguments; native seeds randomize execution within files too.
- Test files: **26,924 → 26,401 lines at this checkpoint**; shared test utilities add 73 net lines. Final totals are refreshed after the last dialogue commit. No production runtime code changed; the metadata-only CI repair is recorded below.

## Recurring defects

Counts are confirmed sites changed, not estimates of the whole repository. Updated after each file.

| Defect | Count | Example |
| --- | ---: | --- |
| Implementation coupling | 55 | ops: private computeDiff comparison and exact chosen diff scripts |
| Duplicate assertions | 5 | ops: identical notes restoration asserted twice |
| Shared mutable fixtures | 14 | ops: module-level change ID counter replaced with content-derived IDs |
| Fixed-delay synchronization | 56 | engine-session: sleep(400) before checking watcher results |
| Tautology | 1 | engine-session: flatMap length compared to reduce of the same lengths |
| Duplicate computation | 3 | engine-project-state: full validator run twice per assertion |
| Unseeded randomness | 34 | library: randomBytes fixtures for archives, history tampering and 50 MB streaming |
| Duplicate behaviours | 2 | library: restore already exercised by dedicated history-preserving restore tests |
| Low-value assertion | 6 | engine-store: repeated hash equality replaced with hash invalidation after a write |
| Weak assertion | 9 | validate: counted two errors without identifying their prop paths |
| Resource cleanup | 116 | validate: copied fixtures were never removed |
| Wall-clock timing | 14 | journal: sub-second acquisition assertions replaced by zero-timeout contracts and explicit exclusion |
| Duplicate fixtures | 5 | ops: custom PRNG and recursive filesystem scanner duplicated existing test/runtime utilities |
| Reproduced order dependencies | 3 | ElevenLabs rate estimate needed a previous test to search a library voice |
| Private layout assertions | 7 | charts-matrix imported label placement helpers instead of measuring rendered labels |
| Fixture lifetime | 9 | copied courses lacked per-case failure cleanup |

| Reproduced browser timing races | 2 | player tooltip: an automatically advancing fake clock could expire the flash before pointer assertions |

| Uncontrolled virtual clocks | 2 | player: install initializes time but does not pause its progression |

## Production changes

No production code changed. CI discovered a pre-existing release-metadata error before tests could run: `.sampo/changesets/layer-captions-bare-canvas.md` and `player-motion.md` named only `npm/@elabora/player`, although the release policy requires `npm/elabora` too. Added the matching root patch target to each in a separate metadata-only commit; the original change texts and player targets are preserved. `npm run release:check` then passed.

## Human questions / proposed refactors

Proposed, not applied: give `watchFolders` an explicit readiness acknowledgement on every platform, matching FsStore. Its macOS integration test currently probes the real stream because the public API has no ready signal. Keep the real-filesystem regression; a test-only delay cannot fix this API limitation.

No human answer is required to finish this test-only audit. All automated files have been reviewed. Keep native inference rejection regressions until the proposed inference seam can replace their prototype fixture. The look-server integration still needs a bounded OS process-exit poll: propose exposing completion of daemon shutdown so this can await a termination signal without changing production during cleanup.

## Files

| File | Lines before | Lines after | Result / preserved behaviour |
| --- | ---: | ---: | --- |
| `test/e2e/agent-workflow.test.ts` | 53 | 54 | Focused seed 130363 passed; real MCP translate, preview, validation and language package workflow retained; own copied course and MCP peers |
| `test/e2e/canvas-live.test.ts` | 233 | 232 | Focused seed 130363 passed all six workflows; ordered postMessage acknowledgement replaces delay-based absence checks; owned browser, host and session |
| `test/e2e/canvas.test.ts` | 473 | 444 | Focused seed 130363 passed all nine behaviours; real DOM/layout/image/code updates, frame continuity, focus, ranges and token refusals; owned fixtures |
| `test/e2e/character.test.ts` | 136 | 139 | Focused seed 104729 passed; virtual browser clock drives gesture expiry and pause; computed arm reset replaces Animation identity |
| `test/e2e/charts.test.ts` | 182 | 228 | Passed crowded six-label desktop/phone layout and five-stage cycle; verifies visible labels and SVG bounds |
| `test/e2e/design.test.ts` | 697 | 686 | Native seed 104729 passed 21 behaviours; public object state and decoded captures replace waits/byte quotas; capture variation compares pixels, including uniform non-grey failure; final suite repeat queued |
| `test/e2e/dialogues.test.ts` | 559 | 551 | All ten native seed 130363 cases passed; latest-state LMS acknowledgement passed again at seed 155921; per-case packages/browser state, fixed IDs, frame events and real voiced-line completion replace shared caches, sleeps and timing budgets; exact forked thread retained |
| `test/e2e/edge.test.ts` | 122 | 125 | Reviewed and typechecked; two native seed 130363 cases skip because Edge is absent; real SwiftShader comparison and fallback preserved, captures decoded, resources owned; Linux CI exercises installed Edge |
| `test/e2e/engine-canvas.test.ts` | 128 | 91 | Focused seed 130363 passed; commands and external writes reach actual DOM while the free object keeps its marker and frame; removed machine-speed budgets |
| `test/e2e/fonts.test.ts` | 124 | 112 | Focused seed 130363 passed both browser regressions; actual Unicode/font loading, licence and embedded font rendering retained; own sources/builds/server/browser |
| `test/e2e/layer-timeline.test.ts` | 296 | 282 | Native seed 104729 passed all five behaviours; real layer pauses, captions, cues, seek/reopen and captures retained; effect completion replaces fixed chart waits; owned resources |
| `test/e2e/lms.test.ts` | 103 | 95 | Focused seed 104729 passed all four; legacy unload warning, stalled step and browser emulation retained; load event replaces delayed stall start |
| `test/e2e/look.test.ts` | 357 | 353 | Focused seed 104729 passed all six workflows; look reuse, code reload, scrolling, object actions and refused opaque-frame behaviour; response events replace sleeps |
| `test/e2e/media.test.ts` | 96 | 82 | Focused seed 104729 passed; iframe navigation, loaded metadata and seeked events synchronize actual video controls; own fixture and browser |
| `test/e2e/narration.test.ts` | 437 | 434 | All ten cases passed at 130363; full load exposed a missed short last-segment window; revised early-ended AAC regression passed at 155921 and 104729 using real media seek and same-task event; native audio-clock fidelity test retained |
| `test/e2e/object.test.ts` | 372 | 372 | Native seed 104729 passed fourteen behaviours; gates, event order and dry WebGL readback retained; decoded captures require variation between pixels; final suite repeat queued |
| `test/e2e/plan-document.test.ts` | 61 | 61 | Reviewed unchanged; focused seed 104729 passed tagged A4 outline, date, deterministic bytes and export; Electron case requires opt-in executable |
| `test/e2e/player-items.test.ts` | 265 | 256 | All seven cases previously passed at 155921; revised PDF case passed at 155921 with paused clock, explicit rendering/time advances and HEAD-header acknowledgement; real viewer/download/inline fallback contracts retained |
| `test/e2e/player.test.ts` | 150 | 151 | All four cases passed at native seed 155921; tooltip also passed at 104729 after pausing its clock and driving hover/leave timers; wait for player readiness; removes load-sensitive flash expiry race |
| `test/e2e/review.test.ts` | 299 | 303 | Focused seed 155921 passed; explicit browser message acknowledgements and event log replace fixed waits and polling; review origin/refusal behaviours retained |
| `test/e2e/timeline.test.ts` | 461 | 438 | Native seed 130363 passed all ten; virtual playhead checks computed opacity, translation, scale and stroke completion instead of Animation objects; cues, seek, captures and canvas contracts retained; owned resources |
| `test/e2e/web.test.ts` | 150 | 149 | Focused seed 130363 passed; local progress survives reload, none persists nothing, free navigation reaches end across three built targets; owned resources |
| `test/matrix/lms-matrix.test.ts` | 26 | 26 | Native seed 130363 passed; real sample validation, packaging, LMS launch modes and browser gates retained; own copied inputs, outputs and browser resources |
| `test/matrix/medieval.test.ts` | 45 | 41 | Native seed 130363 passed; real sample validation, packaging, LMS launch modes and browser gates retained; own copied inputs, outputs and browser resources |
| `test/matrix/phishing.test.ts` | 41 | 37 | Native seed 130363 passed; real sample validation, packaging, LMS launch modes and browser gates retained; own copied inputs, outputs and browser resources |
| `test/matrix/planetary.test.ts` | 84 | 78 | Native seed 130363 passed; real sample validation, packaging, LMS launch modes and browser gates retained; own copied inputs, outputs and browser resources |
| `test/unit/add-resource.test.ts` | 107 | 104 | Native-seeded cases passed; per-case source files and owned sessions/MCP clients; exact imported bytes replace size-only check; consolidated duplicate cleanup under context ownership |
| `test/unit/agent-rules.test.ts` | 105 | 106 | Native-seeded cases passed; own copied course; generated revisions, preservation of author notes, update/undo and published rule-text regressions retained |
| `test/unit/align.test.ts` | 469 | 477 | Passed native seed 155921 with two explicit unavailable-model skips; seeded CTC oracle retained; context-owned narration/model/recording folders and session/worker disposal, real-case environment restored |
| `test/unit/backups.test.ts` | 456 | 465 | Passed all 14 native-seeded cases; reproducible media with distinct edit seeds, owned project folders, hash-race clock controlled; child readiness/release gates replace synchronized wall-clock start; live-lock refusal uses zero timeout; retention/restore/GC contracts retained |
| `test/unit/browser.test.ts` | 57 | 50 | Passed native-seeded cases; named channel/fallback cases inspect usable returned browser; value comparison replaces argument identity and mock-call-only checks |
| `test/unit/canvas-host.test.ts` | 134 | 135 | Passed native-seeded cases; owns host, late event stream and narrated course; actual HTTP/SSE/render, MIME/range and unlisted-file refusals retained |
| `test/unit/charts-before-after.test.ts` | 86 | 43 | Passed chart units and desktop/phone browser layout; public output replaces private geometry/dodge formulas; crowded and coincident labels checked by actual DOM bounds |
| `test/unit/charts-cycle.test.ts` | 112 | 106 | Passed chart units and browser layout; rendered clockwise order and visible bounds replace private stage/arc formulas and constants |
| `test/unit/charts-donut.test.ts` | 99 | 95 | Passed chart units; public totals, accessible data, full/empty turns replace private geometry and SVG mask implementation details |
| `test/unit/charts-levels.test.ts` | 103 | 102 | Passed chart units; rendered ordering and partial rows replace private layout shape and exact coordinate formulas |
| `test/unit/charts-matrix.test.ts` | 98 | 90 | Passed chart units and browser layout; public label/legend behaviour and actual non-overlap replace private layout/measurement helpers |
| `test/unit/charts-milestones.test.ts` | 95 | 85 | Passed chart units and browser layout; public compact/long/two-event arrangements replace private text-line and alternation helpers |
| `test/unit/charts-process.test.ts` | 84 | 83 | Passed 5 native-seeded cases; public markup/accessibility/order/table/escaping/highlight/determinism retained; duplicate link-count assertion removed |
| `test/unit/charts-proportion.test.ts` | 69 | 75 | Passed 5 native-seeded cases; public icon positions/counts/format/escaping replace private geometry and self-referential item constant; 100 seed-71 totals/share invariants added |
| `test/unit/charts.test.ts` | 186 | 187 | Passed chart units; context-owned course and public curve/gap invariants replace exact chosen Bezier and dodge coordinates |
| `test/unit/cli-projects.test.ts` | 266 | 256 | All 6 native-seeded cases passed; context-owned library/course/archive fixtures and MCP connection; seeded 40 MB progress input and failure-safe file descriptor; actual CLI workflows and isolated home retained |
| `test/unit/cli.test.ts` | 715 | 684 | Passed 28 native-seeded cases; real CLI/MCP transport, refusal, privacy, journal/undo, translation and permission contracts preserved; failure-safe context ownership closes clients/servers before removing copies |
| `test/unit/cloud.test.ts` | 638 | 641 | Passed 20 native-seeded cases with a fresh fake service/credential store per case, restored cloud environment and failure-safe client cleanup; redundant storage mock-call tracking removed; real publishing/privacy/account/review contracts retained |
| `test/unit/compile.test.ts` | 156 | 160 | Passed native-seeded checks; Build packaging, SCORM, failures and live preview checks retained; every course/output is context-owned |
| `test/unit/components.test.ts` | 313 | 315 | Passed 12 native-seeded cases; owned course/component/output fixtures; separate unknown-property and invalid-list diagnostics replace summed assertion; build, detach, fallback, libraries and migration contracts retained |
| `test/unit/costs.test.ts` | 200 | 201 | Native-seeded cases passed; fixed date for all cost estimates and owned ledger/server; real pricing-period/discount/own-charge and append-once history behaviours retained |
| `test/unit/course-state.test.ts` | 127 | 130 | Passed native-seeded checks; All scoring, resume, completion and event behaviours retained with owned courses |
| `test/unit/data-dir.test.ts` | 35 | 37 | Passed native-seeded case; disposable processes still test process-cached settings; owned parent keeps renamed project and relocated blobs isolated |
| `test/unit/design.test.ts` | 394 | 394 | Passed 23 native-seeded cases; owned fixtures/output; theme precedence checked through real upgrades instead of private property-family labels; removed function-truthiness assertion |
| `test/unit/dialogue-player.test.ts` | 199 | 202 | Passed 8 native-seeded cases; owned dialogue fixtures; full learner resume, score, conditions, completion and label contracts retained without arbitrary label count |
| `test/unit/dialogue-voice.test.ts` | 376 | 376 | Native-seeded cases passed; owned dialogue courses/recordings/builds and shared seeded noise; sanitizer, character, transcription, voice packaging and review contracts retained without registry count |
| `test/unit/dialogue.test.ts` | 575 | 577 | Passed 19 native-seeded cases; every reachable path preserves walk and score after save/resume, owned courses, graph geometry rather than exact rank/curve choices; duplicate budget/stability checks removed |
| `test/unit/diff-mcp.test.ts` | 74 | 77 | Passed native-seeded cases; owned clients/servers/projects/builds; verifies actual disk edit and read-only refusal, removes arbitrary tool count |
| `test/unit/docs.test.ts` | 127 | 127 | Reviewed unchanged; all 7 native-seeded checks passed; published links, generated maps, diagnostic rule references and actual docs/skill access remain operational contracts |
| `test/unit/downloads.test.ts` | 147 | 161 | Native seed 130363 passed all 4 cases; extension registration isolated in a child, model files reset per case, real download/hash/install/removal and in-use refusals retained |
| `test/unit/edit-journal.test.ts` | 225 | 216 | Passed native-seeded cases; owns fixtures, seeded binaries and scoped Date; output/error semantics replace identity, exact retry count and elapsed-speed checks |
| `test/unit/edit.test.ts` | 223 | 224 | Passed native-seeded cases; context-owned courses preserve disk refusal, text editing, IDs, undo and translation contracts |
| `test/unit/electron-runtime.test.ts` | 21 | 21 | Reviewed, retained; passed native seed 155921. Real registration files, protocol/version/path refusals and explicit overrides are observable runtime-discovery contracts; context cleanup already failure-safe |
| `test/unit/elevenlabs.test.ts` | 675 | 688 | Native seed 104729: 17 passed and 1 live skip; fresh service/account/cache state fixes two reproduced order dependencies; alignment checks exchange timestamps |
| `test/unit/engine-agents.test.ts` | 189 | 177 | Passed 8 native-seeded cases; public-event waits and fake clock drive idle/backup deadlines; rescan barrier replaces sleep; test-owned sessions retain real CLI/agent journal and undo contracts |
| `test/unit/engine-build.test.ts` | 127 | 113 | Passed 3 native-seeded cases; explicit rescan barrier replaces watcher delays, owned sessions; packaging/state keys/system journal/publish ordering and refusals retained |
| `test/unit/engine-canvas.test.ts` | 133 | 124 | Passed 2 native-seeded cases; render content/view/title and unchanged unrelated screen replace cache identities; next expected SSE render proves unrelated edit sent nothing without a negative timeout |
| `test/unit/engine-media.test.ts` | 208 | 190 | Passed 6 native-seeded cases; public media/change events and rescan replace polling/sleep, owned sessions and unique source folders; real conversion/undo/import/verdict/folder-race regressions retained |
| `test/unit/engine-project-state.test.ts` | 92 | 92 | Passed; incremental findings/content equal full validation, including component content after no-op saves |
| `test/unit/engine-session.test.ts` | 413 | 364 | Passed 14 cases; event-driven watcher waits, fixed 128-write concurrency regression, per-test sessions; persistence/diagnostics/undo/protocol retained |
| `test/unit/engine-store.test.ts` | 194 | 175 | Passed 9 cases; event/readiness waits and fixed-size concurrent writes; resources close in reverse ownership order before folders are removed |
| `test/unit/fit-cache.test.ts` | 72 | 76 | Passed native-seeded checks; Public fit key invalidation scenarios retained with context-owned fixtures |
| `test/unit/fonts.test.ts` | 547 | 540 | Passed 15 native-seeded cases; public catalogue/license/font-byte/embedding/refusal/build contracts retained; per-test folders and failure-safe MCP/session disposal; arbitrary family-count and basename constraints removed |
| `test/unit/format.test.ts` | 77 | 76 | Passed 6 native-seeded cases; generated registry, accepted samples, diagnostics and dereferencing retained; removes arbitrary fixture-count coverage quota |
| `test/unit/i18n.test.ts` | 260 | 262 | Native-seeded cases passed; own course/export folders and two-entrant gate replaces translation-copy sleep; exact exported unit completeness replaces arbitrary unit count |
| `test/unit/ignored.test.ts` | 55 | 56 | Passed both native-seeded cases; context-owned course; finding waivers remain keyed to content and survive moves |
| `test/unit/import.test.ts` | 427 | 427 | Native-seeded cases passed; each synthetic import fixture is disposed after its case instead of suite end; detection, conversions, losses, settings, library and CLI contracts retained |
| `test/unit/interop.test.ts` | 92 | 91 | Passed native-seeded cases; owns export folders/courses; LESSON parsing, schema-valid conversion, losses and multi-select round trip retained |
| `test/unit/journal.test.ts` | 437 | 437 | Passed 14 cases; explicit lock entry/release gates and child stdin handshake; no elapsed-time assertions or fixed sleeps; sequence/history/binary/undo contracts retained |
| `test/unit/layer-timeline.test.ts` | 265 | 259 | Passed 10 native-seeded cases; own layered courses and both build outputs; preserves independent layer tracks, cue routing, translations, commands and deterministic packages; removed registry-count assertion; consolidated duplicate cleanup under context ownership |
| `test/unit/library.test.ts` | 840 | 843 | Passed 21 cases; deterministic media/retention, restored environment and owned temporary data; public archive/trash contracts retained |
| `test/unit/local-ai-platform.test.ts` | 50 | 50 | Passed 2 native-seeded cases; disposable OS override and throwing network boundary exercise all listed models, Intel refusals and removals; removes exact catalogue-size coupling |
| `test/unit/look.test.ts` | 122 | 113 | Native-seeded cases passed; owns folders/preview and real terminated PID fixture; public HTTP reload and code-version invalidation retained; consolidated redundant cleanup |
| `test/unit/media-project.test.ts` | 286 | 281 | Passed native-seeded cases; failure-safe project and HTTP ownership; actual media/ZIP/privacy/backup and range response contracts retained |
| `test/unit/media.test.ts` | 315 | 311 | Passed native-seeded cases; owned projects/queues, cancellation driven by ffmpeg progress, cache reuse checked by results rather than private filename; unique encoder boundary checks retained |
| `test/unit/migrate.test.ts` | 86 | 86 | Passed native-seeded cases; fixtures disposed per case and binary hashes compared instead of only sizes; dry-run, backup, system journal and undo retained |
| `test/unit/model-mirrors.test.ts` | 71 | 71 | Passed 2 native-seeded cases; pin/hash/size/origin and real fake-network install/reuse/tamper refusal retained; model families available rather than arbitrary file-count quota |
| `test/unit/model-versions.test.ts` | 126 | 132 | Passed 4 native-seeded cases; fake request gate and filesystem event replace polling; cancellation must reject; context-owned leases/install/folders preserve compatible-model use, deferred deletion and resume contracts |
| `test/unit/narration.test.ts` | 346 | 346 | Native-seeded cases passed; owned narrated courses; timing, captions, status, editing, speaker, recording, pronunciation and credits contracts retained |
| `test/unit/object-gates.test.ts` | 35 | 35 | Passed 2 native-seeded cases; test-owned snapshot folder; frame plan boundaries and real baseline pruning retained |
| `test/unit/ops.test.ts` | 929 | 757 | Passed 41 cases; shared seeded generator and real snapshot reader replace duplicate support machinery; public replay/undo properties and all named boundaries retained |
| `test/unit/package-limits.test.ts` | 131 | 131 | Reviewed unchanged; native-seeded checks passed; real chosen/unknown LMS limits, size/ratio diagnostics and package/preview targeting preserved with existing failure-safe cleanup |
| `test/unit/pdf-title.test.ts` | 111 | 115 | All native-seeded cases passed; adversarial inputs run in a heap-limited subprocess with a failure deadline instead of machine-speed budgets; extraction, precedence, encoding, file reads and bounded refusals retained |
| `test/unit/plan-document.test.ts` | 523 | 522 | Passed all plan-document cases with native seed 130363; context-owned copies, clients and sessions replace shared arrays and swallowed close failures; valid package/revisions/privacy/local-day/deterministic export contracts retained |
| `test/unit/plan-order.test.ts` | 124 | 125 | Native-seeded cases passed; owned copied course; unique plan ordering, shared-screen, undo and duration behaviours retained |
| `test/unit/plan.test.ts` | 356 | 356 | Native-seeded plan cases passed; owned copied courses; version approval, verbatim protection, diff, notes and package/archive contracts retained |
| `test/unit/player-items.test.ts` | 422 | 418 | Native-seeded item cases passed; owned fixtures/builds and error outputs replace host-speed budget; SVG parsing, glossary, language and live bar behaviours retained |
| `test/unit/player.test.ts` | 240 | 241 | Native-seeded player cases passed; context-owned fixtures preserve compiled bars, accessibility, navigation, editing and translation contracts |
| `test/unit/project-files.test.ts` | 124 | 115 | Passed 7 native-seeded cases; deterministic SHA oracle and owned courses, public snapshot/hash invalidation replace cache JSON tampering; real cache reuse under unreadable content remains checked by backups |
| `test/unit/purity.test.ts` | 53 | 53 | Passed 3 native-seeded cases; public LMS catalogue compared with checked-in data instead of private PROFILE_FILES import/order; required cross-browser architecture and generated-template guards retained |
| `test/unit/releases.test.ts` | 38 | 38 | Reviewed unchanged; passed real Sampo release preparation, workspace versions/lock/dependency updates, changelog preservation and changeset consumption in isolated Git fixture |
| `test/unit/rename.test.ts` | 118 | 118 | Native-seeded cases passed; dispose courses/builds after each case; reference propagation, learner keys, translation and exact undo contracts retained |
| `test/unit/render.test.ts` | 147 | 148 | Passed native-seeded checks; Public incremental/full render and CSS/package parity retained; owns fixtures and checks output rather than private render context |
| `test/unit/renditions-prune.test.ts` | 44 | 43 | Passed 2 native-seeded cases; fixed public now/mtime ages and bytes, owned course copies; keeps current/recent renditions and removes old obsolete data |
| `test/unit/review-bridge.test.ts` | 278 | 272 | Passed native-seeded cases; owned projects/builds/MCP/session; object content rather than insertion order; origin filtering, anchors and review delivery contracts retained; consolidated duplicate cleanup under context ownership |
| `test/unit/robustness-commands.test.ts` | 155 | 158 | Passed native-seeded checks; 240 seeded command replay/undo invariants; owns courses and now compares binary hashes as well as paths and text |
| `test/unit/robustness.test.ts` | 93 | 96 | Passed native-seeded checks; 250 seeded reader and incremental/full validation invariants; own fixtures and report reproducing seed |
| `test/unit/scaffold.test.ts` | 128 | 124 | All native-seeded cases passed; context-owned folders and restored data/library environment; real course creation, language fallback, brief validation and notes retained |
| `test/unit/schema.test.ts` | 40 | 36 | Passed 5 native-seeded cases; full strict registry compile check already lives in format.test.ts; real profile/schema/action boundaries retained without arbitrary profile count |
| `test/unit/sources.test.ts` | 511 | 521 | Passed 21 native-seeded cases; fresh input/model folders and restored library/data environment per case; await transcriber/client disposal before removal; mtime edits relative to fixture; import/readability/privacy/build-byte/archive contracts preserved |
| `test/unit/state-golden.test.ts` | 40 | 36 | Passed native-seeded cases; pinned legacy bytes retained; decode compares complete learner state rather than selected fields and re-encoding |
| `test/unit/state.test.ts` | 53 | 50 | Passed; 100 full-state persistence cases, complete corruption fallback, permanent keys and budget growth; test-owned course folders |
| `test/unit/svg-inline.test.ts` | 99 | 100 | Passed native-seeded cases; owned rendered course; hostile SVG sanitizing, scope isolation, subpaths and validation regressions retained |
| `test/unit/template-fields.test.ts` | 27 | 27 | Reviewed unchanged; passed template/canvas public HTML field-marking and plain-render exclusion checks |
| `test/unit/timeline.test.ts` | 390 | 387 | Passed 15 native-seeded cases; own narrated/translated courses; preserved word anchors, cue timing, editing, translation markers and resume contracts; removed constant-only assertion |
| `test/unit/transcribe.test.ts` | 290 | 292 | Native-seeded cases passed with one explicit unavailable-model skip; fresh fake model/input per case, dispose inference before removal, owned session, fixed recording filename replaces random UUID; consolidated duplicate cleanup under context ownership |
| `test/unit/translation-context.test.ts` | 156 | 151 | All native-seeded cases passed; owns courses/session and reports cleanup failures; exact exported-unit completeness replaces quota; translated canvas/fallback, approval/undo and language-package contracts preserved |
| `test/unit/validate.test.ts` | 627 | 631 | Passed 32 cases; preserves all diagnostic rules, checks exact prop paths, cleans every copied fixture; removes internal check-name assertion |
| `test/unit/voice-models.test.ts` | 252 | 253 | Native-seeded cases passed; per-case models and restored environment, seeded downloads, owned generation gates; outputs replace fake provider install counters |
| `test/unit/voice.test.ts` | 434 | 445 | 15 passed, 2 explicit unavailable-model skips with native seed 130363; owned courses/sessions, seeded download bytes, file notification gates and controllable external voice service replace sleeps/polling; separate named rejection cases and one recovery replace repeated retry checks; native inference seam proposal recorded |
| `test/unit/web-target.test.ts` | 321 | 315 | All native-seeded cases passed; owns builds/course/client/server/session; fake browser storage checked by kept content instead of write counters; packaging/privacy/CLI/MCP/engine contracts retained |
| `test/unit/zip-writer.test.ts` | 90 | 87 | Passed 3 native-seeded cases; own directories, seeded high-entropy payloads, round-trip every entry and compare reordered public writes; controlled mtimes and limit errors replace elapsed-time and private writer comparison |
| `test/unit/zip.test.ts` | 19 | 19 | Passed native-seeded cases; retained CRC reference and deterministic ordered ZIP; now compares every restored entry rather than one file |
| `README.md` | 86 | 90 | Policy complete; canonical standards in CONTRIBUTING |
| `CONTRIBUTING.md` | 51 | 55 | Canonical policy incorporates full-audit findings, including explicitly paused clocks and acknowledged external responses |
| `AGENTS.md` | 29 | 29 | Policy complete; canonical standards in CONTRIBUTING |
| `.sampo/changesets/layer-captions-bare-canvas.md` | 5 | 6 | Metadata only; restore mandatory root release target so CI can run |
| `.sampo/changesets/player-motion.md` | 10 | 11 | Metadata only; restore mandatory root release target so CI can run |
| `test/resources.ts` | 0 | 34 | Shared test-only ownership helper: one context-owned stack even across helper calls; reverse-order disposal keeps dependants ahead of files |
| `test/cloud-fake.ts` | 451 | 454 | Test-only hosting fake now uses instance-owned deterministic IDs and time; existing 20 cloud contracts passed with seed 155921 |
| `test/events.ts` | 0 | 27 | Shared test-only event log and subscription waits; real failure deadline stays active while domain timers are faked; 19 engine cases passed |
| `test/bytes.ts` | 0 | 9 | Reusable high-entropy seeded media/archive bytes; another explicit seed represents an edit; backup restore/pruning/large-file tests passed |

## Additional proposed testability refactor

PocketModel constructs native ONNX inference internally and has a private constructor. Retain the unique silent/non-finite/unfinished rejection and recovery regressions while proposing a small injectable inference backend. Their prototype fixture remains a documented exception until that production refactor is reviewed; no production runtime code was changed.

## Remaining work

Finish dialogue integration validation and its per-file commit. Complete the native full-browser repeats and third full-unit seed, refresh final counts/results, update the core PR, and verify CI and Git publication. App automated audit and final sibling-core repeat are complete. Production testability proposals above, native-only execution and the app's separate manual desktop catalogue remain explicit follow-up scope, not automated passes.
