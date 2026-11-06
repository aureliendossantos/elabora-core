---
npm/elabora: minor (Changed)
npm/@elabora/format: minor (Changed)
npm/@elabora/player: minor (Changed)
npm/@elabora/core: minor (Changed)
npm/@elabora/node: minor (Changed)
npm/@elabora/cli: minor (Changed)
---

The glossary's terms are linked when a screen is compiled (D58, revised: « Liens calculés »), in the package, the editor's canvas and the Aperçu, in every language, the first time each term or a variant is in a screen: nothing is written into the texts any more, so a text retyped, a mention added earlier, a new screen or an agent's text is linked as it now is, and a translation never goes stale for a link. A link written by hand (`[le routeur du siège](glossary:routeur)`) wins in its screen. « Retirer ce lien »: `elabora_player` `unlinkTerm: { term, screen }` (CLI `elabora player --unlink-term term:screen`) lists the screen in the entry's new `unlinked` (schemas 0.1.12), followed by a renamed screen; `relinkTerm` puts the link back. `linkTerms` on demand (`--link-terms`) is gone. `E_GLOSSARY_TERM_UNKNOWN` sees links by reference too. The canvas's layout reports the linked words it draws (`terms`). The examples lose the links the old operation wrote.
