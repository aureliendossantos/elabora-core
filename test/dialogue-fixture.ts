// The dialogue of the Lin 09 mock-up, « L'appel de Marc » (D61), and a course to hold it: the
// diagnostic-reseau fixture with Marc and Leïla as speakers and a screen of its own.
import fs from 'node:fs';
import path from 'node:path';
import { copyExample, readJSON, writeJSON } from './helpers.ts';

export const MARC_DIALOGUE = {
  id: 'appel-marc',
  type: 'dialogue',
  props: {
    title: "L'appel de Marc",
    learner: 'leila',
    mode: 'practice',
    scoring: 'quality',
    objective: 'OBJ-2',
    feedback: 'now',
    vars: [{ id: 'confiance', default: 0 }],
    nodes: [
      {
        id: 'appel', title: "L'appel de Marc",
        lines: [
          { id: 'm1', speaker: 'marc', expression: 'inquiet', text: "[inquiet, au téléphone] Bonjour… plus rien ne marche au deuxième étage : ni l'imprimante, ni le partage de fichiers.",
            cues: [{ at: { word: 'étage', edge: 'end' }, do: [{ type: 'show-block', block: 'plan-etage' }] }] },
          { id: 'l1', speaker: 'leila', expression: 'souriante', text: 'Bonjour Marc, je suis Leïla, du support. Je vous écoute.',
            cues: [{ at: { word: 'Bonjour' }, gesture: 'saluer' }] }
        ]
      },
      {
        id: 'premiere-question', title: "Quelle question poser d'abord ?", objective: 'OBJ-2',
        prompt: 'Quelle question posez-vous en premier ?',
        options: [
          { id: 'a', label: 'Depuis quand ?', text: 'Depuis quand le problème a-t-il commencé ?', quality: 'good', points: 10, add: { confiance: 1 },
            feedback: "Bon réflexe : l'heure du premier symptôme permet de recouper avec les journaux du réseau.",
            reply: [
              { id: 'm2', speaker: 'marc', expression: 'soulage', text: 'Depuis 8 h 52, quand je suis arrivé. Mes collègues aussi.' },
              { id: 'l2', speaker: 'leila', expression: 'concentree', text: 'Merci, je note : premier symptôme à 8 h 52.' }
            ] },
          { id: 'b', label: 'Redémarrer le routeur ?', text: 'Avez-vous essayé de redémarrer le routeur ?', quality: 'ok', points: -5,
            feedback: "Un redémarrage improvisé coupe tout l'étage et efface les journaux utiles au diagnostic.", next: 'routeur-redemarre' },
          { id: 'c', label: 'Demander le mot de passe', text: 'Pouvez-vous me donner votre mot de passe pour vérifier votre session ?', quality: 'bad', points: -10, retry: true, add: { confiance: -1 },
            feedback: "Ne demandez jamais un mot de passe au téléphone : c'est la porte d'entrée de l'hameçonnage vocal.",
            reply: [{ id: 'm3', speaker: 'marc', expression: 'inquiet', text: "Euh… c'est « Soleil2026 ». C'est normal de le dire ?" }] }
        ],
        next: 'ticket'
      },
      {
        id: 'routeur-redemarre', title: 'Conséquence B',
        lines: [{ id: 'm4', speaker: 'marc', expression: 'agace', text: "[agacé] Je l'ai débranché et rebranché… maintenant tout l'étage est coupé." }],
        next: 'ticket'
      },
      {
        id: 'ticket', title: 'Rédiger le ticket',
        lines: [{ id: 'n1', text: 'Leïla ouvre un ticket pendant que Marc patiente.' }],
        prompt: 'Que notez-vous dans le ticket ?',
        options: [
          { id: 'a', text: 'Deuxième étage : imprimante et partage coupés depuis 8 h 52, plusieurs postes.', quality: 'good', points: 10,
            feedback: "Le lieu, l'heure et l'étendue : l'équipe réseau peut agir sans rappeler Marc." },
          { id: 'b', text: 'Problème réseau signalé au deuxième étage, à vérifier.', quality: 'ok', points: 0,
            feedback: "Trop vague : sans l'heure ni les services touchés, l'équipe réseau devra rappeler." },
          { id: 'c', text: "L'utilisateur a redémarré le routeur, à surveiller.", quality: 'bad', points: -5,
            feedback: "Le ticket décrit une action, pas le symptôme : l'équipe réseau ne sait pas quoi chercher." }
        ]
      },
      {
        id: 'escalade', title: 'Escalader ou pas ?', final: true,
        lines: [
          { id: 'm5', speaker: 'marc', text: 'Merci de prendre le temps, vraiment.', if: [{ var: 'confiance', op: 'gte', value: 1 }] },
          { id: 'm6', speaker: 'marc', text: "Vous pouvez régler ça vite ? J'ai une réunion à 10 h." }
        ],
        prompt: 'Que faites-vous ?',
        options: [
          { id: 'a', text: "Je transmets le ticket à l'équipe réseau et je vous rappelle avant 10 h.", quality: 'good', points: 10,
            feedback: "Escalader avec un ticket complet, et dire quand on rappelle : Marc sait ce qui se passe." },
          { id: 'b', text: 'Je passe vous voir pour redémarrer les équipements moi-même.', quality: 'bad', points: -10,
            feedback: "Intervenir sans diagnostic risque d'aggraver la panne et retarde l'équipe réseau.",
            reply: [{ id: 'm7', speaker: 'marc', expression: 'inquiet', text: "D'accord… mais tout l'étage attend." }] }
        ]
      },
      { id: 'bilan', title: 'Bilan du scénario', lines: [{ id: 'n2', text: "Fin de l'appel." }], end: true }
    ],
    endings: [
      { id: 'maitrise', title: 'Maîtrisé', text: 'Vous avez posé le bon diagnostic et escaladé proprement.', if: [{ score: { op: 'gte', value: 80 } }] },
      { id: 'a-revoir', title: 'À revoir', text: 'Reprenez les choix marqués « mauvais » : chacun a une conséquence.' }
    ]
  }
};

