---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

Lines said as one ElevenLabs exchange (`voice generate --dialogue`) are cut in the real silence between two voices: silence is measured from the quietest of the gap, not from the voices' level, so a soft sigh or breath that opens a line (« [soupire] Deux minutes… ») stays whole in that line instead of being split with the line before. When only the line before ends on a stage direction (« … [rit] »), the cut is in the last silence, so that line keeps what follows its last word. The sample `diagnostic-reseau` has its two lines cut again from the same answer.
