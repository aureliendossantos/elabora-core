# Licence des contenus de l'exemple diagnostic-reseau

*English summary: the original content of this example project is released under CC0 1.0 (public domain dedication), so anyone may reuse it without adding any mention of Elabora. The third-party items listed under "Ce qui n'est pas en CC0" keep their own licences.*

## Contenus originaux : CC0 1.0

Les contenus originaux de ce projet d'exemple sont placés dans le domaine public autant que la loi le permet, par la dédicace **Creative Commons Zero 1.0 Universal** (<https://creativecommons.org/publicdomain/zero/1.0/>). Vous pouvez les copier, les modifier, les publier et les utiliser, y compris à des fins commerciales, sans demander d'autorisation et **sans ajouter aucune mention d'Elabora**.

Cela couvre :

- les textes pédagogiques, les scénarios et le plan (`course.json`, `plan.json`, `screens/`, `translations/`, `elabora.lock.json`) ;
- les composants et leurs styles (`components/`), les objets libres écrits pour l'exemple (`objects/`, hors éléments listés plus bas) et les captures de leurs tests (`objects/*/__snapshots__/`) ;
- les images SVG (`assets/images/`) et les textes des répliques (le champ `text` des fichiers de `assets/narration/`, et `screens/`) ;
- les styles des composants et de la page.

## Ce qui n'est pas en CC0 : éléments de tiers, qui gardent leur licence

| Éléments | Licence | Où |
|---|---|---|
| **Voix de synthèse de la narration** : les fichiers audio `assets/narration/fr/**/*.m4a` sont produits par **Pocket TTS** de Kyutai (Manu Orsini, Simon Rouard, Gabriel De Marmiesse, Václav Volhejn, Neil Zeghidour, Alexandre Défossez), modèle `french_24l`, dans la conversion ONNX de KevinAHM. Ils ne sont **pas** placés en CC0 : l'attribution demandée par la licence du modèle accompagne chaque réplique. | Poids du modèle : **CC-BY 4.0** (<https://creativecommons.org/licenses/by/4.0/>) ; code de Pocket TTS : MIT | Le champ `credit` de chaque fichier `.json` voisin du `.m4a` donne le texte exact à conserver ; le module construit l'affiche dans le menu « Plan du module » et dans la transcription. |
| Voix **« Henri »** (Marc), faite d'un enregistrement de l'équipe Kyutai | CC0 (<https://huggingface.co/kyutai/tts-voices>) ; l'audio généré reste couvert par le crédit du modèle ci-dessus | `assets/narration/fr/accueil/marc-appel.*` |
| Voix **« Claire »** (le guide), faite d'un enregistrement du corpus CML-TTS (lecteur LibriVox) | **CC-BY 4.0** (<https://openslr.org/146>) : l'attribution doit être conservée | `assets/narration/fr/accueil/guide-mission.*`, `assets/narration/fr/chemin/*` |
| **three.js** r186 (© 2010-2026 three.js authors), que l'objet 3D importe et que la construction du module embarque ; il n'est pas dans les sources de l'exemple | MIT | `packages/node/vendor/three-LICENSE.txt` du dépôt, et `elabora/vendor/three-LICENSE.txt` dans chaque module construit |

Les textes des répliques (champ `text`, `screens/`) sont originaux et en CC0 ; seul le son généré, et les métadonnées qui portent le crédit, restent soumis à l'attribution.

Cet exemple n'embarque aucune police (pile de polices du système).

## Ce qui reste hors du périmètre

- `AGENTS.md` et `.mcp.json` sont le guide et la configuration que le cœur d'Elabora écrit dans chaque projet : ils suivent la licence du cœur, **Apache-2.0** (voir le `LICENSE` à la racine du dépôt).
- Au moment de la publication, le lecteur d'Elabora (Apache-2.0) et three.js r186 (MIT, voir plus haut) sont ajoutés au module ; ils ne font pas partie des sources de l'exemple.
