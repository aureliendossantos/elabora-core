# Flux (`flow`) — modèle de module Elabora

Licence : CC0 pour le module (contenu, thème, composants, objet de décor, générateur). Les polices sont sous SIL OFL 1.1 et embarquées avec leur licence (`theme/fonts/*/OFL.txt`). Le module n'utilise aucune ressource réseau.

## Le concept

Le fond « PlayStation ». Un champ sombre, presque noir, éclairé par deux lueurs (cyan en bas à gauche, magenta en haut à droite). Une bande de brume lumineuse traverse la fenêtre et glisse lentement de côté. Bas dans la fenêtre, deux faisceaux de fines lignes ondulent, et des particules flottent devant.

**Le mouvement porte le sens de la navigation.** À chaque nouvel écran, les particules s'étirent en traits et accélèrent vers la gauche, comme un saut en avant, puis retombent au calme en un peu plus d'une seconde. Quand l'apprenant revient en arrière, le saut part dans l'autre sens. Le premier écran d'une partie fait un saut un peu plus long, et la palette glisse du premier néon vers le second : cyan au début du module, magenta vers la fin. Une étape révélée par Continuer ne donne qu'une petite impulsion. Rien ne grandit jusqu'à la fenêtre et rien ne décale la mise en page : seuls `transform` et `opacity` sont animés côté CSS, et l'objet dessine dans son propre canevas. Avec moins d'animations, le CSS s'arrête et l'objet passe en images fixes : des points, aucun saut.

**La typographie.** Une grotesque géométrique, Figtree (titres en 760 à 820, approche serrée), et une police à chasse fixe, JetBrains Mono, pour tout ce qui compte ou repère : les surtitres, les numéros d'objectifs, de colonnes et d'étapes, les chiffres clés, les axes des graphiques, la ligne « Partie 2 sur 4 ».

**Publics.** Tech, cybersécurité, lancements de produit, commerce. Le modèle sert aussi pour une présentation classique.

## Ce qui fait la charte

| Pièce | Fichier | Rôle |
|---|---|---|
| Jetons | `course.json` › `theme.tokens`, `theme.custom` | les couleurs de la charte (néons, champ, panneaux, encres de la variante claire), le rayon, les barres du lecteur |
| Polices | `theme/fonts/figtree`, `theme/fonts/jetbrains-mono` | ajoutées avec `elabora font add`, licence OFL à côté |
| Feuille de style | `theme/theme.css` | les calques du décor, la variante claire, les styles nommés, les graphiques en chasse fixe |
| Styles nommés | `theme.styles` | texte : `lead`, `kicker`, `meta`, `list`, `recap` ; colonnes : `cards`, `versus` |
| Mises en page | `components/flow-cover`, `components/flow-section` | la couverture (et la fin) avec ses trois chevrons, l'intercalaire de partie (« Partie 2 sur 4 » écrit par le lecteur) |
| Décor CSS | `theme.backdrop.layers` : `field`, `haze`, `grain` | les lueurs du champ, la brume lumineuse (un masque peint avec les jetons néon, en boucle sans couture), un grain fixe |
| Objet de décor | `objects/flow-field/` | les lignes qui ondulent et les particules qui bondissent ; il suit `host.onContext` |
| Générateur | `generators/flow.mjs` | les masques de la brume et du grain, l'illustration abstraite `signal.svg` (sans texte) |

Les écrans n'utilisent que des blocs du cœur : `text` (styles nommés), `statement`, `image` (présentation `beside`, SVG en ligne), `columns`, `heading`, `key-figures`, `process`, `quiz`, `trend`. Tout le texte se retouche depuis l'inspecteur.

## Les écrans

