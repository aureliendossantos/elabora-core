# Delivery formats

A module for an LMS ships in one format. Most authors do not know these standards, and they should not have to: Elabora picks the format, and the module can force another.

| Format | What it is | Read |
|---|---|---|
| `scorm12` | SCORM 1.2, one SCO. Every LMS takes it: the safest. | [SCORM 1.2 and the LMS emulator](delivery-scorm12.md) |
| `scorm2004` | SCORM 2004, 4th edition (3rd for an LMS that stops there), one SCO without sequencing. Completion and success apart, a scaled score, 64,000 characters of suspend data. | [SCORM 2004](delivery-scorm2004.md) |
| `cmi5` | xAPI with an LMS's rules: `cmi5.xml`, the LMS's launch and its LRS. The most recent; few LMSs import it. | [cmi5](delivery-cmi5.md) |
| `xapi` | xAPI alone (Tin Can): `tincan.xml`. **It needs an LRS**: the LMS's, or one set for a module outside an LMS. | [xAPI](delivery-xapi.md) |

A module for a plain web server, without an LMS, is the web target: [Web target](delivery-web.md).

## How Elabora picks

`course.json` says it in `delivery`:

```json
"delivery": { "lms": ["moodle"], "format": "auto" }
```

- **`format` is `auto` (or absent).** Elabora picks:
  - **one LMS** (`delivery.lms`): the best format of its profile (`bestFormat`, with its reasons and sources: [LMS profiles](lms-profiles.md));
  - **several LMSs**: their best format when they share it; else SCORM 2004 when each of them takes it and none prefers SCORM 1.2; else SCORM 1.2;
  - **no LMS**: SCORM 1.2, the one format every LMS takes.
  - Elabora never picks cmi5 or xAPI by itself: they serve an LMS or a client that asks for them.
- **`format` names a format.** The package is in it. An LMS whose profile says it refuses the format stops the build (`E_STANDARD_NOT_SUPPORTED`); an LMS that may not take it, or no LMS at all, warns (`W_STANDARD_UNSURE`).
- **`elabora build --format <format>`** (MCP `elabora_build` `format`) says it for one build.

The SCORM 2004 edition follows the LMSs: the 4th, unless one of them documents the 3rd and not the 4th (Docebo), or prefers the 3rd (Cornerstone). One SCO without sequencing calls the same API in both.

What the build chose is in the package's name (`<id>-<version>-<format>.zip`), in its report (`delivery`: the format, its edition, `how` auto or forced, `why` and the LMSs) and at the top of its proof dossier.

| LMS | Format picked |
|---|---|
| Moodle, Totara, Teach Up, no LMS | SCORM 1.2 |
| 360Learning, Rise Up, SAP SuccessFactors, Workday, SCORM Cloud | SCORM 2004 (4th edition) |
| Cornerstone, Docebo | SCORM 2004 (3rd edition) |

## One player, every format

The player talks to every LMS through the same data model, SCORM 1.2's: an adapter per format translates it (`packages/player/src/scorm12.ts`, `scorm2004.ts`, `xapi.ts` for cmi5 and xAPI). cmi5 and xAPI talk to the LMS's LRS over HTTP: their package starts with `elabora/lms.js` (`lms-boot.ts`), which connects before the player starts, without a synchronous request; then the adapter keeps what the player sets and sends it in order, without making the learner wait. What the player does is the same in every format: when it commits, how a session ends without `unload`, when a status is final, what it keeps for a resume. The format changes what the LMS receives.

`elabora preview` (and the app's Aperçu) plays SCORM 1.2 whatever the module's format: the Aperçu reads the emulator's calls by SCORM 1.2's names. `elabora test` runs the package in its own format.

## Tests

`elabora test` builds the package in the module's format and runs it in the LMS emulator, which plays that format: scorm-again's `Scorm12API` or `Scorm2004API` with the profile's quirks, an LMS with its LRS for cmi5 and xAPI (`emulator/lrs.ts`). `elabora test --package file.zip` reads the format from the package's files (`imsmanifest.xml` and its `schemaversion`, `cmi5.xml`, `tincan.xml`).

`elabora test --format <format>` tests another format than the module's.

## Changing the format of a module already delivered

Another format is another course for an LMS: learners in progress lose their place, and the LMS usually asks for a new course. `elabora diff` says so (the structure changed).
