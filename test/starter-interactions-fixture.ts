import { readJSON, writeJSON, writeFixture } from './helpers.ts';

// The starter interactions of D63 on screens of the reference example (section « Découvrir », item
// ITEM-2): a steps block (« Étapes ») in each presentation and each scroll figure, and an interactive
// picture (« Image interactive ») in each presentation. Each screen ends with a text block, so that
// tests can measure that nothing above it moves. The pictures are SVG drawings written here.

const W = 1200;
const H = 800;
const svg = (body: string, { width = W, height = H, fill = '' }: { width?: number; height?: number; fill?: string } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${fill ? `<rect width="${width}" height="${height}" fill="${fill}"/>` : ''}${body}</svg>\n`;
// The path of a print request, drawn five ways (one per step), then as a base and transparent layers.
const DEVICES = [
  { x: 120, label: '#1e3a8a' }, { x: 360, label: '#0f766e' }, { x: 600, label: '#7c2d12' }, { x: 840, label: '#6d28d9' }, { x: 1080, label: '#be123c' }
];
const device = (index: number, on: boolean) => `<g><rect x="${DEVICES[index].x - 80}" y="330" width="160" height="140" rx="18" fill="${on ? DEVICES[index].label : '#cbd5e1'}"/><circle cx="${DEVICES[index].x}" cy="400" r="22" fill="${on ? '#fde68a' : '#94a3b8'}"/></g>`;
const wire = (to: number) => `<path d="M120 400 H${DEVICES[to].x}" stroke="#334155" stroke-width="12" stroke-linecap="round"/>`;
export const STARTER_PICTURES: Record<string, string> = {
  ...Object.fromEntries(DEVICES.map((_, index) => [`images/etape-${index + 1}.svg`, svg(`${wire(index)}${DEVICES.map((__, other) => device(other, other <= index)).join('')}<text x="600" y="640" font-size="64" text-anchor="middle" fill="#0f172a" font-family="sans-serif">Étape ${index + 1}</text>`, { fill: ['#eff6ff', '#f0fdfa', '#fff7ed', '#f5f3ff', '#fff1f2'][index] })])),
  'images/chemin-base.svg': svg(`${DEVICES.map((_, index) => device(index, false)).join('')}`, { fill: '#f8fafc' }),
  ...Object.fromEntries(DEVICES.map((_, index) => [`images/chemin-couche-${index + 1}.svg`, svg(`${index ? `<path d="M${DEVICES[index - 1].x + 80} 400 H${DEVICES[index].x - 80}" stroke="#334155" stroke-width="12"/>` : ''}${device(index, true)}`)])),
  // A wide scene for the interactive picture: a desk, a screen, a box with a light, a cable to the wall, a printer.
  'images/bureau.svg': svg('<rect y="560" width="1600" height="40" fill="#a16207"/><rect x="180" y="200" width="420" height="300" rx="14" fill="#1f2937"/><rect x="200" y="220" width="380" height="230" fill="#93c5fd"/><rect x="360" y="500" width="60" height="60" fill="#374151"/><rect x="760" y="470" width="260" height="90" rx="10" fill="#1e3a8a"/><circle cx="800" cy="515" r="12" fill="#86efac"/><path d="M1020 520 C1120 620 1300 640 1560 700" stroke="#14532d" stroke-width="12" fill="none"/><rect x="1180" y="330" width="300" height="230" rx="16" fill="#e2e8f0" stroke="#475569" stroke-width="6"/><rect x="1220" y="300" width="220" height="40" fill="#f8fafc" stroke="#475569" stroke-width="6"/>', { width: 1600, height: 900, fill: '#eef2ff' }),
  'images/voyant.svg': svg('<circle cx="200" cy="150" r="90" fill="#86efac"/><circle cx="200" cy="150" r="40" fill="#22c55e"/>', { width: 400, height: 300, fill: '#1e3a8a' })
};

export const STARTER_SCREENS = ['etapes-carrousel', 'etapes-frise', 'etapes-defile', 'etapes-construire', 'etapes-zoom', 'image-repere', 'image-cote', 'image-dessous', 'image-visite'];

const STEPS = [
  { id: 'poste', title: 'Le poste envoie', markdown: 'Marc clique sur **Imprimer** : son ordinateur prépare la demande et l’envoie sur le câble de son bureau, vers le commutateur de l’étage.' },
  { id: 'commutateur', title: 'Le commutateur relaie', markdown: 'Le commutateur de l’étage reçoit la demande sur le port de Marc et la fait suivre vers le routeur. Un voyant éteint sur ce port signale un câble débranché.' },
  { id: 'routeur', title: 'Le routeur oriente', markdown: 'Le routeur fait passer la demande du réseau des bureaux à celui des serveurs. S’il est en panne, aucun poste de l’étage n’atteint plus les serveurs.' },
  { id: 'pare-feu', title: 'Le pare-feu filtre', markdown: 'Le pare-feu laisse passer les flux d’impression autorisés. Une règle mal écrite peut bloquer l’impression sans rien couper d’autre.' },
  { id: 'serveur', title: 'Le serveur imprime', markdown: 'Le serveur d’impression met la demande dans la file de l’imprimante. Une file bloquée arrête toutes les impressions du service.' }
];
const DATES = ['9 h 00', '9 h 00 et 2 ms', '9 h 00 et 5 ms', '9 h 00 et 6 ms', '9 h 00 et 9 ms'];
const REGIONS = [{ x: 0, y: 0.36, w: 0.2, h: 0.28 }, { x: 0.2, y: 0.36, w: 0.2, h: 0.28 }, { x: 0.4, y: 0.36, w: 0.2, h: 0.28 }, { x: 0.6, y: 0.36, w: 0.2, h: 0.28 }, { x: 0.8, y: 0.36, w: 0.2, h: 0.28 }];
export const MARKERS = [
  { id: 'ecran', x: 0.243, y: 0.37, title: 'L’écran', markdown: 'Il affiche le message d’erreur. Notez-le mot pour mot : il dit souvent où chercher, rarement la cause.' },
  { id: 'boitier', x: 0.5, y: 0.572, title: 'Le voyant', markdown: 'Le voyant vert du boîtier dit que le lien est actif. Éteint, le câble ou la prise est en cause : regardez-le d’abord.', image: 'images/voyant.svg', alt: 'Un voyant vert allumé sur un boîtier bleu' },
  { id: 'cable', x: 0.79, y: 0.72, title: 'Le câble', markdown: 'Il relie le boîtier à la prise murale. Un câble pincé ou débranché coupe tout sans autre signe.' },
  { id: 'imprimante', x: 0.83, y: 0.42, title: 'L’imprimante', markdown: 'Elle affiche son propre état. Si elle répond aux autres postes, le problème est entre le poste et le réseau.' }
];
const after = (id: string) => ({ id: `${id}-apres`, type: 'text', props: { markdown: 'Ce texte suit le bloc : rien ne doit le déplacer pendant que l’apprenant explore.' } });

export function addStarterInteractions(dir: string, { slides = false }: { slides?: boolean } = {}): void {
  for (const [file, drawing] of Object.entries(STARTER_PICTURES)) writeFixture(dir, `assets/${file}`, drawing);
  const screen = (id: string, title: string, blocks: unknown[]) => writeJSON(dir, `screens/${id}.json`, { id, title, covers: ['ITEM-2'], blocks: [...blocks, after(id)] });
  const pictured = STEPS.map((step, index) => ({ ...step, image: `images/etape-${index + 1}.svg`, alt: `Le chemin jusqu’à l’étape ${index + 1}` }));
  screen('etapes-carrousel', 'Étapes en carrousel', [{ id: 'etapes-carrousel-bloc', type: 'steps', props: {
    intro: { title: 'Le trajet d’une impression', markdown: 'Une demande d’impression traverse cinq équipements. Suivez-la, étape par étape, pour savoir où chercher quand rien ne sort.' },
    items: [pictured[0], STEPS[1], pictured[2], STEPS[3], STEPS[4]],
    summary: { title: 'À retenir', markdown: 'Cherchez la panne dans l’ordre du trajet : poste, commutateur, routeur, pare-feu, serveur.' }
  } }]);
  screen('etapes-frise', 'Étapes en frise', [{ id: 'etapes-frise-bloc', type: 'steps', props: { presentation: 'timeline', items: STEPS.map((step, index) => ({ ...step, date: DATES[index] })) } }]);
  screen('etapes-defile', 'Défilé : une image par étape', [{ id: 'etapes-defile-bloc', type: 'steps', props: { presentation: 'scroll', figure: 'replace', items: pictured } }]);
  screen('etapes-construire', 'Défilé : une figure qui se construit', [{ id: 'etapes-construire-bloc', type: 'steps', props: { presentation: 'scroll', figure: 'build', side: 'start', figureImage: 'images/chemin-base.svg', figureAlt: 'Les cinq équipements du chemin, éteints', items: STEPS.map((step, index) => ({ ...step, image: `images/chemin-couche-${index + 1}.svg`, alt: `Le chemin, allumé jusqu’à l’équipement ${index + 1}` })) } }]);
  screen('etapes-zoom', 'Défilé : une partie de la figure', [{ id: 'etapes-zoom-bloc', type: 'steps', props: { presentation: 'scroll', figure: 'focus', figureImage: 'images/etape-5.svg', figureAlt: 'Les cinq équipements du chemin, allumés et reliés', items: STEPS.map((step, index) => ({ ...step, region: REGIONS[index] })) } }]);
  const picture = (id: string, title: string, presentation: string, extra: Record<string, unknown> = {}) => screen(id, title, [{ id: `${id}-bloc`, type: 'hotspots', props: { presentation, image: 'images/bureau.svg', alt: 'Un bureau : un écran, un boîtier bleu à voyant vert, un câble vers le mur et une imprimante.', prompt: 'Sélectionnez chaque repère pour savoir quoi regarder.', items: MARKERS, ...extra } }]);
  picture('image-repere', 'Image interactive', 'popover', { focus: { x: 0.6, y: 0.5 } });
  picture('image-cote', 'Image interactive, texte à côté', 'side', { markerStyle: 'icon', icon: 'plus' });
  picture('image-dessous', 'Image interactive, texte dessous', 'below');
  picture('image-visite', 'Image interactive en visite', 'tour');
  const course = readJSON(dir, 'course.json');
  const section = course.sections.find((candidate: { id: string }) => candidate.id === 'decouvrir');
  for (const id of STARTER_SCREENS) if (!section.screens.includes(id)) section.screens.push(id);
  course.navigation = { mode: 'free', lockUntilComplete: false };
  if (slides) course.presentation = { mode: 'slides' };
  writeJSON(dir, 'course.json', course);
}
