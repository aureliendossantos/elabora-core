---
npm/elabora: minor (Added)
npm/@elabora/engine: minor (Added)
---

A browser without its own AAC encoder (Firefox under macOS, Chromium under Linux) makes its masters with Mediabunny's encoder in WebAssembly, which a host serves beside the engine (D135): `aacEncoderModule`, `AAC_ENCODER` and `aacEncoderLicenceFiles` give the module, its pins and the licence files (LGPL 2.1, with FFmpeg's source offered from the same place).
