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

Each setting stays changeable (`revisit: "retry"` alone gives « Choisir autrement » without going back after the end). A final decision cannot be revisited, nor anything before it.

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

`style: "messaging"` is a chat thread (characters on the left with a round portrait, the learner on the right); `style: "scene"` draws a backdrop and the `cast` large, with a few bubbles near them and a History for the whole thread. `pace` (`auto`: a turn's lines follow one another; `click`), `reveal` (`ink`: the words not said yet in a lighter ink; `appear`; `instant`) and `begins` (`auto`, `click`: a start card; `event`: `start-dialogue`) set the rhythm.

A character is a speaker of `course.json` `speakers`, with:
- `color`: a colour token of the theme for its name and bubble;
- `look`: `{ "svg": "personnages/marc.svg" }`, an SVG that follows the characters' convention (its root declares `data-expressions`, `data-gestures`, `data-default-expression` and `data-portrait`; the player sets `data-speaking`, `data-talking`, `data-mouth`, `data-expression`, `data-gesture`, `data-listening`, `data-paused` and `data-reduced-motion` on its `<g data-part="character">`), or pictures `{ "portrait": "…", "expressions": { "inquiet": "…" } }`. An expression or a gesture its look does not declare is `W_DIALOGUE_LOOK`;
- `narrator: true`: its lines are narration, said with its voice.

The block's template has the hooks of the `dialogue` behaviour ([Components](components.md#3-behaviours-headless-and-primitives)): `data-t-log` (the thread), `data-t-options` (the options' room), and optionally `data-t-group`, `data-t-stage`, `data-t-debrief`, `data-t-start`. A fork keeps the behaviour and changes the markup.

## Events: the dialogue and its screen

**Triggers** (target: the block): `dialogue.started`; `dialogue.node` (`node`); `dialogue.line` (`line`, when a line starts); `dialogue.chosen` (`node`, `option`); `dialogue.ended` (`ending`). They fire on every run.

**Conditions**, anywhere in the module, read the **scored run**: `{ "dialogue": "appel-marc", "ending": "maitrise" }`, `{ "dialogue": "appel-marc", "chosen": "premiere-question.b" }` (first or after a retry), `{ "dialogue": "appel-marc", "score": { "op": "gte", "value": 80 } }`, `{ "dialogue": "appel-marc", "done": true }`.

**Actions on a dialogue** of the same screen: `start-dialogue`, `goto-dialogue` (`block`, `node`: a free object or a click moves the conversation), `restart-dialogue`.

**Actions from a dialogue** (options' and cues' `do`) are presentation only: `show-block`, `hide-block`, `show-layer`, `hide-layer`, `play-media`, `pause-media`, `set-object-props`, `reveal-step`. Replaying a path opens no layer: it sets the last visibility and props of the blocks it touched. **A dialogue never writes the course's variables nor navigates** (`E_DIALOGUE_ACTION`): do it on `dialogue.ended`, in an event of the screen.

## Tools

- `elabora dialogue show [dir] <block>` (MCP `elabora_dialogue_show`): the dialogue as a script, the name, the stage direction, the line; each option with its quality, points, effects and « then … »; a stable text that also serves diffs.
- `elabora dialogue play [dir] <block> --choose b,a,a` (`elabora_dialogue_play`): the path of these choices, its lines and notes, the ending, the score, the decisions and the duration (the lines' audio, else estimated from the text). It fails when a choice is not offered, and says which were.
- `elabora dialogue paths [dir] <block>` (`elabora_dialogue_paths`): every path (2000 at most), the best and worst score, the endings and nodes reached and never reached, each path's duration.
- `elabora dialogue export [dir] <block> --to html|pdf` (`elabora_dialogue_export`): the map, then the script, for the client, in the course's language. The PDF is printed by the plan's printer (D48). The app exports the same page.
- `elabora_set_dialogue_node` writes one node whole (added after a node, first, or replaced in place), `elabora_remove_dialogue_node` removes one; the block itself is written with `elabora_add_block` and `elabora_update_block` like any block.

The map is computed by `@elabora/core` `dialogue/layout.ts`, pure and deterministic: a node's column is its distance from the start, nodes in a column are ordered by the barycentre of those that lead to them, edges are curves and those that go back (a retry, a loop) are dashed. The module stores no position.

## Translation

A dialogue's texts are translation units like any block's: `block.<id>.title`, `block.<id>.nodes.<node>.lines.<line>.text`, `block.<id>.nodes.<node>.prompt`, `block.<id>.nodes.<node>.options.<option>.text` (and `.label`, `.feedback`, `.unavailableText`), `block.<id>.nodes.<node>.options.<option>.reply.<line>.text`, `block.<id>.endings.<ending>.title` and `.text`.

## From Rise

`elabora import` turns Rise's scenario block into a dialogue: each content of each scene becomes a node, the line a line of the scene's character (a speaker made from its name), the scene description a narration, the answers options with where they go (another content or scene: `next`; « try again »: `retry`; End Scenario: `end`), their feedback a note, and the Correct / Neutral / Incorrect marks of the newer format a quality. The characters' poses and the backdrops are not kept; the import report says so.

## Writing well

- Short lines: one or two sentences (`W_DIALOGUE_LINE_LONG` over 280 characters).
- The consequence first, the note after; the note is never a character's line.
- About three options, good, ok and bad, plausible, of similar length (`W_DIALOGUE_OPTIONS_MANY`, `W_DIALOGUE_OPTIONS_UNEVEN`).
- Write the best path first, then the others; join back rather than branch forever (`W_DIALOGUE_TREE`).
- Check with `paths` (every ending reached, the best score at 100) and `play` (the best path, then each mistake).
