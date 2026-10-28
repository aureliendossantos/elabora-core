# Organique (`organic`)

Un modèle de module Elabora pour les soft skills, le bien-être, l'accueil et les RH. Licence CC0 (voir `LICENSE.md`) ; police Nunito sous SIL OFL, embarquée avec sa licence (`theme/fonts/nunito/OFL.txt`) ; aucune ressource sur le réseau.

![Couverture](captures/cover-1600x900.png)

## Le concept

Des formes douces en dégradé dérivent lentement derrière chaque écran, sous un grain léger. Le décor porte un sens : il suit le module.

- **Chaque écran a sa composition.** Quand l'apprenant change d'écran, les formes migrent vers une nouvelle place, en 2,4 s, sans hâte. Une forme qui devrait traverser la fenêtre ne vole pas : elle s'efface là où elle était et apparaît là où elle va.
- **Chaque partie a sa teinte.** Les teintes vont du chaud au froid : pêche pour l'ouverture, or pour la première partie, sauge pour la deuxième, lagon pour la troisième, ciel pour la conclusion. L'apprenant sent le module avancer sans rien lire.
- **Chaque étape d'un écran déplace un peu la composition** : le module avance.
- **Moins d'animations** : quand l'apprenant le demande, rien ne dérive, et chaque écran montre sa composition d'emblée, comme une image fixe. Les calques CSS sont immobiles, eux aussi.
- **À l'ouverture** (une session reprise sur un écran avancé), le décor arrive tout de suite à sa place, sans voyage depuis un écran que l'apprenant n'a pas vu.

Le décor est fait de deux choses (`course.json` › `theme.backdrop`) :

| Pièce | Fichier | Rôle |
|---|---|---|
| Calques CSS | `theme/theme.css` (« Backdrop layers ») | `ground` : le fond crème ; `night` : le fond nuit ; `glow-warm` et `glow-cool` : deux grands halos qui se passent le relais d'une partie à l'autre ; `grain` : le grain, au-dessus des formes. |
| Objet de décoration | `objects/drift/` | Les formes. C'est un champ de lobes arrondis calculé sur une petite toile que le navigateur agrandit : l'agrandissement fait le flou. Il suit `host.onContext` (écran, partie, étape, variante). Il ne sert ni WebGL ni le réseau. |

La teinte de la partie colore aussi quelques marques de l'interface : les pastilles des objectifs, les formes au-dessus des cartes, le guillemet, le sur-titre et la forme sous le titre des ouvertures. On la lit dans la variable CSS `--org-part`.

### Les écrans

| # | Écran | Blocs du cœur | Variante |
|---|---|---|---|
| 1 | `cover`, couverture (vignette) | mise en page `opening` + `text` (style `meta`) | — |
| 2 | `objectives`, objectifs | `text` (style `objectives`) + `speech` (Personnage) | — |
| 3 | `part-one`, intercalaire | `opening` + `text` (`meta`) | — |
| 4 | `key-message`, message clé | `statement` | `night` |
| 5 | `text-and-picture`, texte et illustration | `image` `beside` (SVG généré) | — |
| 6 | `three-cards`, trois cartes | `columns` (style `cards`) | `pastel` |
| 7 | `key-figures`, chiffres clés | `key-figures` | — |
| 8 | `practice`, interaction | `quiz` (retour compact) | `pastel` |
| 9 | `four-steps`, étapes | `process` | `pastel` |
| 10 | `quote`, citation | `statement` `quote` | `mono` |
| 11 | `comparison`, comparaison | `columns` (style `compare`) | `pastel` |
| 12 | `chart`, graphique | `donut` | — |
| 13 | `recap`, récapitulatif | `accordion` `cards` (cartes à retourner) | — |
| 14 | `the-end`, fin | `opening` + `text` (`meta`) | — |

Tous les textes sont des blocs : l'auteur les retouche dans l'inspecteur. Le français est dans `translations/fr.xlf`, écrit par la traduction d'Elabora (`elabora translate status . --to fr`).

## Les variantes

Elles se choisissent par écran, avec `"backdrop": "<variante>"` dans le fichier de l'écran (« Décor » dans l'inspecteur).

| Variante | Quand | Ce qui change |
|---|---|---|
| *(aucune)* | La plupart des écrans | Formes vives et douces sur fond crème, teinte de la partie. |
| `pastel` | Les écrans denses : activité, cartes, étapes, comparaison | Formes plus pâles et plus transparentes ; halos à moitié. |
| `night` | Un moment fort : message clé, ouverture d'une partie | Fond nuit profonde (bleu nuit, pas violet), formes lumineuses, texte clair. Les barres du lecteur passent en clair. |
| `mono` | Un écran sobre : citation, sujet sensible | Teintes de l'encre (`color.primary`) seulement, pas de halo. |
| `none` | Un écran sans décor | L'objet s'arrête. |

