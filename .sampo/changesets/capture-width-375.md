---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
npm/@elabora/cli: patch (Fixed)
---

A capture at 375 px shows the page's whole width. With Elabora's Electron on a computer that draws classic scrollbars (macOS with a mouse plugged in), `elabora screenshot`, `look` and `fit` laid the page out 15 px narrower: a screenshot of the page was 360 px wide, and one of the window showed the scrollbar's strip on the right, so a full-bleed block seemed to stop short. Every Chromium Elabora starts (Electron's worker, Chrome, Edge) now gets `--hide-scrollbars`, which headless Chrome already had: the page is as wide as the window, as it is on a phone.
