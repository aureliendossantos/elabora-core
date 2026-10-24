# Test cleanup ledger

Branch: `test-policy-cleanup`. Baseline: `96df988`. Worktree: `.test-policy/elabora-core` in the parent workspace. Counts include blank lines. Commit each completed test file with its ledger update. The inventory below lists all test files; reviewed changes started with edit/undo and session consistency, then the larger suites. Pending rows are an explicit resume queue, not claims of completed review.

## Policy and scope

Test public behaviour, use real domain objects, fake only uncontrolled boundaries, own and clean up each test's state, and use seeded invariants. No production changes without a ledger entry; propose substantial testability refactors for human review. Core owns the shared standards in CONTRIBUTING; app CONTRIBUTING adds its commands.

## Validation

- Baseline suite started before edits; results pending.
- Final required: full suites, typecheck, repeated runs with reproducible shuffled file order.

## Recurring defects

Counts are confirmed sites changed, not estimates of the whole repository. Updated after each file.

| Defect | Count | Example |
| --- | ---: | --- |
| Implementation coupling | 18 | ops: private computeDiff comparison and exact chosen diff scripts |
| Duplicate assertions | 1 | ops: identical notes restoration asserted twice |
| Shared mutable fixtures | 4 | ops: module-level change ID counter replaced with content-derived IDs |
| Fixed-delay synchronization | 21 | engine-session: sleep(400) before checking watcher results |
| Tautology | 1 | engine-session: flatMap length compared to reduce of the same lengths |
| Duplicate computation | 1 | engine-project-state: full validator run twice per assertion |
| Unseeded randomness | 9 | library: randomBytes fixtures for archives, history tampering and 50 MB streaming |
| Duplicate behaviours | 1 | library: restore already exercised by dedicated history-preserving restore tests |
| Low-value assertion | 1 | engine-store: repeated hash equality replaced with hash invalidation after a write |
| Weak assertion | 3 | validate: counted two errors without identifying their prop paths |
| Resource cleanup | 40 | validate: copied fixtures were never removed |
| Wall-clock timing | 4 | journal: sub-second acquisition assertions replaced by zero-timeout contracts and explicit exclusion |

| Duplicate fixtures | 2 | ops: custom PRNG and recursive filesystem scanner duplicated existing test/runtime utilities |

## Production changes

None.

## Human questions / proposed refactors

Proposed, not applied: give `watchFolders` an explicit readiness acknowledgement on every platform, matching FsStore. Its macOS integration test currently probes the real stream because the public API has no ready signal. Keep the real-filesystem regression; a test-only delay cannot fix this API limitation.

Further review should prioritize the CLI transport suite (715 lines), ElevenLabs (675), dialogue (575), fonts (547), plan-document (523), sources (511), and remaining browser scenarios. These include valuable public-output contracts; size alone is not a reason to remove them.

## Files

