# The plan and its versions

The plan as a working copy, the versions a person freezes, what changed between them, and the plan's document. Part of the [architecture](../architecture.md), the contract every change follows.

## Versions (D52)

`plan.json` is always the working copy. `plan-versions/V<n>.json` holds its versions: frozen copies made by a person (their number, day, content hash and plan never change; their `sends` and their `validation` are added). `plan-versions/notes.json` holds the author's notes for the client on the changes in no version yet. `loadProject` reads them into `Project.planVersions` and `Project.planNotes`; no package carries them, archives and backups do.
- **State and references** (`@elabora/core` `project/plan-versions.ts`):
  - `usableVersions`: the versions whose plan gives their hash.
  - `planState`: `draft` without a validated version, `approved` when the working copy is the latest validated version, `modified` otherwise.
  - `planVersionsView`: every version made, sent and validated; the two references of the app (the changes since the latest validated version, its marks, and those in no version yet, its pill's count); what an export shows by default and how many changes it would not show; the verbatim texts changed since the validation.
  - `planDiffBetween(project, { from, to })`, `notesFor`, `describePlanVersions` (a line for agents and the command line).
- **The diff** (`project/plan-diff.ts` `planDiff(base, current, course?)`) matches the elements of two plans by their ids (objectives, items, texts and questions wherever they are, sources, and the plan's own fields). Each element is reported as:
  - added, removed or changed;
  - moved, judged from its position: the elements around it that kept their order did not move (the longest common subsequence);
  - an item's part changed. The part is the one the item belongs to (`effectiveParts` in `project/plan-order.ts`): its own, else the one before it, and in a plan without parts the title of its section in the course (`planCourse(project)`, which every caller with a project gives). An item whose part was only written down, from none to the part it was in, did not change part, so a drag counts once. A base with no parts and no course has none to compare;
  - each field changed, with its texts word by word (`diffRich`);
  - `verbatim` for a text the base kept « à l'identique ».

  Every change has a key (`item:ITEM-3`) that notes and `revertPlanChange` (« Revenir à la V2 ») use.
- **Rules** (`validate/plan.ts`, `validate/structure.ts`): `W_PLAN_DRAFT`, `E_PLAN_NOT_APPROVED` for release builds without a validated version, `W_PLAN_MODIFIED_SINCE_VALIDATION`, `W_PLAN_VERBATIM_CHANGED`, `E_PLAN_VERSION_INVALID`. The build report's `plan.validated` and `plan.changesSince`, and the proof dossier, say the version a release is built against and the changes delivered since.

## The plan's document (D48, D52)

The document is what the client reads, comments and signs: one version of the plan, the latest by default, or its working copy. Its head gives the properties (status, version, validated by, the module's duration and delivery, the history of the versions up to it), followed by six sections (framing, objectives, sequence, validated texts, assessments, sources), in the module's language (French, else English).
- **The model** (`@elabora/core` `plan-document/model.ts` `planDocument(project, { date, version })`, format `elabora/plan-document/2`; `planDocumentTarget` says what a version option shows): data without layout, read by every renderer (the exports, the app's Document view, later a review link that shows the plan alone). Each text is given as the plan's Markdown and as rich-text data (`plan-document/rich.ts`: paragraphs, lists, tables, quotes, code, maths, with marks), so no renderer parses Markdown. Changes since the latest validated version, up to the one shown, appear in place: a changed text is one text whose words are marked deleted or inserted (`diffRich`, `diffPlain` for titles), an added element is all inserted, and a removed element stays in its old place, all deleted. Each carries its `mark` (« Modifié · déplacé, c'était le point 4 ») and the author's note for the client. It never says who wrote the plan or a change.
- **HTML** (`plan-document/html.ts`): one page, its sections in `<details>` that fold on screen; a changed element is marked in the margin's blue, a changed verbatim text in amber, the notes for the client in the margin on a wide screen and under their element in print; an `@page` rule gives A4, margins and a footer (the title, « Page n / N »), so a print needs no header or footer template. `@elabora/node` `plan-document.ts` adds the fonts inline (Inter and JetBrains Mono from `@elabora/fonts`, WOFF2 data URIs): the same page prints the same everywhere.
- **PDF**: that page printed by Chromium, in one of two ways. The same Chromium gives the same bytes, because `finishPlanPdf` sets the file's dates to the document's day (the app's and the command line's files are the same).
  - `PLAN_PDF_ELECTRON`: Electron's `webContents.printToPDF` in an offscreen window of `PLAN_PDF_WINDOW`. The app uses it, and the command line when the app is installed (`printPlanDocument` through a browser worker, `emulator/electron.ts` `printWithElectron`, since Electron's DevTools protocol has no `Page.printToPDF`).
  - `PLAN_PDF_PLAYWRIGHT`: Chrome, Edge or Playwright's Chromium: tagged, with an outline from the headings.
- **Word** (`plan-document/docx.ts`, `omml.ts`): WordprocessingML written by hand and zipped by `createZip` (D8). It uses Word's own styles (Title, Heading 1 to 3) and named styles of its own (`Elabora …`), with no direct formatting but the plan's own emphasis. Tables appear for the properties and the plan's own tables only. Maths are Word equations (OMML, from temml's MathML). The changes since the validated version are tracked changes (author « Depuis la V2 validée », no date), and the notes for the client are comments (`word/comments.xml`, author « Note pour le client ») on the range of their element. A bookmark surrounds every objective, item, validated text, question and source, `wordBookmarkName(id)` (`el_` then the id, « - » as « _ », « _ » as « _u »), read back by `planIdOfBookmark`.
- **Where.**
  - CLI: `elabora plan export [dir] [--version Vn|current] [--format pdf|docx|html] [--out] [--date]` (default `dist/<course id>-plan.<format>`).
  - MCP: `elabora_export_plan_document { format, version }`.
  - `@elabora/node/plan-document`: `exportPlanDocument` (which records the send on the version it shows, one change: `record_plan_send`), `writePlanDocument` (the file only: the engine records the send through its queue), `readPlanDocument`, `planDocumentPage`, `planDocumentWord`, `printPlanDocument`.
  - The engine's requests above.

  Exporting never makes a version.
