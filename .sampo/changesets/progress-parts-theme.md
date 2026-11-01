---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Fixed)
---

A theme that styles the classic progress bar's track (`.t-progress`) no longer draws a second bar under the progress in parts. The parts' toolbar is now `.t-parts[role=toolbar]` instead of `.t-progress.t-progress--parts`, so a theme's rule for the classic bar reaches only that bar, whether or not the theme was written before the parts existed.