## Adapter la charte à une marque

Tout passe par les jetons de `course.json` › `theme` : la feuille de style ne contient aucune couleur en dur.

1. **Les couleurs de la marque** (`theme.tokens`) :
   - `color.primary` et `color.text` : l'encre. C'est aussi la teinte de la variante `mono` et le bouton Suivant (`player.accent`).
   - `color.accent` : la couleur forte des graphiques et du Personnage.
   - `color.surface` : le fond.
2. **Le voyage des teintes** (`theme.custom`) :
   - `color.journey-warm` : la première partie ;
   - `color.journey-middle` : le milieu ;
   - `color.journey-cool` : la dernière partie.

   Les parties intermédiaires prennent les teintes entre ces trois couleurs (mélange OKLCH). Pour une marque monochrome, donnez trois tons proches de sa couleur. Pour un voyage inverse (du froid au chaud), échangez `warm` et `cool`. Gardez des tons clairs : le texte foncé doit rester lisible dessus. `elabora fit` le mesure.
3. **La nuit** : `color.night`, `color.night-card`, `color.night-text`, `color.night-muted`.
4. **Les illustrations et le grain** suivent les jetons. Après un changement de couleur, lancez `elabora assets .` pour redessiner `images/organic-shapes.svg` et `images/grain.svg`.
5. **La police** : `elabora font add . "<famille>" --for body,heading`. Gardez une sans-serif ronde ou humaniste (Nunito, Lato, Figtree, Source Sans 3).
6. **Les sections.** La teinte suit les ids de section `opening`, `part-1`, `part-2`, `part-3` et `closing`, dans cet ordre. Si vous ajoutez, retirez ou renommez des sections, mettez à jour deux endroits :
   - la prop `journey` de l'objet, dans `course.json` › `theme.backdrop.object.props.journey`, qui liste les ids dans l'ordre ;
   - les quelques sélecteurs `[data-section="…"]` en tête de `theme/theme.css`.

   Une section absente de `journey` garde la teinte de la précédente.
7. **Le mouvement** se règle dans `theme.backdrop.object.props`, sans code :
   - `count` : de 3 à 7 formes ;
   - `drift` : l'amplitude de la dérive, de 0 (immobile) à 1 ;
   - `transition` : la durée de la migration, en secondes ;
   - `seed` : tire d'autres compositions pour chaque écran.

   Exemple : `"props": { "journey": ["accueil", "partie-1", "partie-2", "bilan"], "seed": 7, "count": 4 }`.

### Pour un module entièrement en nuit

Mettez `"backdrop": "night"` sur chaque écran. Pour en faire le thème de base, il faut aussi inverser les jetons : `color.surface` ← la nuit, `color.text` ← le clair. Gardez alors les règles « Night variant » de `theme.css` pour la variante.

## Vérifié avec

| Vérification | Résultat |
|---|---|
| `elabora validate .` | 0 erreur. 2 avertissements propres à un modèle : `W_PLAN_DRAFT` (aucune version du plan) et `W_SPACING_MISSING` (pas de rappels espacés). |
| `elabora fit .` | 14/14 écrans tiennent à 1600×900 et à 1280×720, sans contraste insuffisant mesuré sur le décor. En français (`elabora tools call elabora_check_fit . --args '{"language":"fr"}'`), 14/14 aussi, sans diagnostic. |
| `elabora test .` | 8/8 passages dans l'émulateur LMS, 0 violation axe sur 28 états d'écran, aucun débordement à 375 px. |
| `elabora object test . drift` | Les cinq portes passent : smoke, comportement (8 tests), budgets, visuel, accessibilité. Démarrage en 56 ms environ. |
| `elabora translate status . --to fr` | 94/94 unités traduites. Le plan traduit attend l'approbation d'une personne. |

Les captures de `captures/` (chaque écran à 1600×900 et à 375×812) sont faites avec `elabora screenshot` et non avec `elabora look`. `look` ne transmet pas à l'objet de décor le contexte de l'écran demandé (voir `frictions.md`, n° 12). Les captures de téléphone sont des pages entières : sous le premier écran, le décor fixe ne s'y prolonge pas, alors qu'il reste derrière le texte quand on fait défiler sur un vrai téléphone.
