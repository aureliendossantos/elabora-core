# Delivery: cmi5

cmi5 is xAPI with the rules an LMS needs: how it imports a course (`cmi5.xml`), how it launches it, and which statements say that the learner started, completed, passed or failed. The LMS keeps the statements in its own learning record store (LRS). Few LMSs import cmi5 packages today ([Delivery formats](delivery.md#how-elabora-picks)): Elabora never picks it by itself; a module forces it (`course.json` `delivery.format` `cmi5`).

## Package

`elabora build --format cmi5` writes `<id>-<version>-cmi5.zip`, its report and its proof dossier. The ZIP holds the files of every package ([SCORM 1.2](delivery-scorm12.md#package)) with `cmi5.xml` at its root instead of `imsmanifest.xml`, and `elabora/lms.js`, which connects to the LMS before the player starts:

```xml
<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">
  <course id="urn:elabora:course:<id>">…</course>
  <au id="urn:elabora:course:<id>/au" moveOn="Completed" launchMethod="AnyWindow">
    <url>index.html</url>
  </au>
</courseStructure>
```

- **One AU**, launched from `index.html`.
- **moveOn** follows `completion.reportAs`: `Completed` for a course that reports its completion, `Passed` for one that reports success, with `masteryScore` (0 to 1) from `completion.masteryScore`.
- **launchMethod `AnyWindow`**: the LMS opens the course where it wants. 360Learning asks for it when it opens courses in a popup.
- **The activity id** is `urn:elabora:course:<id>`, or `course.json` `delivery.activityId` (an IRI the client owns). It does not change with the version: an LMS adds the statements of every version up.

## Runtime behaviour

The player behaves as in every format ([Delivery formats](delivery.md#one-player-every-format)). What cmi5 adds:

| Step | What the package does |
|---|---|
| Launch | `elabora/lms.js` reads `endpoint`, `fetch`, `actor`, `registration` and `activityId` from the address; POSTs the fetch URL once for the token (kept for the tab: a reload goes on with it); reads `LMS.LaunchData` (context template, launch mode, moveOn, mastery score), the learner's preferences (`cmi5LearnerPreferences`, which a cmi5 LMS requires before `initialized`; a package of several languages opens in the first of their `languagePreference` it holds, D71) and the learner's last progress; then starts the player. No synchronous request. |
| Start | `initialized`, with the context template (the session id), the registration and the cmi5 category. |
| Progress | The place, the suspend data, the status and the score in one State API document (`stateId` `elabora-progress`), written after each change that matters, as SCORM commits: a relaunch reads it back. |
| Completion | `completed` (result `completion`, `duration`) once per registration, with the moveOn category, when the course is complete (or passed or failed: the learner went through it). |
| Success | `passed` or `failed` (result `success`, `score.scaled`, `raw`, `min`, `max`, `duration`), with the moveOn category and, when the LMS gives a `masteryScore`, the `https://w3id.org/xapi/cmi5/context/extensions/masteryscore` extension (required by cmi5). Passed once; never failed after passed. The LMS's `masteryScore` decides the success when it gives one. |
| Answers | `answered`, one per answer, on `<activity>/interactions/<id>` (`cmi.interaction`, the same responses as SCORM 2004's: `a[,]b`, `1[.]a`), with the objective. |
| End | `terminated` (result `duration`) on Quit, or when the page goes away (`pagehide`, with `keepalive`). Nothing after it. |
| Browse, Review | No `completed`, `passed` or `failed`. |
| returnURL | Not followed: with `AnyWindow`, the LMS brings the learner back. |

Requests go one after the other, in order, without waiting: the learner never waits for the LRS. Each carries `X-Experience-API-Version: 1.0.3` and the token. Statements are xAPI 1.0.3, what LRSs of 2026 take (xAPI 2.0 LRSs too).

Without launch parameters (a file opened directly), the player runs alone, as a SCORM package without its LMS.

## Suspend data

cmi5 sets no limit: the state document holds what the player keeps. The build checks the worst case against 64,000 characters, SCORM 2004's, so that a module can change format.

## Emulator (`elabora test`)

The emulator plays an LMS with an LRS (`packages/node/src/emulator/lrs.ts`): it writes `LMS.LaunchData` (a new session each launch), gives the token once, keeps the state documents and the statements, and gives a `languagePreference` with `&learnerLanguage=en-US,fr` on `/lms/launch.html`, refuses what an LMS refuses: a second fetch, `initialized` before the learner's preferences are read, `passed` or `failed` without the masteryscore extension, a statement of another session, before `initialized` or after `terminated`, a second `completed` or `passed` in the registration, `failed` after `passed`, a request without the token or without `X-Experience-API-Version`. Then the scenario of every format: navigation, an abrupt close (the place and the suspend data in the state document), the relaunch on the same screen, completion with the right status and a score of 100, Quit sending `terminated`, no request refused, a review session without regression.

```bash
elabora test examples/diagnostic-reseau --format cmi5 --profile scorm-cloud
elabora test --package course-cmi5.zip --profile 360learning
```

## Beyond the emulator

- **Few LMSs take it.** 360Learning imports cmi5 but cannot preview it; TalentLMS (in beta in 2025), Bridge, the LMSs built on Rustici Engine and SCORM Cloud take it; Moodle needs a plugin and an LRS of its own; SAP SuccessFactors, Workday, Cornerstone and Docebo document none.
- **Financing in France.** 360Learning leaves xAPI courses out of its OPCO reports. Whether cmi5 courses are in them is not documented: ask before delivering a module that an OPCO finances.
- **SCORM Cloud** (6 Nov 2026, `scripts/scorm-cloud-trial.ts`): `diagnostic-reseau` imported, launched, closed abruptly, relaunched on the same screen, completed: COMPLETED, PASSED, score 100, no statement refused. SCORM Cloud refused the two rules the emulator now checks (the preferences read before `initialized`, the masteryscore extension). Then try it with a test learner in the client's LMS.
