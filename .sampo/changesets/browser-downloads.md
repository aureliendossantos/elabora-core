---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/node: patch (Changed)
---

Elabora settings' downloads in a browser (D138): `BrowserDownloads` lists, downloads, stops and removes the local voices' models and the word aligners from a window, with no session, in the folders a session uses; another tab's downloads and uses are read from the browser's locks. `DownloadView` is now `@elabora/core/downloads/types`, which `@elabora/node` re-exports.
