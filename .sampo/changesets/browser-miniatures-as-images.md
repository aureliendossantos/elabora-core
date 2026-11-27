---
npm/elabora: minor (Changed)
npm/@elabora/player: minor (Added)
npm/@elabora/node: minor (Added)
---

A browser's miniatures are images (D139): one painter, a frame of the canvas page kept for them, draws each scene in the view that has no image for its render's version yet, with `drawElementImage` where the browser has it and with snapdom elsewhere, and the images are kept by version, so that a retouch draws again only its screen's image. Only a WebP or PNG crosses from the canvas's origin, shown in an image. The painter is made as the miniatures are; it lives as long as they do in WebKit and, elsewhere, goes after 30 s at rest and is made again every eight pictures. The live frames stay the fallback (`createLiveThumbs`, or `createThumbs({ images: false })`), and a painter that fails twice in a row hands every scene to them and says so in the log: so does a picture drawn while the module's files could not be had, or an image the page's policy does not let it show (it needs `img-src blob:`). The canvas page answers `picture` in its painter's mode (`painter=1`), and the web app's canvas host serves snapdom 3.8.3 (MIT), vendored with its licence by `pnpm run vendor`.
