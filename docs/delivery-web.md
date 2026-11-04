# Delivery: the web target

Build a module for a plain web server when there is no LMS: a course on a website, a review link, a publication on Elabora's hosting ([D41](decisions/D41.md)). Any static host can serve it. `elabora publish` sends it to Elabora's hosting ([Delivery targets and hosting](architecture/delivery.md)).

## Build

```bash
cd examples/canal-locks
elabora build . --target web
```

The build writes to the course's `dist/` folder:

```
dist/<id>-<version>-web/             the folder to serve, as it is
dist/<id>-<version>-web.zip          the same files, deterministic (D8)
dist/<id>-<version>-web.report.json  the build report: target "web", web { progress, navigation, noindex, url, image }
dist/<id>-<version>-web.proof.md     the proof dossier, with « Diffusion web »
```

The folder holds `index.html`, `elabora/` (the player, the compiled course and its theme), `assets/`, `theme/`, `components/`, `objects/` and, with `--image`, `share.png`, `share.jpg` or `share.webp`. LMS profiles apply to SCORM packages only, so the web target refuses `--profile`.

| Option | Values | Default |
|---|---|---|
| `--progress` | `local` keeps the lesson location, status, score and suspend data in the browser's `localStorage` (`elabora:web:<course id>`). The next visit resumes there, across updates of the course (its permanent keys, D4). The browser forgets it a year after the last visit. `none` keeps nothing: a reload starts again. | `local` |
| `--navigation` | `authored` follows the course's navigation rules and locks. `free` opens every screen from the outline and Next, with nothing to complete, hear or visit first, and narrations seekable. | `authored` |
| `--noindex` | Adds `<meta name="robots" content="noindex">`. | indexable |
| `--url <address>` | The module's absolute address (`https://…/`): canonical link, `og:url` and the sharing image's address. | none |
| `--image <file>` | A PNG, JPEG or WebP shown when the link is shared (1200×630 reads well everywhere): `og:image`, `twitter:card summary_large_image`. | none |
| `--review-origin <origin>` | Repeatable. Builds a module for the Revue, shown in an iframe by a page of that origin (`https://revue.elabora.studio`, or `http://localhost:<port>` while developing). It adds the review bridge, `elabora/review.js`, which speaks `elabora-review/1` with that page only ([Review bridge](review-bridge.md), D42). Its defaults become `--progress none --navigation free --noindex`. | none: a plain module |

The page's title is the course's `title`, and its description the course's `description` (`course.json`). Give the sharing image with `--image`: an image of the course's `assets/`, or the app's project thumbnail. The command line reads `--image` from the current folder, so run these builds from the course folder.

MCP: `elabora_build { target: "web", web: { progress, navigation, noindex, url, image, review: { origins } } }`, with `image` relative to the course folder. Engine: the build request takes `target` and `web`, and returns `dir` beside `zip`.

## Recipes

Run these from the course folder.

- **A showcase.** Visitors go where they like, and nothing is kept:
  `elabora build . --target web --progress none --navigation free --url https://example.com/<id>/ --image assets/images/cover.jpg`
- **A publication.** Learners resume where they left, and the course runs as designed:
  `elabora build . --target web --url https://example.com/<id>/ --image assets/images/cover.jpg`
  Add `--release` for a client delivery: it requires an approved plan.
- **A private link** for a quick review: `elabora build . --target web --navigation free --noindex`
- **A link for the Revue**, where reviewers comment on the module in an iframe of revue.elabora.studio:
  `elabora build . --target web --review-origin https://revue.elabora.studio`
  Add `--review-origin http://localhost:5173` while developing the review page. Serve the module with `Content-Security-Policy: frame-ancestors https://revue.elabora.studio`, so only the Revue can frame it.

Then serve the folder over HTTPS, open the address, reload, and check the sharing preview. The proof dossier lists that check as pending until a person does it.

## Runtime

- A web module runs on its own. The player skips the LMS search, the preview's banner and the Quit button.
- A module of several languages (`--languages all`, D59) opens in the one its address asks for, `?lang=fr`, when it has it: a site that frames or links the module in its own language. The language the learner chose, kept with the progress, comes first.
- An event's `exit` action still ends the visit, with a message for the web: the progress stays in this browser (`local`, label `webEndedKept`), or nothing is kept (`none`, `webEndedNotKept`).
- The player commits as in a SCORM package: after each change, on `visibilitychange: hidden`, on `pagehide` and every `heartbeatSeconds`. With `local`, each commit writes the kept elements to `localStorage` with the date (`savedAt`). A progress saved more than a year ago is removed when the module opens, and the visit starts afresh. When storage is refused or full, the visit keeps its progress in memory and carries on.
- `none` writes nothing to the browser: `localStorage`, `sessionStorage` (the narration's preferences included) and cookies stay empty.
- With `local`, the learner sees where the progress is kept and can clear it. The outline ends with « Your progress stays in this browser. » and « Clear my progress », also shown on the page an `exit` leaves. The button asks once, then removes `elabora:web:<course id>` and starts the module again (labels `progressKept`, `clearProgress`, `clearProgressConfirm`, `clearProgressYes`, `cancel`; D41).

## What the host must provide

- **One origin per publisher, at least.** `localStorage` belongs to an origin: two courses with the same id on one origin share their progress, and one course's pages can read another's storage.
- **A clean origin for each new owner.** Whoever serves a module next at the same address runs their scripts on that origin, and could read what learners' browsers kept. Elabora's hosting clears the origin's storage in the browser (`Clear-Site-Data`) when a handle changes owner, and a year after a learner's last visit.
- **HTTPS**, the folder served as it is (it uses relative paths), and `index.html` at the folder's address.
- **`X-Robots-Tag: noindex` on every file** to keep a whole publication out of search engines. Free objects run in frames that are pages of their own, and the meta tag covers `index.html` only.
