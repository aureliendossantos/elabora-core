# Licence des contenus de l'exemple phishing-by-numbers

*English summary: the original content of this example project is released under CC0 1.0 (public domain dedication), so anyone may reuse it without adding any mention of Elabora. The company, its people and every figure are fictional. The third-party items listed under "Ce qui n'est pas en CC0" keep their own licences: the two fonts (SIL OFL 1.1) and the narration audio, generated with ElevenLabs.*

## Contenus originaux : CC0 1.0

Les contenus originaux de ce projet d'exemple sont placés dans le domaine public autant que la loi le permet, par la dédicace **Creative Commons Zero 1.0 Universal** (<https://creativecommons.org/publicdomain/zero/1.0/>). Vous pouvez les copier, les modifier, les publier et les utiliser, y compris à des fins commerciales, sans demander d'autorisation et **sans ajouter aucune mention d'Elabora**.

Cela couvre :

- les textes pédagogiques, les graphiques et leurs données, les scénarios et le plan (`course.json`, `plan.json`, `screens/`, `elabora.lock.json`) ;
- les textes des répliques (le champ `text` des fichiers de `assets/narration/`, et `screens/`) ;
- la feuille de style du thème (`theme/theme.css`).

L'entreprise Quillon Freight, ses équipes, ses règles et tous les chiffres du module sont **fictifs** : ils ne décrivent aucune entreprise réelle et ne sont pas des statistiques sur le monde.

## Ce qui n'est pas en CC0 : éléments de tiers, qui gardent leur licence

| Éléments | Licence | Où |
|---|---|---|
| Polices **Fraunces** (© The Fraunces Project Authors) et **Figtree** (© The Figtree Project Authors), sous-ensemble latin, via Fontsource | SIL Open Font License 1.1 | `theme/fonts/fraunces/`, `theme/fonts/figtree/` ; avis de copyright et licence dans le `OFL.txt` de chaque dossier (à conserver avec les polices) |
| **Voix de synthèse de la narration** : les fichiers audio `assets/narration/en/**/*.m4a`, produits avec **ElevenLabs** (modèle Eleven v4, voix « Kristen » de la bibliothèque de voix d'ElevenLabs) sur un abonnement qui permet l'usage commercial. Ils ne sont **pas** placés en CC0. | Conditions d'utilisation d'ElevenLabs pour l'abonnement qui les a produits | Le champ `credit` de chaque fichier `.json` voisin du `.m4a` donne le crédit à conserver (`generated: true` les marque comme générés) ; le module construit l'affiche dans le menu « Plan du module » et dans la transcription. Pour réutiliser le module sans ces fichiers, générez de nouveau les répliques avec votre propre voix (`elabora voice generate`). |

## Ce qui reste hors du périmètre

- `AGENTS.md` est le guide que le cœur d'Elabora écrit dans chaque projet : il suit la licence du cœur, **Apache-2.0** (voir le `LICENSE` à la racine du dépôt).
- Au moment de la publication, le lecteur d'Elabora (Apache-2.0) et ce qu'il embarque pour les graphiques sont ajoutés au module ; ils ne font pas partie des sources de l'exemple.
