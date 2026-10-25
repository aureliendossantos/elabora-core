---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

Starter blocks for scroll courses, content and structure (D63): `statement` (« Énoncé »: statement, ruled, quote or over an image; with an author, a quotation with its caption and portrait), `divider` (« Séparateur »: line, the theme's ornament, a counted number, space), `gallery` (« Galerie »: grid, mosaic, compare with a before and after slider; carousel shows as a grid for now) and `columns` (« Colonnes »: two or three, stacked on narrow screens). `image` takes a presentation (centered as before, wide, band, beside, over), a focal point (`focus`, kept by every crop) and text beside or over it; `text` takes a margin note (`aside`). A block's `width` may be `bleed`, and a template asks for it with `data-t-bleed`: edge to edge of the window, or of the slide, without a sideways scrollbar. The first built-in screen layout, `opening` (« Ouverture »: title, band, split or cover), opens a lesson with its section and « Leçon 2 sur 6 », its lead, its reading time computed by the build and a question before the lesson. Text over pictures sits on the theme's scrim (`--t-scrim`, `--t-on-scrim`) and is measured by `elabora fit`. New checks: `W_QUOTE_REPEATS`, `W_COLUMNS_HIDDEN`, `E_GALLERY_COMPARE`. Exports and the client view carry them as text. Captures wait for images to be decoded.
