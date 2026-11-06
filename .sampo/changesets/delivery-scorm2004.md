---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/cli: minor (Added)
---

SCORM 2004 packages, and a format Elabora picks for the module's LMS (docs/delivery.md). `course.json` `delivery.format` is `auto` by default: the best format of the LMS's profile (a new `bestFormat`, with its reasons), the one several LMSs share, else SCORM 1.2, which every LMS takes; `scorm12` or `scorm2004` forces one, and `elabora build --format` (MCP `elabora_build` `format`) says it for one build. SCORM 2004 is the 4th edition, or the 3rd for Docebo and Cornerstone, one SCO whose content sets completion and success (docs/delivery-scorm2004.md): the player sends completion and success apart, a scaled score, 64,000 characters of suspend data, ISO 8601 times and SCORM 2004's interactions. The build report and the proof dossier say the format and why; the package is named after it (`-scorm2004.zip`). `elabora test` runs the package in its format (scorm-again's Scorm2004API as `API_1484_11` in the emulator), `--package` reads it from the manifest. A format an LMS refuses stops the build (E_STANDARD_NOT_SUPPORTED), one it may not take warns (W_STANDARD_UNSURE). The engine's build passes a format target through.
