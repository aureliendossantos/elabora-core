---
npm/elabora: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/core: patch (Added)
npm/@elabora/format: patch (Fixed)
---

`elabora fit` also measures a phone (375×812, unless sizes are given; `--phone <size>|none`): the contrast of the text down the page, and the player's bars that go onto two lines (new code W_PLAYER_BAR_WRAPS). `fit --language <code> [--allow-missing]` measures a translation, as the MCP tool did. `multipleOf` with decimals takes the values a slider gives (0.6 is a multiple of 0.05). `elabora test` runs fewer packages side by side on a loaded machine, and after runs that failed on a timeout says to try `--parallel 1`. `font list --category sans` (and `mono`, `script`) are understood. A translation missing a few texts says to translate them with `elabora_translate_text`.
