# Delivery: the web target

A module for a plain web server, without an LMS (docs/decisions.md D41): the course shown on a site, a review link, a publication on Elabora's servers. Hosting itself is not in the core.

## Build
`elabora build . --target web` writes, next to the SCORM packages:

```
dist/<id>-<version>-web/            the folder to serve, as it is
dist/<id>-<version>-web.zip         the same files, deterministic (D8)
dist/<id>-<version>-web.report.json the build report: target "web", web { progress, navigation, noindex, url, image }
dist/<id>-<version>-web.proof.md    the proof dossier, with « Diffusion web »
```

The folder holds `index.html`, `elabora/` (player, compiled course, theme), `assets/`, `objects/` and, with `--image`, `share.png|jpg|webp`. No `imsmanifest.xml`; no LMS profile applies (`--profile` is refused).

| Setting | Values | Default |
|---|---|---|
| `--progress` | `local`: the lesson location, status, score and suspend data in the browser's `localStorage` (`elabora:web:<course id>`), resumed at the next visit, across updates (the permanent keys of D4); `none`: nothing kept anywhere, a reload starts again | `local` |
| `--navigation` | `authored`: the course's navigation rules and locks; `free`: every screen open from the outline and Next, nothing to complete, hear or visit first, narrations seekable | `authored` |
| `--noindex` | `<meta name="robots" content="noindex">` | indexable |
| `--url <address>` | the absolute address of the module (`https://…/`): canonical link, `og:url`, the sharing image's address | none |
| `--image <file>` | PNG, JPEG or WebP shown when the link is shared (1200×630 reads well everywhere): `og:image`, `twitter:card summary_large_image` | none |
| `--review-origin <origin>` | repeatable: a module for the Revue, shown in an iframe by a page of that origin (`https://revue.elabora.studio`; `http://localhost:<port>` for development). It carries the review bridge, `elabora/review.js`, and speaks `elabora-review/1` with that page only ([review-bridge.md](review-bridge.md), D42); its defaults become `--progress none --navigation free --noindex` | none: no bridge, the module unchanged |

The page's title is the course `title`, its description the course `description` (`course.json`). The course has no thumbnail of its own: give one with `--image` (an image of the course's `assets/`, or the app's project thumbnail).

MCP: `elabora_build { target: "web", web: { progress, navigation, noindex, url, image, review: { origins } } }` (`image` relative to the course folder). Engine: the build request takes `target` and `web`, and returns `dir` beside `zip`.

## Recipes
- **A showcase** (the marketing site: a visitor goes where they like, nothing is kept):
  `elabora build . --target web --progress none --navigation free --url https://elabora.studio/vitrine/<id>/ --image assets/images/cover.jpg`
- **A publication** (learners on the web, resuming where they left, the course as designed):
  `elabora build . --target web --url https://<host>/<id>/ --image assets/images/cover.jpg` (add `--release` for a client delivery: the plan must be approved)
- **A private link** (a review before the review tools): `elabora build . --target web --navigation free --noindex`
- **A link for the Revue** (reviewers comment in revue.elabora.studio, which shows the module in an iframe): `elabora build . --target web --review-origin https://revue.elabora.studio` (add `--review-origin http://localhost:5173` while the page is developed). Serve it with `Content-Security-Policy: frame-ancestors https://revue.elabora.studio` so no other site frames it.

Then serve the folder over HTTPS, open the address, reload, and check the sharing preview (the pending gate of the proof dossier).

## Runtime
- The player never looks for an LMS in a module for the web, and shows neither the preview's banner nor Quit. An event's `exit` action still ends the visit, with a message of the web's own: the progress is kept in this browser (`local`, label `webEndedKept`), or nothing is kept (`none`, `webEndedNotKept`).
- Commits are those of a SCORM package (after each change, on `visibilitychange: hidden`, on `pagehide`, every `heartbeatSeconds`); with `local` each writes the kept elements to `localStorage`. A refused or full storage keeps the visit's progress in memory, never an error.
- `none` writes nothing: no `localStorage`, no `sessionStorage` (the narration's preferences included), no cookie.
- With `local` the learner is told where the progress is, and may clear it: the outline ends with « Votre progression reste dans ce navigateur. » and « Effacer ma progression » (also on the page an `exit` leaves), which asks once, then removes `elabora:web:<course id>` and starts the module again (labels `progressKept`, `clearProgress`, `clearProgressConfirm`, `clearProgressYes`, `cancel`; D41).

## What the host must give
- **One origin per publisher at least.** `localStorage` is per origin: two courses with the same id on one origin share their progress, and a course's pages can read another's storage.
- HTTPS, the folder served as it is (relative paths), `index.html` for the folder's address.
- For a whole publication out of search engines, `X-Robots-Tag: noindex` on every file: the free objects' frames are pages of their own, without the meta tag.
