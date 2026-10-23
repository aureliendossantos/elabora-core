---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

A dialogue's lines have voices (D61). Every line of a dialogue block with a speaker is a voice line of its screen, and with `learnerVoice` so is each answer of the learner (the line `<node>.<option>`): `elabora voice generate`, takes, alignment, recordings, transcription and the audio's checks see them, missing audio is told once per dialogue, and their translation units mark the words their cues wait for and their stage directions. A line id taken twice in the screen is now always `E_NARRATION_LINE_DUPLICATE`, whatever holds the lines (`E_DIALOGUE_DUPLICATE_ID` keeps nodes, options, endings and variables). Packages ship each line's audio at their media quality, `narration/<screen>.<block>/<line>.m4a`, and the course data gives each line its `voice` (`src`, `duration`, `words`, `mouth`, `estimated`; estimated from the text without audio) and each cue its `time`. The sidecar of a line's audio takes `mouth`, the mouth's envelope (one letter per 1/30 s: closed, small, open, wide), measured on the sound when the audio is written or its words timed, and by the build when it is missing; its `line` may be `<node>.<option>`.

Characters drawn in SVG are read from their root (`data-expressions`, `data-default-expression`, `data-gestures`, `data-portrait`), checked against the convention (new codes `W_CHARACTER_CONVENTION` and `W_CHARACTER_CONTENT`; `W_DIALOGUE_LOOK` reads the same manifest), and carried in the course data sanitized with the class `t-character`, with their manifest. `@elabora/player/character` mounts one (`mountCharacter`: the state on its `<g data-part="character">`, the parts that match it shown, gestures replayed and removed after their duration, animations paused or stopped), and gives a line's mouth and word at a time (`voiceAt`) and a voice for a line without audio (`textVoice`).

The SVG sanitizer reads a `<style>` as text (a `<` in a comment no longer drops the rules after it), scopes selector lists at their own level only (lists inside `:is()`, `:where()`, `:not()` and `:has()` stay whole), renames ids in id selectors only (not a `#` in an attribute's value), and removes `@property` and layer statements, saying so. Removing a stage direction no longer removes the space a French line puts before `:`, `;`, `!` and `?`, in what learners read and in the captions. Charts whose items come with the voice follow their layer's timeline, and review comments on a line find it in a layer or a dialogue.