| File | Lines before | Lines after | Result / preserved behaviour |
| --- | ---: | ---: | --- |
| `test/e2e/agent-workflow.test.ts` | 53 | — | Pending |
| `test/e2e/canvas-live.test.ts` | 233 | — | Pending |
| `test/e2e/canvas.test.ts` | 473 | — | Pending |
| `test/e2e/character.test.ts` | 136 | — | Pending |
| `test/e2e/charts.test.ts` | 182 | — | Pending |
| `test/e2e/design.test.ts` | 697 | — | Pending |
| `test/e2e/dialogues.test.ts` | 559 | — | Pending |
| `test/e2e/edge.test.ts` | 122 | — | Pending |
| `test/e2e/engine-canvas.test.ts` | 128 | — | Pending |
| `test/e2e/fonts.test.ts` | 124 | — | Pending |
| `test/e2e/layer-timeline.test.ts` | 296 | — | Pending |
| `test/e2e/lms.test.ts` | 103 | — | Pending |
| `test/e2e/look.test.ts` | 357 | — | Pending |
| `test/e2e/media.test.ts` | 96 | — | Pending |
| `test/e2e/narration.test.ts` | 437 | — | Pending |
| `test/e2e/object.test.ts` | 372 | — | Pending |
| `test/e2e/plan-document.test.ts` | 61 | — | Pending |
| `test/e2e/player-items.test.ts` | 265 | — | Pending |
| `test/e2e/player.test.ts` | 150 | — | Pending |
| `test/e2e/review.test.ts` | 299 | — | Pending |
| `test/e2e/timeline.test.ts` | 461 | — | Pending |
| `test/e2e/web.test.ts` | 150 | — | Pending |
| `test/matrix/lms-matrix.test.ts` | 26 | — | Pending |
| `test/matrix/medieval.test.ts` | 45 | — | Pending |
| `test/matrix/phishing.test.ts` | 41 | — | Pending |
| `test/matrix/planetary.test.ts` | 84 | — | Pending |
| `test/unit/add-resource.test.ts` | 107 | — | Pending |
| `test/unit/agent-rules.test.ts` | 105 | — | Pending |
| `test/unit/align.test.ts` | 469 | — | Pending |
| `test/unit/backups.test.ts` | 456 | — | Pending |
| `test/unit/browser.test.ts` | 57 | — | Pending |
| `test/unit/canvas-host.test.ts` | 134 | — | Pending |
| `test/unit/charts-before-after.test.ts` | 86 | — | Pending |
| `test/unit/charts-cycle.test.ts` | 112 | — | Pending |
| `test/unit/charts-donut.test.ts` | 99 | — | Pending |
| `test/unit/charts-levels.test.ts` | 103 | — | Pending |
| `test/unit/charts-matrix.test.ts` | 98 | — | Pending |
| `test/unit/charts-milestones.test.ts` | 95 | — | Pending |
| `test/unit/charts-process.test.ts` | 84 | — | Pending |
| `test/unit/charts-proportion.test.ts` | 69 | — | Pending |
| `test/unit/charts.test.ts` | 186 | — | Pending |
| `test/unit/cli-projects.test.ts` | 266 | — | Pending |
| `test/unit/cli.test.ts` | 715 | — | Pending |
| `test/unit/cloud.test.ts` | 638 | — | Pending |
| `test/unit/compile.test.ts` | 156 | — | Pending |
| `test/unit/components.test.ts` | 313 | — | Pending |
| `test/unit/costs.test.ts` | 200 | — | Pending |
| `test/unit/course-state.test.ts` | 127 | — | Pending |
| `test/unit/data-dir.test.ts` | 35 | — | Pending |
| `test/unit/design.test.ts` | 394 | — | Pending |
| `test/unit/dialogue-player.test.ts` | 199 | — | Pending |
| `test/unit/dialogue-voice.test.ts` | 376 | — | Pending |
| `test/unit/dialogue.test.ts` | 575 | — | Pending |
| `test/unit/diff-mcp.test.ts` | 74 | — | Pending |
| `test/unit/docs.test.ts` | 127 | — | Pending |
| `test/unit/downloads.test.ts` | 147 | — | Pending |
| `test/unit/edit-journal.test.ts` | 225 | — | Pending |
| `test/unit/edit.test.ts` | 223 | — | Pending |
| `test/unit/electron-runtime.test.ts` | 21 | — | Pending |
| `test/unit/elevenlabs.test.ts` | 675 | — | Pending |
| `test/unit/engine-agents.test.ts` | 189 | — | Pending |
| `test/unit/engine-build.test.ts` | 127 | — | Pending |
| `test/unit/engine-canvas.test.ts` | 133 | — | Pending |
| `test/unit/engine-media.test.ts` | 208 | — | Pending |
| `test/unit/engine-project-state.test.ts` | 92 | 92 | Passed; incremental findings/content equal full validation, including component content after no-op saves |
| `test/unit/engine-session.test.ts` | 413 | 364 | Passed 14 cases; event-driven watcher waits, fixed 128-write concurrency regression, per-test sessions; persistence/diagnostics/undo/protocol retained |
| `test/unit/engine-store.test.ts` | 194 | 175 | Passed 9 cases; event/readiness waits and fixed-size concurrent writes; resources close in reverse ownership order before folders are removed |
| `test/unit/fit-cache.test.ts` | 72 | — | Pending |
| `test/unit/fonts.test.ts` | 547 | — | Pending |
| `test/unit/format.test.ts` | 77 | — | Pending |
| `test/unit/i18n.test.ts` | 260 | — | Pending |
| `test/unit/ignored.test.ts` | 55 | — | Pending |
| `test/unit/import.test.ts` | 427 | — | Pending |
| `test/unit/interop.test.ts` | 92 | — | Pending |
| `test/unit/journal.test.ts` | 437 | 437 | Passed 14 cases; explicit lock entry/release gates and child stdin handshake; no elapsed-time assertions or fixed sleeps; sequence/history/binary/undo contracts retained |
| `test/unit/layer-timeline.test.ts` | 265 | — | Pending |
| `test/unit/library.test.ts` | 840 | 843 | Passed 21 cases; deterministic media/retention, restored environment and owned temporary data; public archive/trash contracts retained |
| `test/unit/local-ai-platform.test.ts` | 50 | — | Pending |
| `test/unit/look.test.ts` | 122 | — | Pending |
| `test/unit/media-project.test.ts` | 286 | — | Pending |
| `test/unit/media.test.ts` | 315 | — | Pending |
| `test/unit/migrate.test.ts` | 86 | — | Pending |
| `test/unit/model-mirrors.test.ts` | 71 | — | Pending |
| `test/unit/model-versions.test.ts` | 126 | — | Pending |
| `test/unit/narration.test.ts` | 346 | — | Pending |
| `test/unit/object-gates.test.ts` | 35 | — | Pending |
| `test/unit/ops.test.ts` | 929 | 757 | Passed 41 cases; shared seeded generator and real snapshot reader replace duplicate support machinery; public replay/undo properties and all named boundaries retained |
| `test/unit/package-limits.test.ts` | 131 | — | Pending |
| `test/unit/pdf-title.test.ts` | 111 | — | Pending |
| `test/unit/plan-document.test.ts` | 523 | — | Pending |
| `test/unit/plan-order.test.ts` | 124 | — | Pending |
| `test/unit/plan.test.ts` | 356 | — | Pending |
| `test/unit/player-items.test.ts` | 422 | — | Pending |
| `test/unit/player.test.ts` | 240 | — | Pending |
| `test/unit/project-files.test.ts` | 124 | — | Pending |
| `test/unit/purity.test.ts` | 53 | — | Pending |
| `test/unit/releases.test.ts` | 38 | — | Pending |
| `test/unit/rename.test.ts` | 118 | — | Pending |
| `test/unit/render.test.ts` | 147 | — | Pending |
| `test/unit/renditions-prune.test.ts` | 44 | — | Pending |
| `test/unit/review-bridge.test.ts` | 278 | — | Pending |
| `test/unit/robustness-commands.test.ts` | 155 | — | Pending |
| `test/unit/robustness.test.ts` | 93 | — | Pending |
| `test/unit/scaffold.test.ts` | 128 | — | Pending |
| `test/unit/schema.test.ts` | 40 | — | Pending |
| `test/unit/sources.test.ts` | 511 | — | Pending |
| `test/unit/state-golden.test.ts` | 40 | — | Pending |
| `test/unit/state.test.ts` | 53 | 50 | Passed; 100 full-state persistence cases, complete corruption fallback, permanent keys and budget growth; test-owned course folders |
| `test/unit/svg-inline.test.ts` | 99 | — | Pending |
| `test/unit/template-fields.test.ts` | 27 | — | Pending |
| `test/unit/timeline.test.ts` | 390 | — | Pending |
| `test/unit/transcribe.test.ts` | 290 | — | Pending |
| `test/unit/translation-context.test.ts` | 156 | — | Pending |
| `test/unit/validate.test.ts` | 627 | 631 | Passed 32 cases; preserves all diagnostic rules, checks exact prop paths, cleans every copied fixture; removes internal check-name assertion |
| `test/unit/voice-models.test.ts` | 252 | — | Pending |
| `test/unit/voice.test.ts` | 434 | — | Pending |
| `test/unit/web-target.test.ts` | 321 | — | Pending |
| `test/unit/zip-writer.test.ts` | 90 | — | Pending |
| `test/unit/zip.test.ts` | 19 | — | Pending |

## Remaining work

Review the pending inventory. Start with edit/undo, session consistency, validation and persistence in core; update/download state, agent detection, quotas and generation in app. Then work down the largest suites. Preserve every unique behaviour. Record environmental limits and any failures without disguising them as passes.
