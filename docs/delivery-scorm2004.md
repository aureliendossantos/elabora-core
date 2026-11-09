# Delivery: SCORM 2004

SCORM 2004 is the second edition of SCORM that LMSs still take. It reports completion and success separately, with a scaled score, and keeps 64,000 characters of suspend data (SCORM 1.2: 4,096). Elabora builds the 4th edition, or the 3rd for an LMS that stops there, as one SCO without sequencing beyond the simplest. [Delivery formats](delivery.md) says when Elabora picks it.

## Package

`elabora build` writes `<id>-<version>-scorm2004.zip`, its `.report.json` and its `.proof.md`, as for SCORM 1.2 ([SCORM 1.2](delivery-scorm12.md#package)): the same files, but `imsmanifest.xml` is SCORM 2004's:

```
imsmanifest.xml   SCORM 2004, schemaversion "2004 4th Edition" (or "2004 3rd Edition"), one SCO,
                  imsss:deliveryControls completionSetByContent and objectiveSetByContent true
```

- **One SCO, no sequencing.** LMSs handle SCORM 2004's sequencing unevenly (Docebo and LearnUpon not at all). The only sequencing is the item's delivery controls: the content sets the completion and the success itself, so an LMS does not mark the activity completed when the window closes.
- **The passing score is the player's.** The manifest has no objective with a `minNormalizedMeasure`: the player reports the success itself, from `completion.masteryScore`. An LMS cannot recompute the success from the score, as Moodle does in SCORM 1.2.
- **The edition.** The 4th by default; the 3rd when an LMS of the module documents the 3rd and not the 4th (Docebo), or prefers the 3rd (Cornerstone). One SCO without sequencing calls the same API in both: only `schemaversion` changes.
- **Identifiers** derive from the course id, as in SCORM 1.2. A package in another format is another course for an LMS.

## Runtime behaviour

The player behaves as in SCORM 1.2 ([SCORM 1.2](delivery-scorm12.md#runtime-behaviour)): it finds the API in the same windows, initialises once, commits after every change and on `visibilitychange` and `pagehide`, never registers `unload`. The adapter (`packages/player/src/scorm2004.ts`) translates what it says:

| SCORM 1.2 | SCORM 2004 |
|---|---|
| API `API`, `LMSInitialize`… | API `API_1484_11`, `Initialize`, `Terminate`, `GetValue`, `SetValue`, `Commit` |
| `cmi.core.lesson_status` passed / failed | `cmi.completion_status` completed and `cmi.success_status` passed / failed |
| `cmi.core.lesson_status` completed / incomplete | `cmi.completion_status` completed / incomplete |
| `cmi.core.lesson_location` | `cmi.location` |
| `cmi.core.score.raw`, `min`, `max` | `cmi.score.raw`, `min`, `max`, and `cmi.score.scaled` (raw over the range, 0 to 1) |
| `cmi.core.exit` suspend / "" | `cmi.exit` suspend / normal |
| `cmi.core.session_time` HHHH:MM:SS.SS | `cmi.session_time` PT#H#M#S |
| `cmi.core.entry`, `student_name`, `student_id` | `cmi.entry`, `learner_name`, `learner_id` |
| `cmi.interactions.n.time` | `cmi.interactions.n.timestamp` (date and time) |
| `cmi.interactions.n.student_response` | `cmi.interactions.n.learner_response` |
| result `wrong` | result `incorrect` |
| responses `a,b`, `1.a,2.c` | responses `a[,]b`, `1[.]a[,]2[.]c` |
| numeric pattern `5` | numeric pattern `5[:]5` |
| `performance` (a free object's free answers) | `other` |
| `cmi.student_preference.language` (the learner's language, read by a package of several languages, D71) | `cmi.learner_preference.language` |

The status is read back as SCORM 1.2's: passed or failed when the success says so, else the completion. It never regresses, as in SCORM 1.2.

## Suspend data

SCORM 2004 3rd and 4th editions keep 64,000 characters. The build checks the worst case against the profiles' `suspendDataMax.scorm2004`: SAP SuccessFactors documents 4,000 (the 2nd edition's figure, to be measured), the unknown LMS assumes 4,000 too.

## Emulator (`elabora test`)

The emulator plays scorm-again's `Scorm2004API` as `API_1484_11`, with the profile's quirks (launch topology, suspend data limit and enforcement), and runs the scenario of SCORM 1.2 ([SCORM 1.2](delivery-scorm12.md#emulator-elabora-test)): API found, navigation, abrupt close (location, suspend data and `cmi.exit = suspend` kept), resume, completion with the expected status and a score of 100, Quit calling `Terminate`, every `SetValue` accepted (scorm-again checks each value's format), a review session without regression.

```bash
elabora test examples/diagnostic-reseau --profile scorm-cloud
elabora test examples/phishing-by-numbers --format scorm2004 --profile successfactors
elabora test --package course-scorm2004.zip --profile docebo
```

`--package` reads the format from `imsmanifest.xml` (`schemaversion` 2004 or CAM 1.3).

## Beyond the emulator

The emulator plays documented behaviour. Before a delivery: a smoke test in SCORM Cloud (it shows completion and success separately), then a test learner in the client's LMS. Watch:

- **SAP SuccessFactors**: the 4,000 characters of suspend data it documents for SCORM 2004; the 2nd and 4th editions are documented, the 3rd only within the 2nd's features.
- **Cornerstone**: the 4th edition runtime arrived with release 26.2 (September 2026); the package declares the 3rd.
- **Moodle and Totara**: they do not take SCORM 2004 (Moodle's support is partial and closed as won't fix): Elabora picks SCORM 1.2 for them, and a module that forces SCORM 2004 stops with `E_STANDARD_NOT_SUPPORTED`.
