---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

The contrast `elabora fit` measures (`W_TEXT_CONTRAST_MEASURED`) no longer depends on the screen's pixel density. With Elabora's browser on a high-density screen (a Retina Mac, Windows at 125 or 150 %), the first window of each page was read at full resolution, because the pixel ratio was learnt from that capture, and the others at half scale: text over fine detail (rhumb lines on a chart, hatching) could then measure up to about 20 % apart from the same screen on a standard screen. The ratio is now learnt once per page from a capture of 100 pixels, and every window is read at half scale.
