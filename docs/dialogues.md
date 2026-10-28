# Dialogues

A `dialogue` block holds a branching conversation: the learner talks with one or more characters, each choice has its consequence, and the thread grows in the block. Its nodes, options and endings live in the block, not in screens or layers; events link it to the rest of the screen and of the module ([D61](decisions/D61.md)). This page is for authors and agents. Its props are in [Built-in blocks](blocks.md#dialogue-scenario); the codes it is checked with are in [Diagnostic codes](diagnostics.md).

## Common tasks, one sentence each

| You want… | You write… |
|---|---|
| a **mini-scenario**: a situation, one decision of three options (good, ok, bad), a consequence and a note for each | one node: two lines, three options with `quality`, `reply` and `feedback`; nothing to wire |
| a **dialogue of three decisions** where each bad answer shows its consequence, then lets the learner try again | three nodes one after the other, `retry: true` on the bad options |
| **branches and a bottleneck**, with endings good, ok or bad by score | `next` to two or three short branches that come back to the trunk; two or three `endings` with a `score` threshold |
| a **chat** without backdrop | nothing: `style: "messaging"` is the default |
| an **interview**: the learner picks their questions among six, each question asked greys out | options with `once: true` and `unavailable: "disable"`, and one permanent option « Passer à la suite » with `next` |
| a conversation with **several characters** | lines of different speakers in one node |
| a conversation **without choices** between two characters | lines in one node |
| an option that opens a **short branch, then comes back** | `next` to a node whose own `next` is the common way |
| a **photo** when Marc says « imprimante » | a cue on the word: `{ "at": { "word": "imprimante" }, "do": [{ "type": "show-block", "block": "photo" }] }` |
| Leïla **waves** on « Bonjour » | a cue on the word with `gesture: "saluer"` |
| another **screen by ending** | an event of the screen on `dialogue.ended` with `ending`, doing `go-to` |
| a **final** choice | `final: true` on its node (« Choix définitif », announced before the choice) |

## An example: Marc's call

The scene of the mock-up « Scénario à embranchements »: Leïla, support technician, takes Marc's call. Option A joins the common way, B opens a short branch that comes back, C makes the learner try again.

```json
{
  "id": "appel-marc",
  "type": "dialogue",
  "props": {
    "title": "L'appel de Marc",
    "learner": "leila",
    "mode": "practice",
    "scoring": "quality",
    "objective": "OBJ-2",
    "feedback": "now",
    "vars": [{ "id": "confiance", "default": 0 }],
    "nodes": [
      { "id": "appel", "title": "L'appel de Marc",
        "lines": [
          { "id": "m1", "speaker": "marc", "expression": "inquiet",
            "text": "[inquiet, au téléphone] Bonjour… plus rien ne marche au deuxième étage : ni l'imprimante, ni le partage de fichiers.",
            "cues": [{ "at": { "word": "étage", "edge": "end" }, "do": [{ "type": "show-block", "block": "plan-etage" }] }] },
          { "id": "l1", "speaker": "leila", "expression": "souriante", "text": "Bonjour Marc, je suis Leïla, du support. Je vous écoute.",
            "cues": [{ "at": { "word": "Bonjour" }, "gesture": "saluer" }] }
        ] },
      { "id": "premiere-question", "title": "Quelle question poser d'abord ?", "objective": "OBJ-2",
        "prompt": "Quelle question posez-vous en premier ?",
        "options": [
          { "id": "a", "label": "Depuis quand ?", "text": "Depuis quand le problème a-t-il commencé ?", "quality": "good", "points": 10, "add": { "confiance": 1 },
            "feedback": "Bon réflexe : l'heure du premier symptôme permet de recouper avec les journaux du réseau.",
            "reply": [
              { "id": "m2", "speaker": "marc", "expression": "soulage", "text": "Depuis 8 h 52, quand je suis arrivé. Mes collègues aussi." },
              { "id": "l2", "speaker": "leila", "expression": "concentree", "text": "Merci, je note : premier symptôme à 8 h 52." } ] },
          { "id": "b", "label": "Redémarrer le routeur ?", "text": "Avez-vous essayé de redémarrer le routeur ?", "quality": "ok", "points": -5,
            "feedback": "Un redémarrage improvisé coupe tout l'étage et efface les journaux utiles au diagnostic.", "next": "routeur-redemarre" },
          { "id": "c", "label": "Demander le mot de passe", "text": "Pouvez-vous me donner votre mot de passe pour vérifier votre session ?", "quality": "bad", "points": -10, "retry": true, "add": { "confiance": -1 },
            "feedback": "Ne demandez jamais un mot de passe au téléphone : c'est la porte d'entrée de l'hameçonnage vocal.",
            "reply": [{ "id": "m3", "speaker": "marc", "expression": "inquiet", "text": "Euh… c'est « Soleil2026 ». C'est normal de le dire ?" }] }
        ],
        "next": "ticket" },
      { "id": "routeur-redemarre", "title": "Conséquence B",
        "lines": [{ "id": "m4", "speaker": "marc", "expression": "agace", "text": "[agacé] Je l'ai débranché et rebranché… maintenant tout l'étage est coupé." }],
        "next": "ticket" },
      { "id": "ticket", "title": "Rédiger le ticket",
        "lines": [{ "id": "n1", "text": "Leïla ouvre un ticket pendant que Marc patiente." }],
        "prompt": "Que notez-vous dans le ticket ?",
        "options": [
          { "id": "a", "text": "Deuxième étage : imprimante et partage coupés depuis 8 h 52, plusieurs postes.", "quality": "good", "points": 10, "feedback": "Le lieu, l'heure et l'étendue : l'équipe réseau peut agir sans rappeler Marc." },
          { "id": "b", "text": "Problème réseau signalé au deuxième étage, à vérifier.", "quality": "ok", "feedback": "Trop vague : sans l'heure ni les services touchés, l'équipe réseau devra rappeler." },
          { "id": "c", "text": "L'utilisateur a redémarré le routeur, à surveiller.", "quality": "bad", "points": -5, "feedback": "Le ticket décrit une action, pas le symptôme : l'équipe réseau ne sait pas quoi chercher." }
        ] },
      { "id": "escalade", "title": "Escalader ou pas ?", "final": true,
        "lines": [
          { "id": "m5", "speaker": "marc", "text": "Merci de prendre le temps, vraiment.", "if": [{ "var": "confiance", "op": "gte", "value": 1 }] },
          { "id": "m6", "speaker": "marc", "text": "Vous pouvez régler ça vite ? J'ai une réunion à 10 h." }
        ],
        "prompt": "Que faites-vous ?",
        "options": [
          { "id": "a", "text": "Je transmets le ticket à l'équipe réseau et je vous rappelle avant 10 h.", "quality": "good", "points": 10, "feedback": "Escalader avec un ticket complet, et dire quand on rappelle : Marc sait ce qui se passe." },
          { "id": "b", "text": "Je passe vous voir pour redémarrer les équipements moi-même.", "quality": "bad", "points": -10, "feedback": "Intervenir sans diagnostic risque d'aggraver la panne et retarde l'équipe réseau.",
            "reply": [{ "id": "m7", "speaker": "marc", "expression": "inquiet", "text": "D'accord… mais tout l'étage attend." }] }
        ] },
      { "id": "bilan", "title": "Bilan du scénario", "lines": [{ "id": "n2", "text": "Fin de l'appel." }], "end": true }
    ],
    "endings": [
      { "id": "maitrise", "title": "Maîtrisé", "text": "Vous avez posé le bon diagnostic et escaladé proprement.", "if": [{ "score": { "op": "gte", "value": 80 } }] },
      { "id": "a-revoir", "title": "À revoir", "text": "Reprenez les choix marqués « mauvais » : chacun a une conséquence." }
    ]
  }
}
```

Marc and Leïla are speakers of `course.json`: `{ "id": "marc", "name": "Marc", "color": "color.accent" }`, `{ "id": "leila", "name": "Leïla", "look": { "svg": "personnages/leila.svg" } }`. `elabora dialogue paths . appel-marc` lists its 24 paths (choosing C, then another option, makes paths of their own: the first choice counts), the best at 100 % and the worst at 0 %.

## The parts

**A line** is a narration line (`id`, `speaker`, `text` with its stage directions in brackets, `delivery`, `pronunciations`), plus:
- `expression`: the speaker's face from this line on (persistent until another line or cue changes it). A stage direction says *how the voice says it*; an expression says *which face the drawing shows*;
- `cues`: moments on the words of the line (an anchor of D28 without its line: `{ "word": "Bonjour" }`, `edge`, `offset`, `occurrence`), each with a `gesture`, an `expression` or presentation actions (`do`);
- `if`: the line is skipped unless its conditions hold.

Line ids are unique in the screen, across its narration, its layers and its dialogues: a line's audio, translation and anchors are named by it.

**Three kinds of text never look alike:** a character's line (with its `speaker`), a narration (no `speaker`: a setting of the scene, centred, without bubble; a speaker declared `narrator: true` says it with its voice, still without a bubble), and the trainer's note (an option's `feedback`, never in a character's mouth).

**A node** is a moment of the conversation: its `lines`, then its way out, in this order:
1. its `options` (a decision of the learner; `prompt` over them);
2. its `next`: a node, or cases `[{ "if": [...], "go": "a" }, { "go": "b" }]` where the first that holds wins (end with a case without `if`);
3. its `end`: `true` (the endings' conditions choose) or an ending's id;
4. the next node of the list (after the last one, the end).

`final: true` makes its decision final. `title` is for authors (the script, the map), never shown. `scene` changes the backdrop (style `scene`).

**An option** is always said by the learner: it has no `speaker`. `text` is their bubble (`label`: a shorter button), `quality` (`good`, `ok`, `bad`: never shown before the choice), `reply` (the reaction: lines), `feedback` (the note, Markdown), `points`, `set` and `add` (the dialogue's `vars`), `do` (presentation actions), `next` or `end`, `retry` (after the reaction and the note, the same options come back, this one greyed), `once` (gone, or greyed, once taken on the path), `fallback` (never shown, taken by itself when nothing else can be chosen), `if` with `unavailable` (`hide` or `disable`) and `unavailableText`, `objective`.

**The central rule: without `next`, an option joins the common way**: its node's `next`, else its `end`, else the next node, else the end. A decision with a reaction and a note per option, then one thread, needs no wiring.

**Endings** (`endings[]`: `id`, `title`, `text`, `if`, `score`). `end: true` lets their conditions choose (the first that holds); `end: "maitrise"` picks one. Without endings, the dialogue ends without title.

**Conditions** are ANDed, as for events:
- `{ "chosen": "node.option" }`: chosen on the current path (a retried option counts: its consequence was played);
- `{ "seen": "node" }`: the node is on the current path;
- `{ "var": "confiance", "op": "gte", "value": 2 }`: a variable of the dialogue;
- `{ "score": { "op": "gte", "value": 80 } }`: the current score out of 100 (the quality score when the dialogue is not scored);
- `{ "variable": "role", "op": "eq", "value": "tech" }`: a variable of the course, read only.

A condition that names what no longer exists holds at run time; the validation reports it.

## The walk

One implementation, pure (no DOM, no Node), in `@elabora/player` `dialogue/`: the player plays it, and the core replays it for `play`, `paths`, the validation and the debrief, so they all compute the same thing.

1. **Enter a node**: count the visit, play its lines in order (a line whose `if` fails is skipped).
2. **Offer its options**: an option retried here is greyed; one whose `if` fails, or a `once` option taken, is hidden or greyed (`unavailable`). When none can be chosen: its `fallback`, else the common way. A single option left is not taken by itself.
3. **Choose**: the learner's bubble, then the effects (`set`, `add`: applied before any later condition; `points` count in the score), the actions, the `reply`, the note when the feedback is shown now.
4. **Leave**: `retry` (the same options; the retried choice's effects are undone, its first choice stays in the score), else the option's `next` or `end`, else the common way.
5. **End**: the ending, the debrief, `dialogue.ended`. On the scored run: the score, one SCORM interaction per decision, then the completion.
6. A path holds at most 60 decisions, and 400 nodes between two decisions (`W_DIALOGUE_DECISION_CAP`).

**Replay.** A dialogue's state is the list of the choices made. Everything else (the current node, the bubbles, the variables, the points, the greyed options) is recomputed by replaying that list from the start: on resume, when going back, after a new version of the module (replay stops at the first choice that no longer exists, and the learner resumes there) and for « Jouer un chemin ». Nothing is random.

## Modes and going back

| `mode` | `revisit` | `feedback` | `scoring` |
|---|---|---|---|
| `practice` (default) | `after-end`: « Choisir autrement » right after a consequence, then « Reprendre d'ici » on any past choice and « Recommencer » once the first end is reached | `both` | `none` |
| `assessment` | `none`: no going back (`retry` options go on to the common way) | `debrief` | `quality` |
| `exploration` | `anytime`: « Reprendre d'ici » from the first choice | `now` | `none` |

Each setting stays changeable (`revisit: "retry"` alone gives « Choisir autrement » without going back after the end). A final decision cannot be revisited, nor anything before it; once the dialogue has ended, « Recommencer » still starts it over, as a new run that leaves the scored run as it was. « Recommencer » says the whole dialogue again, from its first line: keep its opening short.

## Score, completion, SCORM

The score is 0 to 1, like any activity:
- `quality`: good 1, ok ½, bad 0, the mean over the decisions met (an option without quality does not count);
- `points`: the sum of the options' points over the highest sum a path can reach, computed on the graph (every path, or a bound when there are more than 2000);
- `ending`: the `score` (0–100) of the ending reached.

**The first run to an end is the only one scored**, whatever the mode: in each decision the **first choice** counts (a retried option, or a choice the learner went back on before the first end). Tries, returns and exploration after the first end change neither the score, nor the status, nor the interactions. A dialogue whose `scoring` is not `none` is scored, with its `weight`; it records one `choice` interaction per decision of the scored run (id: the node, `node.2` for its second occurrence on the path, prefixed by the block; response: the first option's id; result: `correct`, `neutral` or `wrong` from its quality; objective: the option's, else the node's, else the dialogue's). `completeWhen: "interactions-done"` counts the dialogue done once its first run reaches an end.

**Saved state.** One string per dialogue, under its key in `elabora.lock.json` (`dialogue:<block>`): `p|r|e|f`, empty fields at the end left out.
- `p`, the current path: its choices joined by `.`, each option by its own permanent key (`choice:<block>#<node>.<option>` in the lock), a first choice replaced by a return followed by `~`, a jump of the screen as `>node`;
- `r`, the scored run, only when it differs from `p`;
- `e`, the options explored, and `f`, the endings found: bit fields (6 bits a character), each option and ending at the place its key gives (`ending:<block>#<ending>`), never reused.

About 2 characters a decision. The compiler measures the worst case (`worstCaseDialogue`) with the same encoder, so the suspend-data budget stays exact.

## Styles and characters

`style: "messaging"` is a chat thread (characters on the left with a round portrait, the learner on the right); `style: "scene"` draws a backdrop and the `cast` large, with a few bubbles near them and a History for the whole thread. `pace` (`auto`: voiced lines follow one another, a text without a voice waits for « Suite »; `click`: every line waits), `reveal` (`ink`: the words not said yet in a faint ink; `appear`; `instant`; a line without a voice is always whole at once) and `begins` (`auto`, `click`: a start card; `event`: `start-dialogue`) set the rhythm.

A character is a speaker of `course.json` `speakers`, with:
- `color`: a colour token of the theme for its name and bubble;
- `look`: `{ "svg": "personnages/marc.svg" }`, an SVG that follows the characters' convention ([Characters](#characters)), or pictures `{ "portrait": "…", "expressions": { "inquiet": "…" } }`. An expression or a gesture its look does not declare is `W_DIALOGUE_LOOK`;
- `narrator: true`: its lines are narration, said with its voice.

The block's template has the hooks of the `dialogue` behaviour ([Components](components.md#3-behaviours-headless-and-primitives)): `data-t-log` (the thread), `data-t-options` (the options' room), and optionally `data-t-group`, `data-t-stage`, `data-t-debrief`, `data-t-start`. A fork keeps the behaviour and changes the markup.

## What the learner sees

- **The thread** is a log (`role="log"`, polite): each bubble arrives whole, so a screen reader reads it once, « Marc : … » (the name is said, the drawn words are hidden from it). Three kinds of text: a character's bubble (its portrait and name in its colour, on the left), the learner's (on the right, a tint of `color.accent`; named « Leïla (vous) », or once when the speaker's name already says « you »: « Vous », « You »), narration (centred, in italics, no bubble). A trainer's note (`feedback`, as `feedback` allows: now or in the debrief) sits outside the conversation, in neither side's lane: its quality in an icon and words (« Bon choix », « Choix moyen », « Choix à éviter »), never by colour alone, then its text; screen readers hear « Note du formateur » first.
- **The options** come under the thread, in a room that keeps its height from the first line (the tallest set of options, measured): nothing moves when they come or go. They take the focus of nobody: once the learner chooses, the focus waits in the group « Votre réponse », which stays. A final decision says « Choix définitif » above its options; an option already explored (exploration, after the end) says « déjà exploré »; an unavailable one is greyed with its reason, or hidden.
- **The pace.** `pace: "auto"`: the next line follows 0.4 to 0.8 s after a voice ends; a turn of the learner waits 0.8 s. A text without a voice (a line without audio, a narrator's line in a voiced dialogue, a note) is read, not heard: it waits for the learner's « Suite » before the next line or note, and the options come by themselves. « … » announces a character's bubble without a voice that comes by itself (after the learner's answer), in `messaging` only. `pace: "click"`: every line waits for « Suite ». « Suite » is quiet (the theme's muted ink, no outline) while the dialogue goes on by itself, the theme's filled button when it waits for the learner; a click on it while a voice speaks ends the line there (its words all in ink, its cues come) and goes on: a learner who has read ahead never waits for the voice. Entrée does the same; a click on a bubble goes on only when the dialogue waits, so that a stray click never cuts a voice. Pause and « Couper les voix » sit next to it.
- **The reveal** follows a voice; a line without one is whole at once. `ink`: every word is there from the start, those not said yet faint (`dialog.wordUnspoken`: by default the ink of the words said at 38 %, on whatever bubble), lit as the voice says them; `appear`: the letters of the word being said come in; `instant`: the line whole. The words to come are a preview, below the 4.5:1 of text on purpose, for the ink to show: the line's text reaches screen readers whole when it is inserted, every word reaches full ink as it is said, « Suite » ends the line at once, and reduced motion and the « Affichage » setting « Texte : tout de suite » (shown when the module has a dialogue) make every line instant, with nothing sliding. What is checked is the line at rest (axe, the emulator) and, when a theme sets the token, that the preview stays seen and far from the ink (« Colours » below).
- **Voices.** Each line plays its own file; its words, its character's mouth and its cues follow the audio's own time, and the line ends on the audio's end (`ended`). Speed, volume and « Couper les voix » are the narration's (« Affichage » and the controls). When the browser refuses to play before a gesture, the line goes on silent at its own pace and its bubble shows « Écouter la réplique » while it is said. Going back has « Reprendre d'ici » on the learner's past answers (when `revisit` allows): an icon beside the answer, on its free side, which the answer's bubble leaves room for from the start, so that nothing narrows or moves when it shows. « Écouter la réplique » sits there too, out of the flow. A dialogue that speaks pauses the screen's narration and layers' voices; a voice that starts elsewhere (the narration, a video) pauses the dialogue.
- **Going back.** « Choisir autrement » after a consequence (`retry` and up). At the end, the debrief is where the learner acts, without closing it first: « Changer ce choix » under each decision they may take back, « Recommencer » at its foot. « Reprendre d'ici » stays on the past answers in the thread (an icon beside the answer, `revisit` permitting). Without a debrief, the end has « Revenir à un choix », which brings the focus to the last answer the learner may take back, and « Recommencer ». The end shows « N fins découvertes sur M » when the dialogue has several endings.
- **What going back shows.** What came after the choice taken back fades where it is, then the thread comes back down to it; « Vous reprenez ici » marks where it goes on, and stays until the path is cut before it. Among the options, the one taken back says « votre choix précédent », and the focus is on « Votre réponse ». « Recommencer » says the whole dialogue again from its first line, under « Nouvel essai ». Nothing in the slide moves (the room keeps the height of the options with their longest mark), and under reduced motion it all happens at once.
- **The debrief** (`debrief: true`): the ending's title and text, the score, each decision with its question, the first choice (and « puis » what was kept after a retry), its quality in words, its note and « Changer ce choix », the endings found and not found, then « Recommencer ». In slides (and scenes) it is a panel over the thread, open at the end: the rest of the dialogue is dimmed and takes no click, a click on it or Échap closes the panel (the focus comes back where it was), and « Voir le bilan » opens it again; in scroll pages, it comes under the thread, and the end's bar leaves « Recommencer » to it.
- **Slides and scroll.** In a slide the dialogue's box keeps the size the slide leaves it (`--t-dialog-fill`, between 12 and 32 rem for `messaging`): the thread scrolls inside it, anchored at its bottom, and « Nouveau message » appears when the learner has scrolled up. Nothing in the slide moves while the dialogue plays. In a scroll page the thread grows in the page. A dialogue begins (`begins: "auto"`) when it is seen; `begins: "click"` shows its title and « Commencer » over the empty thread.
- **`scene`.** From 761 px wide: the backdrop, the `cast` standing at their positions (left, centre, right), the bubbles in a column between them (with a tail toward who speaks, the name in each bubble), the options below; the bubbles that do not fit turn as a page. « Historique » opens the whole thread in a panel over the scene, the rest dimmed and inert; Échap, its close button or a click beside it closes it, and the focus comes back to « Historique ». Narrower, a `scene` dialogue becomes a thread with portraits under a band of its backdrop.
- **Characters** act while their line plays: `speaking` and `talking` (the mouth on the envelope), the line's `expression`, gestures at their cue's time, the others `listening`; paused with the dialogue; a gesture plays once and the mouth stays closed under reduced motion.
- **The transcript.** The screen's transcript has each dialogue's path so far, under the dialogue's title. A screen without narration whose dialogue (or a layer) speaks has a transcript all the same: its button in the player's controls item.
- **Colours.** The theme's tokens, each with its default from the charter (checked for contrast, `E_THEME_CONTRAST`, as soon as the course sets one of them):

| Token | Default | What |
|---|---|---|
| `dialog.bubble` | `color.text` at 5 % on `color.surface` | a character's bubble |
| `dialog.learner` | `color.accent` at 12 % on `color.surface` | the learner's bubble |
| `dialog.text` | `color.text` | text of the bubbles (≥ 4.5:1 on both) |
| `dialog.wordSpoken` | `dialog.text` | the words said (≥ 4.5:1 on both bubbles) |
| `dialog.wordUnspoken` | `dialog.wordSpoken` at 38 % over the bubble | the words still to be said: a preview, seen on both bubbles (≥ 1.5:1) and far enough from the words said for the ink to show (≥ 3:1 with `dialog.wordSpoken`) |
| `dialog.note` | `color.primary` | the colour of a note without a quality (≥ 3:1 on `color.surface`); a quality has its own: `color.success`, `color.accent`, `color.error` |

They are the CSS variables `--t-dialog-bubble`, `--t-dialog-learner`, `--t-dialog-text`, `--t-dialog-word-spoken`, `--t-dialog-word-unspoken`, `--t-dialog-note`; a speaker's `color` gives `--t-dl-speaker` on its rows.

**Editors and the Review.** The canvas shows a dialogue at rest after some choices, or at a node (`renderScreen(…, { dialogue: { block, choices, node } })`, the canvas's `elabora/view` message; [Rendering](architecture/rendering.md)). The player's debug handle has `window.__elabora.dialogues`: `state(block)` (its `waiting`: the dialogue waits for « Suite »), `next(block)`, `choose(block, option)`, `advance(seconds)` on the virtual clock of tests, and for the Review `current()` (the line being said: `{ block, line, time }`) and `show(block, line)` (that line shown at rest, after the choices of the first path that says it). The LMS emulator plays each dialogue to its end through its buttons, choosing the best option at each decision.

## Voices

A dialogue's lines are voice lines like those of a screen's narration and of a layer's ([D24](decisions/D24.md), [D62](decisions/D62.md)): the voice tools, takes, word alignment, recordings, transcription, the audio's state and translation see them all.

- **Which lines have a voice.** A line with a `speaker` (a narrator speaker included); a line without speaker is a narration without voice. With `learnerVoice: true`, the learner's answers too, said by the voice of the `learner` speaker: an option has no id of its own in the screen, so its voice line is named `<node>.<option>` (`premiere-question.a`; a dot is never in an id, so it never meets a line's).
- **Their audio** keeps the convention: `assets/narration/<language>/<screen>/<line>.m4a` and its sidecar. `elabora voice generate <screen>` says the dialogue's lines with the narration's (`--line m1` for one); `elabora narration import` takes recordings named after them. A voice of several speakers (ElevenLabs' dialogue mode) says each node's lines, and each option's line with its reaction, as one exchange; a dialogue's lines take no pause from it (the player sets the rhythm).
- **Missing audio** is said once per dialogue (`W_NARRATION_AUDIO_MISSING`, path: the block's props); out of date, per line. A line id taken twice in the screen, whatever holds the two lines, is `E_NARRATION_LINE_DUPLICATE`.
- **The mouth's envelope.** When a line's audio is written (generated, imported, or its words timed again), the sidecar gets `mouth`: one letter per 1/30 s, `c` closed, `s` small, `o` open, `w` wide, measured on the sound (each frame's level, half against the line's loud level and half against its neighbours; thresholds from the line's own spoken frames, so a whisper moves the mouth as a loud voice does), closed in silences of more than 250 ms and on m, b, p. The build measures it for a sidecar without one.
- **In the package**, each line with audio is one file at the package's media quality: `narration/<screen>.<block>/<line>.m4a` (`narration/<language>/<screen>.<block>/…` for another language of the package). The course data gives every line (and every voiced answer) its `voice`: `src` (null without audio), `duration`, `words` (`[text, start, end]`, aligned or placed along the line), `mouth` and `estimated`; each cue its `time` in its line. Without audio, the voice is the core's estimate: 15 characters a second, the words placed in proportion to the text, a mouth drawn from the letters.

## Characters

A character drawn in SVG is **one file** of the module (`assets/personnages/marc.svg`). The compiler sanitizes it ([D33](decisions/D33.md): no script, no reference out of the drawing, its `<style>` scoped to it) with the class `t-character`, and the player mounts it twice if needed (the scene, the round avatar of the chat): the same drawing, the state set on its group, the parts it shows chosen by that state. Its own CSS only moves it.

**The root describes the character**; the validation, the player and the app read it:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600"
     data-character="marc"
     data-expressions="neutre souriant inquiet soulage agace"
     data-default-expression="neutre"
     data-gestures="saluer:1.2 hocher:0.8"
     data-portrait="94 118 212 212">
```

- `data-expressions`: the expressions it shows, lower case without accents, in the module's language; `data-default-expression` is one of them (else the first).
- `data-gestures`: each gesture with its duration in seconds, the duration of its CSS animation.
- `data-portrait`: the box of the face for the round avatar (`x y width height` in the viewBox).

**The tree** is always the same; each group that moves has a `data-part`:

```
<svg …>
  <style>…</style>
  <g data-part="character">              ← the player sets the state here
    <g data-part="breath">               ← breathing lifts the whole bust
      <g data-part="body">…</g>          ← neck, bust, collar
      <g data-part="head">               ← ears, head, hair, nose, cheeks, then:
        <g data-expression="neutre">…</g>       ← brows, eyes, the expression's detail (one per expression)
        <g data-part="eyes-closed">…</g>        ← eyelids, shown an instant by the blink
        <path data-mouth="closed"/> … small, open, wide   ← the four generic mouths
        <path data-mouth="closed" data-expression="souriant"/>  ← an expression's own mouths
      <g data-part="arm-wave" data-gesture="saluer">…</g>   ← exists only during the gesture
```

**The state**, on `<g data-part="character">`: `data-speaking` (its line is being said), `data-talking` (the voice sounds), `data-mouth` (`closed`, `small`, `open`, `wide`), `data-expression`, `data-gesture` (removed after its duration), `data-listening` (another speaks), `data-paused`, `data-reduced-motion`.

**What the player does, without a rule of the character**: a part is shown when each of its `data-gesture`, `data-expression` and `data-mouth` matches the state, hidden otherwise (on the descendants only, never the group); a mouth that names the expression wins over the generic mouth of the same shape. `data-part="eyes-closed"` is transparent until the character's blink shows it. Every animation stops under `data-paused`, and none plays under `data-reduced-motion` (each part rests in its base pose). So a character works without writing a single rule.

**What its CSS does**: breathing, blinking and gestures.
- Animate `transform` and `opacity` only, with `transform-box: view-box` and a `transform-origin` in `px` of the viewBox.
- Tie a gesture to the state, never to its part being shown: `[data-part="character"][data-gesture="saluer"] [data-part="arm-wave"] { animation: raise 1.2s ease-in-out both }`. The state and the parts use the same attribute names: always anchor the state on `[data-part="character"]`.
- `both` on a gesture; a gesture ends where it started (an arm that rises from the bottom of the frame goes back down); the base pose of a gesture's part is its final pose (what stays, still, under reduced motion); for a permanent part (the head), write its reduced pose.
- Breathing: 2 to 3 units, 4.5 to 5.5 s, `alternate`. Blink: 140 to 160 ms once every 5 to 7 s, with durations of its own per character.
- Colours are custom properties with their default, declared once in a class: `.skin { fill: var(--character-skin, #E8B48F) }`; a theme sets one character with `svg[data-character="marc"] { --character-top: #2F6B5E }`.
- `@keyframes` names stay simple (`blink`, `wave`): the sanitizer prefixes them per character. It also scopes every selector, reads the `<style>` as text, keeps lists inside `:is()`, `:where()`, `:not()` and `:has()`, and removes `@property` (registered properties belong to the page). Avoid CSS nesting with an ancestor context (`.arm { [data-paused] & {…} }` never applies once scoped) and an animation name passed through `var()`.

**What the convention forbids** (`W_CHARACTER_CONTENT`): an `id` (so no gradient, clip path, mask or filter: flat shapes instead; two copies on a page would repeat it), text (the name is in the bubbles), more than 40 KB. **What the player needs** (`W_CHARACTER_CONVENTION`): the `data-part="character"` group, the four generic mouths, `data-expressions` (with a default among them) and parts for each expression, `data-gestures` for every gesture its parts play. What the sanitizer had to remove is `W_SVG_INLINE_SANITIZED`.

**The style that works** (the sample characters follow it): flat geometric shapes without outlines, soft colours, one dark stroke with round caps for the brows, closed eyes and mouths; the head an ellipse about a third of the height (viewBox 400 × 600 for a bust), filled ellipses for eyes; one path for the hair; an arm is a thick stroke ending in a mitten. Never pure black (the ink is a very dark violet); clothes of medium saturation that stand out from the backdrop; one bright accent per character. Expressions go through the brows first (inner ends up for worry, down for annoyance, high and round for joy, flat and low for concentration), then the eyes, then one detail (a drop of sweat, pinker cheeks); each expression's own closed mouth carries it at rest. Every expression should read in a 40 px avatar.

**A new character**, step by step:
1. Copy a sample character and change `data-character`, then the palette's defaults (skin, hair, clothes, accent).
2. Redraw the hair and the top of the bust (collar, one simple accessory: a lanyard, a headset, glasses as two rounded rects). Keep the head, eyes, mouths and gestures where they are.
3. Set `data-expressions` to what it plays (the base five: `neutre souriant inquiet soulage agace`) and `data-gestures`; add an expression by copying `<g data-expression="neutre">`, changing brows, eyes and one detail, and adding its closed mouth `<path data-mouth="closed" data-expression="…">`; add a gesture as a part that exists only during it (`data-part="arm-wave" data-gesture="saluer"`, drawn in its final pose) or a rule on a permanent part.
4. Change its breathing and blinking durations.
5. Check: `elabora validate` (no `W_CHARACTER_*`, no `W_SVG_INLINE_SANITIZED`), then look at the character in the dialogue's screen (`elabora look`), its expressions and gestures, paused and with reduced motion.

**A backdrop** (`scene.background`) is an ordinary SVG or picture without convention: 1600 × 900, flat, low contrast (the bubbles and characters pass in front), the details on the edges, one bright point per place only if it tells something. For a call between two places, two half-backdrops side by side.

**In a fork of the block, or an app**, `@elabora/player` `character/` mounts a character without global DOM: `mountCharacter(host, speaker, { portrait })` gives a view whose `set({ speaking, talking, mouth, expression, gesture, listening, paused, reducedMotion })` sets the state, `gesture(name)` plays a gesture again from its start and removes it after its duration (a duration that stops while paused), and `dispose()` removes it; `voiceAt(voice, t)` gives the mouth, whether the voice sounds and the word said at a time of a line, and `textVoice(text)` a voice for a line without audio.

## Events: the dialogue and its screen

**Triggers** (target: the block): `dialogue.started`; `dialogue.node` (`node`); `dialogue.line` (`line`, when a line starts); `dialogue.chosen` (`node`, `option`); `dialogue.ended` (`ending`). They fire on every run.

**Conditions**, anywhere in the module, read the **scored run**: `{ "dialogue": "appel-marc", "ending": "maitrise" }`, `{ "dialogue": "appel-marc", "chosen": "premiere-question.b" }` (first or after a retry), `{ "dialogue": "appel-marc", "score": { "op": "gte", "value": 80 } }`, `{ "dialogue": "appel-marc", "done": true }`.

**Actions on a dialogue** of the same screen: `start-dialogue`, `goto-dialogue` (`block`, `node`: a free object or a click moves the conversation), `restart-dialogue` (from its first line, as « Recommencer »).

**Actions from a dialogue** (options' and cues' `do`) are presentation only: `show-block`, `hide-block`, `show-layer`, `hide-layer`, `play-media`, `pause-media`, `set-object-props`, `reveal-step`. Replaying a path opens no layer: it sets the last visibility and props of the blocks it touched. **A dialogue never writes the course's variables nor navigates** (`E_DIALOGUE_ACTION`): do it on `dialogue.ended`, in an event of the screen.

**Moments in the page**, for what reacts inside the player (the interface's sounds), not for the module's events: while a dialogue plays, its group (`data-t-group`) dispatches a bubbling `elabora:dialogue` event whose `detail` is `{ block, moment, … }`. Never when a path is shown at once (back on a screen, the editor's canvas).

| `moment` | When | Detail |
|---|---|---|
| `choose` | the learner chose an option | `node`, `option`, `quality` (or `null`) |
| `feedback` | a trainer's note shows | `quality`: `good`, `ok`, `bad`, or `null` when the note shows none (`feedback: "debrief"`, an option without quality) |
| `back` | the learner went back | `kind`: `retry` (« Choisir autrement »), `revisit` (« Changer ce choix », « Reprendre d'ici »), `restart` (« Recommencer », and `restart-dialogue`) |
| `end` | the dialogue reached an end | `ending` |
| `history-open`, `history-close` | the scene's History opened, closed | |
| `debrief-open`, `debrief-close` | the debrief panel opened (at the end, or « Voir le bilan »), the learner closed it | a move back closes it without its own moment: `back` says it |

## Tools

- `elabora dialogue show [dir] <block>` (MCP `elabora_dialogue_show`): the dialogue as a script, the name, the stage direction, the line; each option with its quality, points, effects and « then … »; a stable text that also serves diffs.
- `elabora dialogue play [dir] <block> --choose b,a,a` (`elabora_dialogue_play`): the path of these choices, its lines and notes, the ending, the score, the decisions and the duration (the lines' audio, else estimated from the text). It fails when a choice is not offered, and says which were.
- `elabora look [dir] --screen <screen> --block <block> --act choose:b --act choose:a` (`elabora_look` with `block` and `act`): the thread at rest after those choices, a close-up of the dialogue with its end in the window (the notes, the next options, the debrief), and the node waiting, the ending and the score.
- `elabora dialogue paths [dir] <block>` (`elabora_dialogue_paths`): every path (2000 at most), the best and worst score, the endings and nodes reached and never reached, each path's duration.
- `elabora dialogue export [dir] <block> --to html|pdf` (`elabora_dialogue_export`): the map, then the script, for the client, in the course's language. The PDF is printed by the plan's printer (D48). The app exports the same page.
- `elabora_set_dialogue_node` writes one node whole (added after a node, first, or replaced in place), `elabora_remove_dialogue_node` removes one; the block itself is written with `elabora_add_block` and `elabora_update_block` like any block.

The map is computed by `@elabora/core` `dialogue/layout.ts`, pure and deterministic: a node's column is its distance from the start, nodes in a column are ordered by the barycentre of those that lead to them, edges are curves and those that go back (a retry, a loop) are dashed. The module stores no position.

## Translation

A dialogue's texts are translation units like any block's: `block.<id>.title`, `block.<id>.nodes.<node>.lines.<line>.text`, `block.<id>.nodes.<node>.prompt`, `block.<id>.nodes.<node>.options.<option>.text` (and `.label`, `.feedback`, `.unavailableText`), `block.<id>.nodes.<node>.options.<option>.reply.<line>.text`, `block.<id>.endings.<ending>.title` and `.text`.

The units of its voice lines (and of the learner's answers with `learnerVoice`) are marked as a narration line's are: the words its cues wait for in `<mrk type="elabora:anchor">`, which translators place on the words of their language that say the same thing (the translated course's cues follow them, [D28](decisions/D28.md)), and its stage directions in `<mrk type="elabora:direction">` ([D29](decisions/D29.md)).

## From Rise

`elabora import` turns Rise's scenario block into a dialogue: each content of each scene becomes a node, the line a line of the scene's character (a speaker made from its name), the scene description a narration, the answers options with where they go (another content or scene: `next`; « try again »: `retry`; End Scenario: `end`), their feedback a note, and the Correct / Neutral / Incorrect marks of the newer format a quality. The characters' poses and the backdrops are not kept; the import report says so.

## Writing well

- Short lines: one or two sentences (`W_DIALOGUE_LINE_LONG` over 280 characters).
- The consequence first, the note after; the note is never a character's line.
- About three options, good, ok and bad, plausible, of similar length (`W_DIALOGUE_OPTIONS_MANY`, `W_DIALOGUE_OPTIONS_UNEVEN`).
- Write the best path first, then the others; join back rather than branch forever (`W_DIALOGUE_TREE`).
- Check with `paths` (every ending reached, the best score at 100) and `play` (the best path, then each mistake).
