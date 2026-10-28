---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

Pages opened in Elabora's own browser (the app's Electron, used by captures, fit and free-object tests when the app is installed) behave as in Chrome: they have the keyboard focus, so Tab moves it and `:focus-visible` and focus events come, and a page's download is accepted instead of waiting on a save dialog the hidden window never showed. A page asked for as a phone (`hasTouch`, `isMobile`) is refused with a clear error instead of being given a mouse and a fine pointer: phones are emulated by an external Chromium.
