---
name: elabora-sounds
description: Add sounds to a course (a phone that rings, a door, an ambience, music), place them in narrations, dialogues and events, caption them when they carry meaning, and keep their licences shippable. Use for sound effects, ambiences, music and interface sounds.
---

# Sounds in Elabora

Read course `AGENTS.md` first. The format is in SPEC §4.12; why it is so in `elabora_docs { page: "D67" }`.

## Find, add, make
- Search Elabora's library first: `elabora_sound_search { words }` (CC0, offline: phones, doors and footsteps, office, notifications, impacts, transitions, nature, crowds and places, stingers, ambiences that loop). Then Freesound and Commons through Openverse (`source: "openverse"`, CC0, public domain and CC BY only; a CC BY sound is credited by itself). Then, only if nothing fits, `elabora_sound_generate` (ElevenLabs, the author's quota: under 1 % it runs, from 1 % ask the author first and pass `approvedPercent`; say shares of the quota, never credits).
- Add with `elabora_sound_add { from, trim?, fade?, caption? }`: the file goes to `assets/sounds/<id>` with its sidecar (source, author, licence). Never write a sound's file or sidecar by hand. A file from the author needs its licence (`own` when they made or bought it). NC, ND or unknown licences cannot ship (`E_SOUND_LICENSE`).

## Place
- **Between lines**, a sound line: `{ "id": "ring", "sound": "telephone-fixe", "caption": "Le téléphone sonne." }` in a narration's `lines` (with `step`, `pauseBefore`) or a dialogue node's lines. It lasts as long as its sound; trim the sound to what the scene needs.
- **On an event or a word**, an action: `{ "type": "play-sound", "sound": "…", "volume"?, "caption"? }` in an event (`screen.enter`, a click, a cue `timeline.reached` on a word), a dialogue line's cue or a dialogue option's `do`. `stop-sound` stops it; every sound of the story stops at the end of its screen.
- **Set it by ear** (SPEC §4.12): `volume` up to 2 for a sound recorded too quietly (the player stops before it would clip); `start`, `end` (seconds) to play a piece of a longer file without cutting it again; `fade` in and `fadeOut` (seconds) so it neither clicks in nor stops dead; `duck` (dB: 6 a little, 12 clearly, 20 much) when it must be heard over a voice speaking at that moment, a phone over the line it interrupts. Leave them out when the sound plays as it is: most do.
- **An ambience of one screen**: `play-sound` with `"loop": true` on `screen.enter` (0.3 by default). **Music or an ambience over several screens**: `course.json` `sounds.background` `[{ "sound", "from", "to"?, "volume"?, "start"?, "end"? }]` (one track at a time per screen; `start`, `end`: the part of a long recording that loops; an ambience's `fadeOut` is how it fades when its screen ends). Both are lowered by 20 dB under the voice by the player; enable « Affichage » (`elabora_player`) so learners can switch them off (`W_SOUND_MUSIC_SWITCH_HIDDEN`).
- Interface sounds (choices, feedback, going back) are on by themselves when the module has sound; change them only on the author's request (`course.json` `sounds.interface`: `when`, `volume`, `replace`).

## Judgement
- A sound when it says something of the scene: the phone that opens the call, the alarm of a drill, the door before a visitor. One or two a screen at most, never under an explanation (sounds unrelated to the content hurt learning). No decorative bed by default; add one when the author asks.
- **Captions are advised, never required.** Write one when the sound carries meaning no text gives (« Le téléphone sonne. », short, in the course's language). Leave it out when the prose already says it (frequent in dialogues: « Le téléphone sonne. Marc décroche. ») or when the sound is decorative and serves the immersion. No finding will ask you for one.
- A CC BY sound must keep « IA et crédits » enabled (`W_SOUND_CREDITS_HIDDEN`); CC0 needs nothing.
