---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

Closing Google Chrome or Microsoft Edge no longer holds a command: once its pages are gone, Elabora waits a second, then ends the browser's process. Chrome 155 on macOS took ten seconds to exit, so each `elabora fit`, `elabora screenshot` and object test paid those seconds when Elabora's own browser was not installed: `fit` drops from 12 s to 3 s, `screenshot` from 11 s to 2.5 s. A look server that is replaced or stopped now exits within two seconds.
