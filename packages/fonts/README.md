# @elabora/fonts

Vetted free fonts for Elabora courses, shipped with Elabora so that they are there offline: in the desktop app, for the `elabora` command and the MCP server, for new projects. Each family is a few WOFF2 files with its licence next to them, in `files/<id>/`: each face in the **latin subset** (Western European languages: ca, da, de, en, es, fi, fr, ga, gl, id, is, it, ms, nb, nl, nn, no, pt, sq, sv, sw) and the **latin-ext subset** (az, bs, cs, cy, dsb, eo, et, haw, hr, hsb, hu, lt, lv, mi, mt, pl, ro, se, sk, sl, tk, tr, uz, with latin).

- **Agents and authors**: `elabora font list`, `elabora font add [dir] "<family>"` (MCP `elabora_list_fonts`, `elabora_add_font`) copy a font and its licence into `theme/fonts/<id>/`, declare its faces in `course.json` and give its stack to the tokens: the latin files, and the latin-ext files too when a language of the course needs them (`--subsets` to choose). Any other font goes the same way with its licence: `elabora font add --from <Fontsource package folder or .tgz>` or `--file <font.woff2> --license <file>` (docs/design.md, *Fonts*).
- **The app and other code**: `import { FONTS, FONT_CATALOGUE, findFont, selectFontFiles, languageSubsets } from '@elabora/fonts'` gives the catalogue as data (family, category, style, use, weights, styles, subsets, files with their unicode ranges, licence, where each came from, specimens and pangrams to preview them). No Node API: a renderer can import it. File paths are relative to this folder (`import.meta.resolve('@elabora/fonts/package.json')`).

## How they were chosen

