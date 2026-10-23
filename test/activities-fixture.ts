import { readJSON, writeJSON, writeFixture } from './helpers.ts';

// The activities of D63 on four screens of the reference example (section « Pratiquer », item ITEM-3):
// a fill-in in each presentation, a sort in each, a reflection of each kind, and a quiz on pictures
// (picture cards, then zones on one picture). The pictures are small SVG drawings written here.

const shape = (fill: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120" width="160" height="120"><rect width="160" height="120" rx="10" fill="${fill}"/>${body}</svg>\n`;
const PICTURES: Record<string, string> = {
  'images/act-router.svg': shape('#dbeafe', '<rect x="30" y="50" width="100" height="34" rx="6" fill="#1e3a8a"/><circle cx="50" cy="67" r="5" fill="#86efac"/><path d="M60 50 l-14 -26 M100 50 l14 -26" stroke="#1e3a8a" stroke-width="5"/>'),
  'images/act-switch.svg': shape('#fef3c7', '<rect x="22" y="48" width="116" height="26" rx="5" fill="#78350f"/><g fill="#fde68a"><rect x="32" y="56" width="10" height="10"/><rect x="50" y="56" width="10" height="10"/><rect x="68" y="56" width="10" height="10"/><rect x="86" y="56" width="10" height="10"/><rect x="104" y="56" width="10" height="10"/></g>'),
  'images/act-cable.svg': shape('#dcfce7', '<path d="M20 90 C60 10 100 110 140 30" stroke="#14532d" stroke-width="8" fill="none"/><rect x="128" y="18" width="18" height="22" rx="3" fill="#14532d"/>'),
  'images/act-desk.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360"><rect width="640" height="360" fill="#eef2ff"/><rect x="40" y="250" width="560" height="22" fill="#a16207"/><rect x="80" y="90" width="210" height="140" rx="8" fill="#1f2937"/><rect x="92" y="102" width="186" height="104" fill="#93c5fd"/><rect x="170" y="230" width="30" height="20" fill="#374151"/><rect x="380" y="200" width="150" height="40" rx="6" fill="#1e3a8a"/><circle cx="400" cy="220" r="6" fill="#86efac"/><path d="M470 240 C480 300 560 300 600 320" stroke="#14532d" stroke-width="7" fill="none"/></svg>\n`
};

export const ACTIVITY_SCREENS = ['activites-trous', 'activites-classer', 'activites-reflexion', 'activites-images'];

const feedback = { correct: 'Oui : vous suivez le chemin du paquet, du poste vers le serveur.', incorrect: 'Reprenez le chemin du paquet : il part du poste et passe par chaque équipement dans l’ordre.' };

export function addActivities(dir: string, { slides = false }: { slides?: boolean } = {}): void {
  for (const [file, svg] of Object.entries(PICTURES)) writeFixture(dir, `assets/${file}`, svg);
  const screen = (id: string, title: string, blocks: unknown[]) => writeJSON(dir, `screens/${id}.json`, { id, title, covers: ['ITEM-3'], completeWhen: 'interactions-done', blocks });
  screen('activites-trous', 'Texte à trous', [
    { id: 'trous-saisie', type: 'fill-in', props: { stem: 'Complétez la procédure.', markdown: 'Le poste envoie sa requête au [[routeur|routeur d’accès]], qui interroge le serveur [[DNS]].', feedback } },
    { id: 'trous-listes', type: 'fill-in', props: { presentation: 'menus', stem: 'Choisissez le bon équipement.', markdown: 'Le [[commutateur]] relie les postes d’un étage ; le [[routeur]] relie les réseaux.', distractors: ['répéteur'], feedback } },
    { id: 'trous-mots', type: 'fill-in', props: { presentation: 'bank', stem: 'Placez les mots.', markdown: 'On teste d’abord le [[câble]], puis la [[carte réseau]], enfin la [[passerelle]].', distractors: ['imprimante'], attempts: 2, feedback } }
  ]);
  screen('activites-classer', 'Classer', [
    { id: 'classer-paires', type: 'sort', props: { stem: 'Associez chaque symptôme à sa cause.', items: [{ id: 'lent', text: 'Tout est lent', target: 'debit' }, { id: 'rien', text: 'Aucun site ne répond', target: 'dns' }, { id: 'voisin', text: 'Le voisin a internet, pas moi', target: 'cable' }], targets: [{ id: 'debit', text: 'Débit saturé' }, { id: 'dns', text: 'DNS en panne' }, { id: 'cable', text: 'Câble débranché' }], feedback } },
    { id: 'classer-categories', type: 'sort', props: { presentation: 'categories', stem: 'Matériel ou logiciel ?', items: [{ id: 'routeur', text: 'Routeur', image: 'images/act-router.svg', alt: 'Un boîtier avec deux antennes', target: 'materiel' }, { id: 'pilote', text: 'Pilote de carte', target: 'logiciel' }, { id: 'cable', text: 'Câble', image: 'images/act-cable.svg', alt: 'Un câble avec sa prise', target: 'materiel' }, { id: 'dhcp', text: 'Service DHCP', target: 'logiciel' }], targets: [{ id: 'materiel', text: 'Matériel' }, { id: 'logiciel', text: 'Logiciel' }], attempts: 2, feedback } },
    { id: 'classer-ordre', type: 'sort', props: { presentation: 'order', stem: 'Remettez les vérifications dans l’ordre.', items: [{ id: 'voyant', text: 'Regarder le voyant de la carte' }, { id: 'ping', text: 'Lancer un ping vers la passerelle' }, { id: 'dns', text: 'Tester la résolution DNS' }, { id: 'ticket', text: 'Ouvrir un ticket' }], feedback } }
  ]);
  screen('activites-reflexion', 'Réflexion', [
    { id: 'reflexion-texte', type: 'reflection', props: { prompt: 'Pensez à la dernière panne réseau de votre service : par quoi avez-vous commencé ?', model: 'J’aurais d’abord regardé le voyant de la carte, puis lancé un ping vers la passerelle, avant d’appeler qui que ce soit.', download: true, maxLength: 400 } },
    { id: 'reflexion-echelle', type: 'reflection', props: { presentation: 'scale', prompt: 'Vous sentez-vous capable de faire ce diagnostic seul ?', scale: { min: 1, max: 5, minLabel: 'Pas du tout', maxLabel: 'Tout à fait' } } }
  ]);
  screen('activites-images', 'Questions en images', [
    { id: 'images-cartes', type: 'quiz', props: { presentation: 'images', stem: 'Quel équipement relie les réseaux ?', mode: 'single', options: [
      { id: 'a', text: 'Le routeur', image: 'images/act-router.svg', alt: 'Un boîtier bleu avec deux antennes', correct: true, feedback: 'Oui : il fait passer les paquets d’un réseau à l’autre.' },
      { id: 'b', text: 'Le commutateur', image: 'images/act-switch.svg', alt: 'Un boîtier long avec cinq prises', correct: false, feedback: 'Non : il relie les postes d’un même réseau.' },
      { id: 'c', text: 'Le câble', image: 'images/act-cable.svg', alt: 'Un câble avec sa prise', correct: false, feedback: 'Non : il transporte le signal, sans décider de sa route.' }] } },
    { id: 'images-zones', type: 'quiz', props: { presentation: 'image', image: 'images/act-desk.svg', alt: 'Un bureau : un écran, un boîtier bleu à voyant vert et un câble qui part vers le mur.', stem: 'Où regardez-vous d’abord quand le réseau ne répond plus ?', mode: 'single', options: [
      { id: 'a', text: 'Le voyant du boîtier', x: 0.625, y: 0.61, correct: true, feedback: 'Oui : un voyant éteint dit tout de suite que le lien est coupé.' },
      { id: 'b', text: 'L’écran', x: 0.29, y: 0.42, correct: false, feedback: 'Non : l’écran affiche l’erreur, il n’en dit pas la cause.' },
      { id: 'c', text: 'Le câble au mur', x: 0.9, y: 0.86, correct: false, feedback: 'Pas d’abord : le voyant le dit plus vite.' }] } }
  ]);
  const course = readJSON(dir, 'course.json');
  const section = course.sections.find((candidate: { id: string }) => candidate.id === 'pratiquer');
  for (const id of ACTIVITY_SCREENS) if (!section.screens.includes(id)) section.screens.push(id);
  if (slides) course.presentation = { mode: 'slides' };
  writeJSON(dir, 'course.json', course);
}
