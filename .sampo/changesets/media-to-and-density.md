---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
npm/@elabora/core: patch (Fixed)
---

`elabora media import --to images` imports into `assets/images`: `--to` names a folder of `assets/`, with or without the `assets/` prefix. It used to refuse any folder without the prefix. `W_TEXT_DENSITY` no longer counts as reading the words a component binds only to attributes that screen readers say, such as an image's `alt` or an `aria-label`. A caption still counts.