- Classic and modern serifs, humanist, grotesque and geometric sans, a monospace and a few display faces, for the courses Elabora makes (corporate, technical, history, accessibility).
- Licences: SIL Open Font License 1.1 or Apache 2.0 only; ask the maintainers before adding a font under any other licence.
- Files: the Fontsource npm packages, which take the fonts from Google Fonts. The latin and latin-ext subsets, each file with its unicode range (from the package's `unicode.json`): a course declares one `@font-face` rule per file, and the browser downloads a file only for a page that uses one of its characters. Letters outside them (Greek, Cyrillic, Vietnamese…) fall back to the next fonts of the stack: take a font of that script with `--from` and `--subsets`. UnifrakturMaguntia has no latin-ext files. Variable fonts keep their weight axis only: one file per style and subset covers every weight. Static fonts ship the weights listed in `sources.json`.

## Maintaining

- `sources.json`, by hand: the subsets and the languages each one writes, the families, their package and version, styles (variable) or weights (static), the tokens `elabora font add` sets, their stack with fallbacks, one line of use, pairings, specimens.
- `pnpm run fonts` downloads each package at its version from the npm registry, checks it against the registry's integrity, copies its files and its licence into `files/` and writes `catalogue.json` and this README. `pnpm run fonts -- --check` lists newer versions; `pnpm run fonts -- --update` moves `sources.json` to them and refreshes. Then run `pnpm test` (the catalogue test checks files, hashes, ranges, licences, names, weights and the total size) and look at the fonts (`elabora font list`, a course with `elabora font add`).

## The list: 25 families, 3.42 MB

latin 1.76 MB, latin-ext 1.56 MB, licences 0.11 MB.

| Family | Category | Style | Weights | Italic | Subsets | Size | Licence | Files from |
|---|---|---|---|---|---|---|---|---|
| EB Garamond | serif | old-style | 400–800 (variable) | yes | latin, latin-ext | 292 KB | OFL-1.1 | [@fontsource-variable/eb-garamond 5.3.0](https://www.npmjs.com/package/@fontsource-variable/eb-garamond/v/5.3.0), v33 |
| Libre Baskerville | serif | transitional | 400–700 (variable) | yes | latin, latin-ext | 137 KB | OFL-1.1 | [@fontsource-variable/libre-baskerville 5.3.0](https://www.npmjs.com/package/@fontsource-variable/libre-baskerville/v/5.3.0), v24 |
| Lora | serif | contemporary | 400–700 (variable) | yes | latin, latin-ext | 121 KB | OFL-1.1 | [@fontsource-variable/lora 5.3.0](https://www.npmjs.com/package/@fontsource-variable/lora/v/5.3.0), v37 |
| Source Serif 4 | serif | transitional | 200–900 (variable) | yes | latin, latin-ext | 188 KB | OFL-1.1 | [@fontsource-variable/source-serif-4 5.3.0](https://www.npmjs.com/package/@fontsource-variable/source-serif-4/v/5.3.0), v14 |
| Merriweather | serif | screen | 300–900 (variable) | yes | latin, latin-ext | 348 KB | OFL-1.1 | [@fontsource-variable/merriweather 5.3.0](https://www.npmjs.com/package/@fontsource-variable/merriweather/v/5.3.0), v33 |
| Playfair Display | serif | didone | 400–900 (variable) | yes | latin, latin-ext | 123 KB | OFL-1.1 | [@fontsource-variable/playfair-display 5.3.0](https://www.npmjs.com/package/@fontsource-variable/playfair-display/v/5.3.0), v40 |
| Fraunces | serif | soft | 100–900 (variable) | yes | latin, latin-ext | 157 KB | OFL-1.1 | [@fontsource-variable/fraunces 5.3.0](https://www.npmjs.com/package/@fontsource-variable/fraunces/v/5.3.0), v38 |
| Inter | sans-serif | neo-grotesque | 100–900 (variable) | yes | latin, latin-ext | 275 KB | OFL-1.1 | [@fontsource-variable/inter 5.3.0](https://www.npmjs.com/package/@fontsource-variable/inter/v/5.3.0), v20 |
| Roboto | sans-serif | neo-grotesque | 100–900 (variable) | yes | latin, latin-ext | 152 KB | OFL-1.1 | [@fontsource-variable/roboto 5.3.0](https://www.npmjs.com/package/@fontsource-variable/roboto/v/5.3.0), v51 |
| Open Sans | sans-serif | humanist | 300–800 (variable) | yes | latin, latin-ext | 172 KB | OFL-1.1 | [@fontsource-variable/open-sans 5.3.0](https://www.npmjs.com/package/@fontsource-variable/open-sans/v/5.3.0), v44 |
| Source Sans 3 | sans-serif | humanist | 200–900 (variable) | yes | latin, latin-ext | 177 KB | OFL-1.1 | [@fontsource-variable/source-sans-3 5.3.0](https://www.npmjs.com/package/@fontsource-variable/source-sans-3/v/5.3.0), v19 |
| Lato | sans-serif | humanist | 400, 700, 900 | 400, 700 | latin, latin-ext | 149 KB | OFL-1.1 | [@fontsource/lato 5.3.0](https://www.npmjs.com/package/@fontsource/lato/v/5.3.0), v25 |
| Atkinson Hyperlegible Next | sans-serif | accessible | 200–800 (variable) | yes | latin, latin-ext | 113 KB | OFL-1.1 | [@fontsource-variable/atkinson-hyperlegible-next 5.3.0](https://www.npmjs.com/package/@fontsource-variable/atkinson-hyperlegible-next/v/5.3.0), v7 |
| IBM Plex Sans | sans-serif | grotesque | 100–700 (variable) | yes | latin, latin-ext | 161 KB | OFL-1.1 | [@fontsource-variable/ibm-plex-sans 5.3.0](https://www.npmjs.com/package/@fontsource-variable/ibm-plex-sans/v/5.3.0), v23 |
| Space Grotesk | sans-serif | grotesque | 300–700 (variable) | — | latin, latin-ext | 45 KB | OFL-1.1 | [@fontsource-variable/space-grotesk 5.3.0](https://www.npmjs.com/package/@fontsource-variable/space-grotesk/v/5.3.0), v22 |
| Montserrat | sans-serif | geometric | 100–900 (variable) | yes | latin, latin-ext | 222 KB | OFL-1.1 | [@fontsource-variable/montserrat 5.3.0](https://www.npmjs.com/package/@fontsource-variable/montserrat/v/5.3.0), v31 |
| Poppins | sans-serif | geometric | 400, 500, 600, 700 | 400 | latin, latin-ext | 73 KB | OFL-1.1 | [@fontsource/poppins 5.3.0](https://www.npmjs.com/package/@fontsource/poppins/v/5.3.0), v24 |
| Figtree | sans-serif | geometric | 300–900 (variable) | yes | latin, latin-ext | 65 KB | OFL-1.1 | [@fontsource-variable/figtree 5.3.0](https://www.npmjs.com/package/@fontsource-variable/figtree/v/5.3.0), v9 |
| Nunito | sans-serif | rounded | 200–900 (variable) | yes | latin, latin-ext | 156 KB | OFL-1.1 | [@fontsource-variable/nunito 5.3.0](https://www.npmjs.com/package/@fontsource-variable/nunito/v/5.3.0), v32 |
| JetBrains Mono | monospace | monospace | 100–800 (variable) | yes | latin, latin-ext | 117 KB | OFL-1.1 | [@fontsource-variable/jetbrains-mono 5.3.0](https://www.npmjs.com/package/@fontsource-variable/jetbrains-mono/v/5.3.0), v24 |
| Oswald | display | condensed | 200–700 (variable) | — | latin, latin-ext | 55 KB | OFL-1.1 | [@fontsource-variable/oswald 5.3.0](https://www.npmjs.com/package/@fontsource-variable/oswald/v/5.3.0), v57 |
| Bebas Neue | display | condensed capitals | 400 | — | latin, latin-ext | 26 KB | OFL-1.1 | [@fontsource/bebas-neue 5.3.0](https://www.npmjs.com/package/@fontsource/bebas-neue/v/5.3.0), v16 |
| Caveat | handwriting | handwriting | 400–700 (variable) | — | latin, latin-ext | 106 KB | OFL-1.1 | [@fontsource-variable/caveat 5.3.0](https://www.npmjs.com/package/@fontsource-variable/caveat/v/5.3.0), v23 |
| Cinzel | display | roman capitals | 400–900 (variable) | — | latin, latin-ext | 44 KB | OFL-1.1 | [@fontsource-variable/cinzel 5.3.0](https://www.npmjs.com/package/@fontsource-variable/cinzel/v/5.3.0), v26 |
| UnifrakturMaguntia | display | blackletter | 400 | — | latin | 30 KB | OFL-1.1 | [@fontsource/unifrakturmaguntia 5.3.0](https://www.npmjs.com/package/@fontsource/unifrakturmaguntia/v/5.3.0), v22 |

Sizes count the font files and the licence. The licence files keep the copyright line of each font.