export const LEILA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600" data-character="leila" data-expressions="neutre souriante concentree" data-default-expression="neutre" data-gestures="saluer:1.2 hocher:0.8" data-portrait="120 40 160 160"><g data-part="character"><circle cx="200" cy="120" r="80" fill="var(--character-skin, #c68e6a)"/></g></svg>`;

// A copy of the fixture course with the dialogue on a screen of its own (pratiquer, covering ITEM-3).
export function courseWithDialogue(dialogue: unknown = MARC_DIALOGUE): string {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.speakers = [
    { id: 'marc', name: 'Marc', color: 'color.accent' },
    { id: 'leila', name: 'Leïla', look: { svg: 'personnages/leila.svg' } }
  ];
  course.sections.find((section: { id: string }) => section.id === 'pratiquer').screens.push('appel');
  writeJSON(dir, 'course.json', course);
  fs.mkdirSync(path.join(dir, 'assets/personnages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/personnages/leila.svg'), LEILA_SVG);
  writeJSON(dir, 'screens/appel.json', {
    id: 'appel', title: 'Signaler l\'incident', covers: ['ITEM-3'],
    blocks: [
      dialogue,
      { id: 'plan-etage', type: 'callout', hidden: true, props: { variant: 'info', title: 'Deuxième étage', markdown: 'Imprimante et partage de fichiers du deuxième étage.' } }
    ],
    events: [
      { id: 'appel-fin', description: 'Compter un bon réflexe quand le dialogue est maîtrisé.', on: { type: 'dialogue.ended', target: 'appel-marc', ending: 'maitrise' }, do: [{ type: 'increment-variable', variable: 'bonsReflexes', by: 1 }] }
    ]
  });
  return dir;
}