| # | Écran | Type du cahier | Blocs | Décor |
|---|---|---|---|---|
| 1 | `cover` | couverture, vignette de la bibliothèque | mise en page `flow-cover` ; `text` kicker, lead, meta | plein |
| 2 | `objectives` | objectifs | `text` lead, `text` list | calm |
| 3 | `part-one` | intercalaire de partie | mise en page `flow-section` ; `text` lead | plein |
| 4 | `message` | message clé | `statement` (titre d'écran masqué) | plein |
| 5 | `insight` | texte et illustration | `image` beside, `signal.svg` en ligne | plein |
| 6 | `pillars` | trois colonnes en cartes | `columns` style `cards` | calm |
| 7 | `figures` | chiffres clés | `key-figures` | plein |
| 8 | `part-two` | intercalaire de partie | `flow-section` | plein |
| 9 | `steps` | étapes | `process` | plein |
| 10 | `quote` | citation | `statement` quote | ink |
| 11 | `compare` | comparaison | `columns` style `versus` | calm |
| 12 | `check` | interaction | `quiz` à choix unique, retour compact | calm |
| 13 | `trend` | graphique | `trend` | calm |
| 14 | `recap` | récapitulatif | `text` style `recap` | ink |
| 15 | `end` | fin | `flow-cover` | plein |

Le texte est en anglais, abstrait et à la bonne longueur ; la traduction française est dans `translations/fr.xlf`, écrite par la traduction d'Elabora (`elabora_translate_text`). Pour voir l'écran en français : `elabora look . --screen cover --language fr`.

## Les variantes de décor

Elles sont déclarées dans `theme.backdrop.variants` ; un écran en choisit une avec `"backdrop": "<variante>"` (ou `"none"` pour éteindre le décor).

- **Plein** (sans variante) : la brume à moitié, toutes les particules, le saut complet. Pour la couverture, les intercalaires, le message clé.
- **`calm`** : la brume et les lueurs reculent, l'objet ne garde qu'un peu moins de la moitié de ses particules, les rend plus discrètes et réduit le saut de près de moitié. Pour les écrans denses : objectifs, cartes, comparaison, question, graphique.
- **`ink`** : la variante claire « à l'encre ». Papier clair, brume et lueurs aux deux encres (`color.ink-a`, `color.ink-b`), particules et lignes dessinées à l'encre, sans fusion lumineuse. Le texte de l'écran suit : `theme.css` redéfinit `--t-text`, `--t-muted`, `--t-primary`, `--t-accent` et les panneaux sous `#elabora-app:has(.t-backdrop[data-variant="ink"]) #t-main`. Les barres du lecteur restent sombres et encadrent le papier.

Le passage d'une variante à l'autre est un fondu : l'objet s'efface en 0,3 s, change de mode, puis revient.

## Adapter la charte à une marque

1. **Les deux néons.** Changez `color.neon-a` et `color.neon-b` dans `theme.custom`. La brume (un masque peint avec ces jetons), les lueurs, les chevrons de la couverture, les filets, les puces du récapitulatif et l'objet de décor (ses props `colorA` et `colorB` sont liées à ces jetons par `x-token`) suivent sans autre fichier à refaire. Gardez deux couleurs vives et assez lumineuses : elles brillent par addition sur le champ sombre.
2. **Les couleurs d'interface.** `color.primary` (boutons, Suivant, surtitres, numéros ; texte `color.onPrimary` dessus) et `color.accent` (le point fort des graphiques, la colonne « mieux », la citation). En général, primary = néon A et accent = néon B. Le validateur vérifie leurs contrastes (`E_THEME_CONTRAST`), et `elabora fit` mesure le texte sur les pixels réels du décor.
3. **Le champ.** `color.field` et `color.field-deep` (le dégradé du fond), `color.panel` et `color.panel-edge` (les cartes, opaques : pas de verre dépoli). Les barres du lecteur : `player.top.background` et `player.bottom.background`, à garder égales à `color.field`.
4. **La variante claire.** `color.paper`, `color.ink`, `color.ink-muted`, `color.ink-a`, `color.ink-b`, `color.ink-panel`, `color.ink-edge`. Pour un module **entièrement clair**, le plus simple est de mettre les jetons de la charte aux valeurs claires (`color.surface` et `color.field` au papier, `color.text` à l'encre, `color.primary` et `color.accent` aux encres) : l'objet passe de lui-même en mode encre quand `color.field` est clair. Sinon, donnez `"backdrop": "ink"` à chaque écran.
5. **Les polices.** `elabora font add . "<famille>" --for body,heading` remplace Figtree ; gardez une police à chasse fixe pour `font.mono` (`elabora font add . "JetBrains Mono" --for mono`) : c'est elle qui fait les chiffres.
6. **Le mouvement.** Dans `course.json`, `theme.backdrop.object.props` : `density` (particules, 0 à 1), `lines` (lignes, 0 à 1), `jump` (force du saut, 0 pour aucun). `order` (facultatif) liste les écrans dans l'ordre du module, pour que l'objet sache reconnaître un retour en arrière après une reprise de session ; vide, il se fie à l'ordre dans lequel l'apprenant découvre les écrans.
7. **Les nouveaux écrans** héritent de tout : choisissez une mise en page (`flow-cover`, `flow-section` ou aucune), un style nommé sur les blocs de texte et de colonnes, une variante de décor pour les écrans denses.

Après un changement de jetons, relancez `elabora assets .` si vous voulez que les couleurs par défaut de `signal.svg` suivent aussi : dans le module, l'illustration est en ligne et ses classes sont colorées par le thème.

## Vérifications

- `elabora validate .` : 0 erreur, 3 avertissements attendus pour un modèle (`W_PLAN_DRAFT`, `W_SPACING_MISSING`, `W_EXPOSITION_STREAK`).
- `elabora fit .` : 15/15 écrans tiennent à 1600×900 et à 1280×720, sans contraste insuffisant ; même chose en français (`elabora_check_fit` avec `language: "fr"`).
- `elabora test . --parallel 1` : 8/8 passages dans l'émulateur LMS, axe sans violation sur 30 états d'écran. Avec le parallélisme par défaut, sur une machine chargée, des passages échouent sur des délais (voir `frictions.md`).
- `elabora object test . flow-field` : les portes 2 à 6 passent (smoke, behaviour, budget, visual, accessibility), démarrage en 46 ms environ.
- `elabora translate status . --to fr` : 88/88 unités traduites.
- Captures : `captures/<écran>-1600x900.png` et `captures/<écran>-375x812.png` (faites avec `elabora screenshot --at 2500`, car `elabora look` n'applique pas les variantes de décor), et `captures/fr/` pour deux écrans en français.
