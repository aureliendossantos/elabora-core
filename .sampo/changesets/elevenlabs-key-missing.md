---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

A request to ElevenLabs without a key (searching voices, reading the account, an estimate) says that the key is missing (`E_VOICE_KEY_MISSING`), before anything is sent, instead of saying that ElevenLabs could not be reached (`E_VOICE_OFFLINE`).
