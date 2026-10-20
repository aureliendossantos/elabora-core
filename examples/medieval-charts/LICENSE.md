# Licence des contenus de l'exemple medieval-charts

*English summary: the original content of this example project is released under CC0 1.0 (public domain dedication), so anyone may reuse it without adding any mention of Elabora. The third-party items listed under "Ce qui n'est pas en CC0" keep their own licences; the two photographs of medieval maps are in the public domain.*

## Contenus originaux : CC0 1.0

Les contenus originaux de ce projet d'exemple sont placés dans le domaine public autant que la loi le permet, par la dédicace **Creative Commons Zero 1.0 Universal** (<https://creativecommons.org/publicdomain/zero/1.0/>). Vous pouvez les copier, les modifier, les publier et les utiliser, y compris à des fins commerciales, sans demander d'autorisation et **sans ajouter aucune mention d'Elabora**.

Cela couvre :

- les textes pédagogiques, les scénarios et le plan (`course.json`, `plan.json`, `screens/`, `translations/`, `elabora.lock.json`) ;
- les composants et leurs styles (`components/`), les objets libres écrits pour l'exemple (`objects/`, hors éléments listés plus bas) et les captures de leurs tests (`objects/*/__snapshots__/`) ;
- les générateurs (`generators/`) et les images SVG qu'ils produisent (`assets/images/*.svg`) ;
- les feuilles de style du thème (`theme/theme.css`).

## Ce qui n'est pas en CC0 : éléments de tiers, qui gardent leur licence

| Éléments | Licence | Où |
|---|---|---|
| Polices **EB Garamond** (© The EB Garamond Project Authors, romain et italique) et **UnifrakturMaguntia** (© 2009 Peter Wiegel, version de j. 'mach' wust), sous-ensemble latin, via Fontsource | SIL Open Font License 1.1 | `theme/fonts/*.woff2` ; avis de copyright et licence dans `theme/fonts/OFL-eb-garamond.txt` et `theme/fonts/OFL-unifraktur-maguntia.txt` (à conserver avec les polices) |
| **Deux photographies de cartes anciennes**, dans le domaine public : l'Atlas catalan d'Abraham Cresques (Majorque, 1375, Bibliothèque nationale de France), détail de l'Europe, et la mappemonde de Hereford (vers 1300), détail de l'Afrique d'après une reproduction imprimée ; toutes deux via Wikimedia Commons | Domaine public (œuvres anciennes reproduites fidèlement, PD-Art) | `assets/images/catalan-atlas-1375-europe.jpg` et `assets/images/hereford-detail-africa.jpg` ; sources dans `course.json` (`credits`) |
| **three.js** r186 (© 2010-2026 three.js authors), que l'objet 3D importe et que la construction du module embarque ; il n'est pas dans les sources de l'exemple | MIT | `packages/node/vendor/three-LICENSE.txt` du dépôt, et `elabora/vendor/three-LICENSE.txt` dans chaque module construit |

Les figures SVG (`assets/images/*.svg`) sont calculées par les générateurs à partir de coordonnées géographiques simplifiées : aucune ne reproduit une carte ou un document historique, et elles sont toutes en CC0. Les deux photographies JPEG du tableau ci-dessus sont les seules reproductions de documents historiques.

## Ce qui reste hors du périmètre

- `AGENTS.md` et `.mcp.json` sont le guide et la configuration que le cœur d'Elabora écrit dans chaque projet : ils suivent la licence du cœur, **Apache-2.0** (voir le `LICENSE` à la racine du dépôt).
- Au moment de la publication, le lecteur d'Elabora (Apache-2.0) et three.js r186 (MIT, voir plus haut) sont ajoutés au module ; ils ne font pas partie des sources de l'exemple.
