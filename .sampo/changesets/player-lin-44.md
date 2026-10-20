---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/cli: minor (Added)
---

The learner's player follows the editor decided on Lin 44 (D58 revised, D59). Each bar has a spacer item (« Espace flexible », always on) that splits its line where the author moves it. « IA et crédits » shows « IA » when the module has generated voices or media. Resources may be images, previewed like PDFs, or https:// links opened in a new tab (E_RESOURCE_URL for other addresses), and @elabora/node/sources/pdf-title reads a PDF's own title to name a dropped file. The glossary's terms are linked to the screens, the first time in each, when its linkTerms option is turned on, when a term is added and on demand (elabora player --link-terms, MCP elabora_player linkTerms); a removed link stays removed, and translate: false keeps a term in every language. A logo can sit on a plate, and W_PLAYER_LOGO_CONTRAST says when an SVG logo does not read on its bar. New items: « Affichage » (text size in three steps without moving the bars, larger captions, keyboard shortcuts) and « Langue », which switches in place between the languages of a package built with elabora build --languages all (MCP elabora_build languages, engine build languages), keeping the learner's screen and progress; the language chosen is kept in suspend data. elabora_player also reports the course's navigation mode and lock.
