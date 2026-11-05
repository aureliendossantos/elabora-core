# Licence des contenus de l'exemple clockwork

*English summary: the original content of this example project is released under CC0 1.0 (public domain dedication), so anyone may reuse it without adding any mention of Elabora. The module has no photograph, no recorded sound, no narration and no third-party image: its gears are drawn by the code of its 3D object. The third-party items listed under "Ce qui n'est pas en CC0" keep their own licences.*

## Contenus originaux : CC0 1.0

Les contenus originaux de ce projet d'exemple sont placés dans le domaine public autant que la loi le permet, par la dédicace **Creative Commons Zero 1.0 Universal** (<https://creativecommons.org/publicdomain/zero/1.0/>). Vous pouvez les copier, les modifier, les publier et les utiliser, y compris à des fins commerciales, sans demander d'autorisation et **sans ajouter aucune mention d'Elabora**.

Cela couvre :

- les textes pédagogiques, la question, le plan et les traductions (`course.json`, `plan.json`, `screens/`, `translations/`, `elabora.lock.json`) ;
- la mise en page et ses styles (`components/clock-stage/`) et la feuille de style du thème (`theme/theme.css`) ;
- l'objet libre écrit pour l'exemple (`objects/clockwork/` : tracé des dentures, cinématique du train, rendu en aplats et contours, interface) et les captures de ses tests (`objects/*/__snapshots__/`).

Le module ne contient ni photographie, ni son, ni narration, ni vidéo, ni image de tiers : il n'y a aucun média à créditer, hors les polices ci-dessous. Il s'inspire des principes d'explication des articles de Bartosz Ciechanowski sur les engrenages et les montres mécaniques ; il n'en reprend ni texte, ni image, ni code.

## Ce qui n'est pas en CC0 : éléments de tiers, qui gardent leur licence

| Éléments | Licence | Où |
|---|---|---|
| Polices **Figtree** et **Source Serif 4** (voir leur `OFL.txt`), sous-ensemble latin, via Fontsource | SIL Open Font License 1.1 | `theme/fonts/figtree/` et `theme/fonts/source-serif-4/` ; avis de copyright et licence dans le `OFL.txt` de chaque dossier (à conserver avec les polices) |
| **three.js** r186 (© 2010-2026 three.js authors), que l'objet 3D importe et que la construction du module embarque ; il n'est pas dans les sources de l'exemple | MIT | `packages/node/vendor/three-LICENSE.txt` du dépôt, et `elabora/vendor/three-LICENSE.txt` dans chaque module construit |

## Ce qui reste hors du périmètre

- `AGENTS.md` est le guide que le cœur d'Elabora écrit dans chaque projet : il suit la licence du cœur, **Apache-2.0** (voir le `LICENSE` à la racine du dépôt).
- Au moment de la publication, le lecteur d'Elabora (Apache-2.0) et three.js r186 (MIT, voir plus haut) sont ajoutés au module ; ils ne font pas partie des sources de l'exemple.
