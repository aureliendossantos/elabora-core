---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

ElevenLabs voices found by `elabora voice search` and `elabora_voice_search` say what ElevenLabs knows of them: how each was made (`quality`: a high-quality professional clone, a professional clone, a default voice, a designed voice, an instant clone, a licensed famous voice), how many people added a library voice (`users`), and what it is ready for (`models`: by model, the languages ElevenLabs checked the voice in, or `failed` when its training for that model failed). The command line shows whether each voice is checked with Eleven v4 (or `--model`) in the language searched. A search can ask for the best voices for a model: `quality: 'high'` (`--high-quality`) keeps the professional clones that passed ElevenLabs' quality check, and `readyFor: 'eleven_v4'` (`--ready`) those checked with that model in the language. `@elabora/core/narration/voice-fit` reads it for the app: `voiceFit`, `voiceModel`, `modelName`.
