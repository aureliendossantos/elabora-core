---
npm/elabora: minor (Changed)
npm/@elabora/player: minor (Changed)
npm/@elabora/core: patch (Changed)
npm/@elabora/cli: patch (Changed)
---

Dialogues (D61): going back says what it does and what happened. The debrief holds « Changer ce choix » under each decision the learner may take back and « Recommencer » at its foot, so the learner acts without closing it first; « Revenir à un choix » remains only for a dialogue without a debrief. What came after the choice taken back fades, the thread comes back down to it, « Vous reprenez ici » marks where it goes on, and the option taken back says « votre choix précédent ». « Recommencer » (and `restart-dialogue`) says the whole dialogue again from its first line, under « Nouvel essai ». Nothing moves in a slide; under reduced motion it all happens at once. « Reprendre d'ici » and « Choisir autrement » use an arrow back, no longer the History's clock. A playing dialogue dispatches `elabora:dialogue` events in the page (`choose`, `feedback` with its quality, `back`, `end`, `history-open`, `history-close`, `debrief-open`, `debrief-close`) for the interface's sounds. The dialogues skill and `W_DIALOGUE_NO_RETURN` say so.
