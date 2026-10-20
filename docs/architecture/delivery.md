# Delivery targets and hosting

The SCORM 1.2 and web targets of one build, and the core as the client of Elabora's hosting. Part of the [architecture](../architecture.md), the contract every change follows.

## Delivery targets (D41)

One build, two targets (`BuildOptions.target`, `elabora build --target`, MCP `elabora_build` `target`, the engine's build request `target`):

| | `scorm12` (default) | `web` |
|---|---|---|
| Output | `dist/<course>-<version>-scorm12.zip` (`--dir`: the folder too) | `dist/<course>-<version>-web/` and its ZIP |
| Files | `imsmanifest.xml`, `index.html`, `elabora/`, `assets/`, `objects/` | the same without `imsmanifest.xml`; `share.<ext>` with `--image` |
| Checks | LMS profiles (`delivery.lms`, `--profile`): suspend data budget, package limits, forbidden extensions | no LMS (`validateProject` `target: 'web'`); portable file names |
| `index.html` | title | title, description, Open Graph and Twitter card, `robots` (`noindex`), canonical (`url`), sharing image |
| Player | SCORM 1.2 adapter when an LMS is found, else the preview's standalone adapter (sessionStorage, banner) | web adapter (`web.ts`): `progress` `local` (localStorage, `elabora:web:<course id>`) or `none`; no banner, no Quit, no LMS search |
| Navigation | the course's rules | `navigation` `authored` (the course's rules) or `free`, applied by the compiler in the course data (`mode: free`, no `lockUntilComplete`, outline shown, narration `seek` `seen` → `free`) |

The settings live in the build, not in `course.json`: the same course is published as a showcase, a review and a publication. The compiled course says them in `delivery` (`{ target: 'web', progress, navigation }`), the build report in `web` (with `noindex`, `url`, `image`), and the proof dossier in « Diffusion web ». `docs/delivery-web.md` gives the recipes.

**Review builds (D42).** `--review-origin <origin>` (repeatable; `web.review { origins }`) makes a module for the Revue: the build adds `elabora/review.js` (`@elabora/player` `review.ts`, after `player.js` in `index.html`) and `delivery.review { origins, languages }` to the course data; the player's files are unchanged, and a build without it is unchanged byte for byte. The bridge speaks `elabora-review/1` (`review-protocol.ts`: types and pure functions a review page may import) with the page that frames the module, only with the origins named: where the reviewer is (`ready`, `location`), where every block is (`blocks`, the canvas's `layout-report.ts`), the text size and column (`layout`, `measure`), and it goes to an anchor, pauses the narration and moves its column aside for a floating panel. It drives the player through the hooks of the same build. `docs/review-bridge.md` is the protocol.

## Hosting (D43)

`@elabora/node` `cloud/` is the client of Elabora's hosting (its protocol, version 3; the API at `https://api.elabora.studio`, `ELABORA_CLOUD_URL` for tests). `elabora account`, `elabora publish` and `elabora review` call it, and the MCP server's two read tools; the app will.

| Module | Role |
|---|---|
| `client.ts` | `CloudClient` (one request, a bearer credential, JSON or raw bytes), `CloudError` (the API's status, stable code, message, details, `Retry-After`; `E_CLOUD_*` codes for this side), `cloudUrl` (HTTPS, or HTTP on this computer), secrets masked in messages |
| `credentials.ts` | The session token (`<local data>/credentials/elabora-session`) and a tester's invitation key (`credentials/elabora-invitation`), 0600 files naming their API; `ELABORA_CLOUD_KEY_FILE`; a credential is only sent to its API |
| `account.ts` | Sign-in by code (`startSignIn`, `verifySignIn` writes the session), the handle once, status with limits and usage, sign-out; `connect` (the client and the space), `guard` (a 401 ends a session) |
| `publish.ts` | `publishCourse` (a web build in a temporary folder: a review build for a private publication, the address as canonical and `noindex` for a public one), `publishFolder` (hash, announce, send the missing blobs whole or in parts, commit), `publishBuiltFolder`; a new private version goes to the publication's open reviews |
| `reviews.ts` | The author's review routes: create, list, link, state, versions, delete; comments with `since`, reply, resolve, reopen; `courseReviews` (by the publications' `meta.course.id`) |
| `records.ts` | What this computer published of a course, in `<project data>/cloud/publications.json`: each version, its course version and a hash of every screen then |
| `resolve.ts` | `resolveComments`: each comment placed in the sources (screen by permanent key → id, title, file; block → type, pointer, layer; step, layer, line and word; translation; point and frame), with `newerInReview` and `screenChanged` |
| `types.ts` | The protocol's shapes and the resolved comments, without imports (the app window may name them) |

Publishing, sharing, answering and resolving are people's gestures: the MCP server only reads (`elabora_review_list`, `elabora_review_comments`).
