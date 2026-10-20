---
npm/elabora: patch (Changed)
---

The optional local models (the word aligners, the transcriber and the Pocket TTS voices) are downloaded from Elabora's own copy on Hugging Face of the files that individuals published, instead of from those individuals' repositories, which they could rename or delete. The copies are byte for byte the same files, so models already installed stay current and nothing is downloaded again (D57).
