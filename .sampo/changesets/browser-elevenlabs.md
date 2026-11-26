---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/node: patch (Changed)
---

ElevenLabs in a browser's session (D136). The provider is the core's for every host (`createElevenLabs`), and asks ElevenLabs only by a list of named operations. In a browser, the author's key is typed in a page of its own (`browser/keys/`), which checks it, keeps it only when the author ticks it, sends only those operations and never gives the key back; the session reaches it by a port (`voiceKeyPort`), and `setVoiceKey` refuses a key there. The desktop's behaviour is unchanged.
