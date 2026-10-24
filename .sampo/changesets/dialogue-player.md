---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/cli: minor (Added)
---

Learners play dialogues (D61). The thread is a log whose bubbles arrive whole, read « Marc : … » by screen readers: characters' bubbles with their portrait and name, the learner's, narration, and trainer notes whose quality is said in words. The options come in a room under the thread that keeps its height, and the focus waits in its group « Votre réponse » once the learner answers, never before. Two styles: `messaging`, a chat thread, and `scene`, the backdrop and the cast with the bubbles between them and a History (a thread with portraits on a phone). Lines follow one another at a reading pace or on « Suite », the words lit in ink as the voice says them (or letter by letter, or at once); a line's words, its character's mouth, expression and gestures and its cues follow its audio's own time, and it ends on the audio's end. Speed, volume and « Couper les voix » apply; a refused autoplay leaves « Écouter la réplique » in the bubble. « Choisir autrement », « Reprendre d'ici », « Recommencer », « Réécouter », the endings found and the debrief come as the mode allows. In a slide the dialogue's box keeps its size: nothing moves while it plays. Reduced motion and the new « Affichage » setting « Texte : tout de suite » show lines whole.

The dialogue's progress is saved in the suspend data (field `t`) and counted in its worst case; its conditions, score, completion and the scored run's interactions (one per decision, recorded once) are live, with the `dialogue.*` triggers and the actions `start-dialogue`, `goto-dialogue` and `restart-dialogue`. A screen's transcript has each dialogue's path, and a screen without narration whose dialogue or layer speaks has a transcript too. The theme takes six `dialog.*` tokens (bubbles, text, words said and to be said, notes), checked for contrast once the course sets one. The canvas shows a dialogue after some choices or at a node (`renderScreen` and `canvasView` take `dialogue`), the Review reads the line being said and shows a line (`__elabora.dialogues.current()` and `show()`), and the LMS emulator plays dialogues to their end. Player labels for dialogues come in the seven languages.
