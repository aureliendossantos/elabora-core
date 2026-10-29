---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/cli: minor (Added)
---

Sounds for an app's sound browser (D67). The engine runs `add_sound`, which can place the sound's line in a narration in the same change, and answers `soundSearch` (the library or Openverse), `soundPreview` (a sound's bytes before it is added), `courseSounds`, `soundEstimate` and `generateSound`. Sound lines are edited with `update_narration_line` (sound, caption, volume, pause before), moved and removed like voice lines; `update_course` writes `sounds`. Libraries besides « Sons courants » come from `ELABORA_SOUND_LIBRARIES` (folders with a `catalogue.json`); a library sound's sidecar keeps its credit, and its title in the course's language. A cut sound is AAC 256 when ffmpeg has no FLAC encoder. `elabora sound search` shows the licence and author of the library sounds that are not CC0.
