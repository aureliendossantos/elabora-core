---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

Sounds of the story, ambiences and music (D67). A sound is `assets/sounds/<id>` (FLAC, or the lossy file it came as) with its sidecar (schema `sound`: source, author, licence, credit, changes, a suggested caption, whether it was generated); packages ship it as M4A at every quality. Sound lines `{ id, sound, caption? }` sit among a narration's lines (laid into its track) and in dialogues; `play-sound` (volume, loop, fade, caption) and `stop-sound` are actions of events, cues and dialogues. `course.json` `sounds.background` plays music or an ambience over a range of screens, looped with a crossfade; music and ambiences go 20 dB down while a voice plays and learners switch them off in « Affichage » (« Musique et ambiances »). Captions are advised, never imposed. Licences: CC0, public domain, CC BY, CC BY-SA, own and generated ship; « IA et crédits » gives the credits CC BY asks for, and `CREDITS.txt` lists every sound in the package. Elabora's library « Sons courants » (38 CC0 or public-domain sounds, 8.8 MB) and the end-of-dialogue jingle. Agents: `elabora sound search|add|list|generate` (the library, Openverse without an account, ElevenLabs within the quota's threshold), MCP `elabora_sound_search`, `elabora_sound_list`, `elabora_sound_add`, `elabora_sound_generate`, and the skill `elabora-sounds`. phishing-by-numbers rings. The schemas move to 0.1.3 (D64). New codes: E_SOUND_LICENSE, E_SOUND_BACKGROUND, W_SOUND_CREDITS_HIDDEN, W_SOUND_MUSIC_SWITCH_HIDDEN.
