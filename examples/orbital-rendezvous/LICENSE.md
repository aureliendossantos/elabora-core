# Licence des contenus de l'exemple orbital-rendezvous

*English summary: the original content of this example project is released under CC0 1.0 (public domain dedication), so anyone may reuse it without adding any mention of Elabora. The third-party items listed under "Ce qui n'est pas en CC0" keep their own licences.*

## Contenus originaux : CC0 1.0

Les contenus originaux de ce projet d'exemple sont placés dans le domaine public autant que la loi le permet, par la dédicace **Creative Commons Zero 1.0 Universal** (<https://creativecommons.org/publicdomain/zero/1.0/>). Vous pouvez les copier, les modifier, les publier et les utiliser, y compris à des fins commerciales, sans demander d'autorisation et **sans ajouter aucune mention d'Elabora**.

Cela couvre :

- les textes pédagogiques, les scénarios et le plan (`course.json`, `plan.json`, `screens/`, `translations/`, `elabora.lock.json`) ;
- les composants et leurs styles (`components/`), les objets libres écrits pour l'exemple (`objects/`, hors éléments listés plus bas) et les captures de leurs tests (`objects/*/__snapshots__/`) ;
- les générateurs (`generators/`) et les images SVG qu'ils produisent (`assets/images/`) ;
- les feuilles de style du thème (`theme/theme.css`).

## Ce qui n'est pas en CC0 : éléments de tiers, qui gardent leur licence

| Éléments | Licence | Où |
|---|---|---|
| Polices **Inter** (© The Inter Project Authors) et **Space Grotesk** (© The Space Grotesk Project Authors), sous-ensemble latin, via Fontsource | SIL Open Font License 1.1 | `theme/fonts/*.woff2` ; avis de copyright et licence dans `theme/fonts/OFL.txt` (à conserver avec les polices) |
| **Bruit simplex 3D en GLSL** de webgl-noise (© 2011 Ashima Arts ; © 2011-2016 Stefan Gustavson ; Ian McEwan), utilisé pour cuire la Terre procédurale : les fonctions `mod289`, `permute`, `taylorInvSqrt` et `snoise` | MIT | `objects/phasing-lab/noise.js` : l'avis et le texte de la licence sont dans son en-tête, qui doit rester avec le code (la construction le conserve à la fin de `object.js`). Le reste de l'objet est en CC0. |
| **three.js** r186 (© 2010-2026 three.js authors), que l'objet 3D importe et que la construction du module embarque ; il n'est pas dans les sources de l'exemple | MIT | `packages/node/vendor/three-LICENSE.txt` du dépôt, et `elabora/vendor/three-LICENSE.txt` dans chaque module construit |

## Ce qui reste hors du périmètre

- `AGENTS.md` et `.mcp.json` sont le guide et la configuration que le cœur d'Elabora écrit dans chaque projet : ils suivent la licence du cœur, **Apache-2.0** (voir le `LICENSE` à la racine du dépôt).
- Au moment de la publication, le lecteur d'Elabora (Apache-2.0) et three.js r186 (MIT, voir plus haut) sont ajoutés au module ; ils ne font pas partie des sources de l'exemple.
