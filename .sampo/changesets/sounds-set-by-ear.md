---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/player: minor (Added)
---

A sound of the story is set by ear (schemas 0.1.7): `play-sound` takes a `volume` up to 2 for a sound recorded too quietly (raised no further than brings its loudest sample to −1 dBFS, so it never clips), a part of its file (`start`, `end`, in seconds), a fade out (`fadeOut`) and `duck`, which lowers the music and the ambiences (never a voice) by that many dB while it plays (down in 0.1 s, back in 0.5 s). Ambiences loop their part and fade out as they ask when their screen ends; background tracks take a part and a volume up to 2 too. A part outside its file is `E_SOUND_PART`; a duck asked of an ambience is `W_SOUND_DUCK_LOOP`.
