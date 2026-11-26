---
npm/elabora: minor (Changed)
npm/@elabora/player: minor (Changed)
---

A browser's editor holds at most eight live miniatures at once instead of sixteen (`THUMB_LIMIT`), which costs about 280 MB in Chromium and WebKit and 130 MB in Firefox instead of 440 to 560 MB. `createThumbs` watches the view itself: a miniature that leaves the view keeps its frame while a place is free, so it is drawn at once when it comes back, and a refresh asked for out of the view waits for it to come back. A block's preview (« Ajouter un bloc ») shows the part of the screen around the block, or the block alone for the list's small box, as the desktop's capture frames it, and its `ThumbShown.overflow` says whether the slide runs past the window with the block in it. A block's or the Charte's preview opened while every place is held in the view takes the place of the last miniature in reading order, which is drawn again once the preview goes. A view of more miniatures than places draws them in reading order (a line, then the left first), and a place freed goes to the next.
