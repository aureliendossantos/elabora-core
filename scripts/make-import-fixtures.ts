// Synthetic Storyline and Rise modules for the importer's tests (docs/decisions.md D47): files that
// imitate the structure of real exports, written from scratch, with invented texts and pictures
// drawn here. No Articulate content, code or media: the player's scripts are left out, only the
// course data and the files an importer reads are written.
//
//   node scripts/make-import-fixtures.ts <dir>     writes every fixture into <dir>
//
// The tests call the builders directly (test/unit/import.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createZip } from '@elabora/node/zip';

type Files = Map<string, string | Uint8Array>;

// A PNG of one colour, drawn here: different sizes make different files (and MD5s).
export function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
// Storyline's wrapping: JSON in a single-quoted JavaScript string.
const provide = (kind: string, value: unknown) => `window.globalProvideData('${kind}', '${JSON.stringify(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`;

// ── Rise 360 ─────────────────────────────────────────────────────────
export function riseCourse(): Record<string, unknown> {
  const html = (text: string) => `<p>${text}</p>`;
  return {
    course: {
      id: 'fixture-rise-course', title: 'Sécurité au poste de travail', description: html('Un module court, écrit pour les tests.'),
      navigationMode: 'free', color: '#1F6FB2', headingTypeface: 'Lato', bodyTypeface: 'Merriweather',
      lessons: [
        { id: 'sec-1', type: 'section', title: 'Les bases', items: [] },
        {
          id: 'lesson-1', type: 'blocks', title: 'Ranger son poste', items: [
            { id: 'b1', type: 'text', family: 'text', variant: 'heading paragraph', items: [{ heading: 'Pourquoi ranger', paragraph: '<p>Un poste rangé évite <strong>les chutes</strong> et <em>les pertes</em>. Voir <a href="https://example.org/guide">le guide</a>.</p>' }] },
            { id: 'b2', type: 'text', family: 'impact', variant: 'b', items: [{ heading: 'À retenir', paragraph: html('Chaque objet a sa place.') }] },
            { id: 'b3', type: 'list', family: 'list', variant: 'numbered', items: [{ paragraph: html('Vider la corbeille') }, { paragraph: html('Ranger les câbles') }] },
            { id: 'b4', type: 'image', family: 'image', variant: 'hero', items: [{ media: { image: { key: 'rise/courses/x/desk.png', crushedKey: 'desk.png', useCrushedKey: true, alt: 'Un bureau rangé, vu de dessus' } }, caption: html('Un poste en ordre') }] },
            { id: 'b5', type: 'interactive', family: 'interactive', variant: 'accordion', items: [{ title: 'Les câbles', description: html('Attachez-les sous le plan de travail.') }, { title: 'Les cartons', description: html('Pas au sol.') }] },
            { id: 'b6', type: 'interactive', family: 'interactive', variant: 'tabs', items: [{ title: 'Matin', description: html('Ouvrir la fenêtre.') }, { title: 'Soir', description: html('Éteindre l\'écran.') }] },
            { id: 'b7', type: 'divider', family: 'continue', variant: 'continue', items: [{ title: 'Suite', type: 'completeBlock' }] },
            { id: 'b8', type: 'knowledgeCheck', family: 'knowledgeCheck', variant: 'multiple choice', items: [{ type: 'MULTIPLE_CHOICE', title: html('Où ranger les câbles ?'), feedbackType: 'CHOICE', answers: [{ id: 'a1', title: 'Sous le plan de travail', correct: true, feedback: html('Oui : ils ne gênent plus le passage.') }, { id: 'a2', title: 'Au sol', correct: false, feedback: html('Non : on peut s\'y prendre les pieds.') }] }] },
            { id: 'b9', type: 'knowledgeCheck', family: 'knowledgeCheck', variant: 'fillin', items: [{ type: 'FILL_IN_THE_BLANK', title: html('Un poste rangé évite les ___.'), answers: [{ id: 'f1', title: 'chutes' }] }] },
            { id: 'b10', type: 'interactive', family: 'interactive-fullscreen', variant: 'labeledgraphic', media: { image: { key: 'rise/courses/x/plan.png', crushedKey: 'plan.png', useCrushedKey: true, alt: 'Plan du bureau' } }, items: [{ x: '20', y: '30', title: 'Porte', description: html('Toujours dégagée.') }] },
            { id: 'b11', type: 'interactive', family: 'buttons', variant: 'button', items: [{ label: 'Aller au quiz', type: 'lesson', destination: 'quiz-1' }] },
            { id: 'b12', type: 'divider', family: 'divider', variant: 'spacing divider', items: [] },
            { id: 'b13', type: 'interactive', family: '360', variant: 'storyline', items: [{ media: { storyline: { src: 'ABCDEFGHIJKLMNOP/story.html' } } }] }
          ]
        },
        {
          id: 'quiz-1', type: 'quiz', title: 'Quiz final', settings: { passingScore: 80, retryCount: '-1', revealAnswers: true }, items: [
            { id: 'q1', type: 'MULTIPLE_RESPONSE', title: html('Quels gestes gardent le poste sûr ?'), feedbackType: 'CORRECT_INCORRECT', feedbackCorrect: html('Bravo, ce sont les deux bons gestes.'), feedbackIncorrect: html('Relisez la leçon sur le rangement.'), corrects: ['r1', 'r2'], answers: [{ id: 'r1', title: 'Ranger les câbles' }, { id: 'r2', title: 'Dégager la porte' }, { id: 'r3', title: 'Empiler les cartons' }] }
          ]
        }
      ]
    },
    labelSet: { id: 'labels', iso639Code: 'fr', labels: {} },
    fonts: [], media: []
  };
}

// A SCORM 1.2 export (the 2025–2026 page: deserialize("…")), as a ZIP's files.
export function riseScormFiles(): Files {
  const files: Files = new Map();
  files.set('imsmanifest.xml', '<?xml version="1.0"?><manifest identifier="fixture"><organizations default="articulate_rise"/><resources><resource identifier="r" type="webcontent" href="scormdriver/indexAPI.html"/></resources></manifest>\n');
  files.set('scormdriver/indexAPI.html', '<!doctype html><title>launch</title>\n');
  files.set('scormcontent/index.html', `<!doctype html><html><head><title>Rise</title></head><body><div id="app"></div><script>async function __fetchCourse() { return Promise.resolve(deserialize("${b64(riseCourse())}")) }</script></body></html>\n`);
  files.set('scormcontent/assets/desk.png', png(16, 12, [200, 210, 220]));
  files.set('scormcontent/assets/plan.png', png(20, 14, [230, 220, 200]));
  return files;
}

// A web export of 2024–2025: the page names a locale file, which holds the course.
export function riseLocaleFiles(): Files {
  const files: Files = new Map();
  files.set('content/index.html', '<!doctype html><script>window.i18n = {"available":["und"],"default":"und"};async function __fetchCourse(name) { return __loadJsonp(\'course:\' + name, \'locales/\' + name + \'.js\') }</script>\n');
  files.set('content/locales/und.js', `__resolveJsonp("course:und","${b64(riseCourse())}")\n`);
  files.set('content/assets/desk.png', png(16, 12, [200, 210, 220]));
  files.set('content/assets/plan.png', png(20, 14, [230, 220, 200]));
  return files;
}

// A web export of 2026: the player page only has a config block, the course is the call
// `__jsonp("runtime-data.js", "<base64>")` of runtime-data.js beside it, with the settings Rise adds
// next to the course.
export function riseRuntimeFiles(): Files {
  const files: Files = new Map();
  files.set('index.html', '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Sécurité au poste de travail</title><script type="application/json" id="__CONFIG__">\n{"remoteManifest":{"learn_distribution_frontend":{".js":["learn_dist/entry.js"]}},"assetTargetPrefixes":{"media":"assets","font":"lib/fonts"}}\n</script></head><body><div id="app"></div></body></html>\n');
  files.set('runtime-data.js', `__jsonp("runtime-data.js","${b64({ ...riseCourse(), settings: { lang: 'fr' }, deliveryPolicy: {}, exportAggregate: {}, partnerContent: [] })}")\n`);
  files.set('assets/desk.png', png(16, 12, [200, 210, 220]));
  files.set('assets/plan.png', png(20, 14, [230, 220, 200]));
  return files;
}

// The same, with the publication of a Storyline block under assets/ (Rise's own Storyline block:
// the course stays the Rise course, the block is reported).
export function riseRuntimeWithStorylineFiles(): Files {
  const files = riseRuntimeFiles();
  for (const [name, content] of storylinePublishedFiles()) files.set(`assets/ABCDEFGHIJKLMNOP/${name}`, content);
  return files;
}

// A course of 2026 holding an older export in a folder of its own (a project folder that kept its
// previous export): the root course is the one the player page boots.
export function riseRuntimeWithOlderExportFiles(): Files {
  const files = riseRuntimeFiles();
  const root = riseCourse();
  files.set('runtime-data.js', `__jsonp("runtime-data.js","${b64({ ...root, course: { ...(root.course as object), title: 'Le cours de la racine' } })}")\n`);
  for (const [name, content] of riseLocaleFiles()) files.set(name, content);
  return files;
}

// A SCORM export of 2017: the course itself (no wrapper) in a script of the page, `var data = '…'`.
export function riseLegacyFiles(): Files {
  const files: Files = new Map();
  files.set('imsmanifest.xml', '<?xml version="1.0"?><manifest identifier="fixture"><organizations default="articulate_rise"/><resources><resource identifier="r" type="webcontent" href="scormdriver/indexAPI.html"/></resources></manifest>\n');
  files.set('scormdriver/indexAPI.html', '<!doctype html><title>launch</title>\n');
  files.set('scormcontent/index.html', `<!doctype html><html><head><title>Rise</title></head><body><div id="app"></div><script>var data = '${b64((riseCourse() as { course: unknown }).course)}';\nwindow.start(data)</script></body></html>\n`);
  files.set('scormcontent/assets/desk.png', png(16, 12, [200, 210, 220]));
  files.set('scormcontent/assets/plan.png', png(20, 14, [230, 220, 200]));
  return files;
}

// ── Storyline, published ─────────────────────────────────────────────
const span = (text: string, size = 16, bold = false) => `<span style="font-family: 'Articulate Charset0_v8MBBDD1F1C','Articulate'; font-size:${size}px;">${bold ? `<b style="font-family: 'ArticulateBold CharBoldC2572EF3','Articulate';">${text}</b>` : text}</span>`;
const textObject = (id: string, x: number, y: number, width: number, height: number, html: string, extra: Record<string, unknown> = {}) => ({ kind: 'vectorshape', id, accType: 'text', xPos: x, yPos: y, width, height, textLib: [{ kind: 'textdata', id: '01', vartext: `<p style="text-align:left">${html}</p>` }], ...extra });

export function storylinePublishedFiles(): Files {
  const files: Files = new Map();
  const slide1 = {
    id: '5slideOneAa', title: 'Bienvenue', width: 720, height: 540,
    slideLayers: [
      {
        kind: 'slidelayer', isBaseLayer: true,
        timeline: { duration: 8000, events: [{ kind: 'ontimelinetick', time: 0, actions: ['5bg', '5title', '5left', '5img', '5next', '5hot', '5label'].map((value) => ({ kind: 'show', objRef: { type: 'string', value } })) }, { kind: 'ontimelinetick', time: 2500, actions: [{ kind: 'show', objRef: { type: 'string', value: '5late' } }] }] },
        objects: [
          { kind: 'vectorshape', id: '5bg', accType: 'image', xPos: 0, yPos: 0, width: 720, height: 540, imagelib: [{ kind: 'imagedata', id: '01', url: 'mobile/5bgPicture.png' }] },
          textObject('5title', 40, 20, 640, 50, span('Bienvenue dans le module', 36, true)),
          textObject('5left', 40, 120, 300, 200, span('Ce module dure dix minutes. Il montre comment préparer une intervention.')),
          { kind: 'vectorshape', id: '5img', accType: 'image', altText: 'Une technicienne devant une armoire électrique', xPos: 380, yPos: 120, width: 300, height: 200, imagelib: [{ kind: 'imagedata', id: '01', url: 'mobile/5photo.png', altText: 'Une technicienne devant une armoire électrique' }] },
          textObject('5late', 40, 340, 640, 40, span('Prenez le temps de lire chaque écran.')),
          textObject('5label', 40, 400, 300, 40, span('Voir les consignes')),
          { kind: 'vectorshape', id: '5hot', accType: 'button', xPos: 38, yPos: 398, width: 304, height: 44, events: [{ kind: 'onrelease', actions: [{ kind: 'show_slidelayer', hideOthers: 'oncomplete', objRef: { type: 'string', value: '_parent.5layerRules' } }] }] },
          { kind: 'vectorshape', id: '5next', accType: 'button', xPos: 560, yPos: 470, width: 120, height: 40, textLib: [{ kind: 'textdata', id: '01', vartext: `<p>${span('Commencer')}</p>` }], events: [{ kind: 'onrelease', actions: [{ kind: 'adjustvar', variable: '_player.Visites', operator: 'add', value: { type: 'number', value: 1 } }, { kind: 'gotoplay', objRef: { type: 'string', value: '_player.6sceneOneB.6slideTwoBb' } }, { kind: 'exe_javascript', script: 'void 0' }] }, { kind: 'onrollover', actions: [{ kind: 'adjustvar', variable: '5next._hover', operator: 'set', value: { type: 'boolean', value: true } }] }] },
          { kind: 'vectorshape', id: '5deco', accType: 'text', xPos: 0, yPos: 520, width: 720, height: 20 }
        ]
      },
      {
        kind: 'slidelayer', id: '5layerRules', modal: true,
        objects: [
          textObject('5ruleText', 160, 180, 400, 120, span('Coupez le courant avant toute intervention.')),
          { kind: 'vectorshape', id: '5close', accType: 'button', xPos: 300, yPos: 320, width: 120, height: 36, textLib: [{ kind: 'textdata', id: '01', vartext: `<p>${span('Fermer')}</p>` }], events: [{ kind: 'onrelease', actions: [{ kind: 'hide_slidelayer', objRef: { type: 'string', value: '_this' } }] }] }
        ]
      }
    ]
  };
  const slide2 = {
    id: '6slideTwoBb', title: 'Question', width: 720, height: 540,
    slideLayers: [
      {
        kind: 'slidelayer', isBaseLayer: true,
        objects: [
          textObject('6stem', 40, 30, 640, 60, span('Que faites-vous en premier ?', 24)),
          { kind: 'stategroup', id: '6choiceA', xPos: 40, yPos: 120, width: 400, height: 30, objects: [textObject('6choiceAtext', 0, 0, 400, 30, span('Je coupe le courant'))] },
          { kind: 'stategroup', id: '6choiceB', xPos: 40, yPos: 170, width: 400, height: 30, objects: [textObject('6choiceBtext', 0, 0, 400, 30, span('J\'ouvre l\'armoire'))] }
        ]
      },
      { kind: 'slidelayer', id: '6correct', modal: true, objects: [textObject('6ct', 160, 200, 400, 30, span('Correct')), textObject('6cb', 160, 240, 400, 60, span('Oui : sans courant, aucun risque d\'électrisation.'))] },
      { kind: 'slidelayer', id: '6wrong', modal: true, objects: [textObject('6wt', 160, 200, 400, 30, span('Incorrect')), textObject('6wb', 160, 240, 400, 60, span('Non : l\'armoire est encore sous tension.'))] }
    ]
  };
  const slide3 = {
    id: '6slideThree', title: 'Résultats', width: 720, height: 540,
    slideLayers: [{ kind: 'slidelayer', isBaseLayer: true, objects: [textObject('7score', 40, 40, 640, 60, span('Votre score : %Results.ScorePercent%')), textObject('7bye', 40, 140, 640, 60, span('Merci d\'avoir suivi ce module.'))] }]
  };
  const data = {
    version: '3.90.0.0', projectId: 'fixture', courseId: 'fixture_course_id',
    variables: [{ kind: 'variable', name: 'Visites', type: 'number', value: 0, resume: true }, { kind: 'variable', name: 'NonUtilisee', type: 'string', value: '', resume: true }, { kind: 'variable', name: 'CurrentQuiz_ABC', type: 'string', value: '', resume: true }],
    quizzes: [{ kind: 'quiz', id: 'quizA', passPercent: 80 }],
    assetLib: [{ kind: 'asset', id: 1, url: 'mobile/5photo.png' }],
    scenes: [
      { kind: 'scene', id: 'MsgScene_x', isMessageScene: true, slides: [{ id: 'InvalidPromptSlide', title: '<p>Invalid</p>' }] },
      {
        kind: 'scene', id: '6sceneOneB', sceneNumber: 1, slides: [
          { kind: 'slide', id: '5slideOneAa', title: 'Bienvenue', html5url: 'html5/data/js/5slideOneAa.js' },
          { kind: 'slide', id: '6slideTwoBb', title: 'Question', html5url: 'html5/data/js/6slideTwoBb.js', interactions: [{ kind: 'interaction', id: '6intr', type: 'multiplechoice', lmstext: 'Que faites-vous en premier ?', choices: [{ id: 'choice_6choiceA', lmstext: 'Je coupe le courant' }, { id: 'choice_6choiceB', lmstext: 'J\'ouvre l\'armoire' }], answers: [{ status: 'correct', evaluate: { statements: [{ kind: 'equals', choiceid: 'choices.choice_6choiceA' }] }, actions: [{ kind: 'show_slidelayer', objRef: { type: 'string', value: '6correct' } }] }, { status: 'incorrect', evaluate: { statements: [{ kind: 'equals', choiceid: 'choices.choice_6choiceB' }] }, actions: [{ kind: 'show_slidelayer', objRef: { type: 'string', value: '6wrong' } }] }] }] },
          { kind: 'slide', id: '6slideThree', title: 'Résultats', html5url: 'html5/data/js/6slideThree.js' }
        ]
      }
    ]
  };
  const frame = {
    navData: { outline: { links: [{ kind: 'slidelink', slideid: '_player.6sceneOneB', displaytext: 'Préparer une intervention', links: [{ kind: 'slidelink', slideid: '_player.6sceneOneB.5slideOneAa', displaytext: 'Bienvenue' }] }] } },
    notesData: [{ slideId: '6sceneOneB.5slideOneAa', content: '<p>Voix off : bienvenue, ce module dure dix minutes.</p>' }]
  };
  files.set('story.html', '<!doctype html><title>Préparer une intervention</title>\n');
  files.set('meta.xml', '<?xml version="1.0"?><meta><project id="fixture" title="Préparer une intervention" /><application name="Articulate Storyline" version="3.90.0.0" /></meta>\n');
  files.set('html5/data/js/data.js', provide('data', data));
  files.set('html5/data/js/frame.js', provide('frame', frame));
  files.set('html5/data/js/5slideOneAa.js', provide('slide', slide1));
  files.set('html5/data/js/6slideTwoBb.js', provide('slide', slide2));
  files.set('html5/data/js/6slideThree.js', provide('slide', slide3));
  files.set('mobile/5bgPicture.png', png(72, 54, [20, 40, 80]));
  files.set('mobile/5photo.png', png(30, 20, [180, 120, 60]));
  return files;
}

// ── Storyline, source (.story) ───────────────────────────────────────
const BOM = '\uFEFF';
const xml = (body: string) => `${BOM}<?xml version="1.0" encoding="utf-8" standalone="yes"?>${body}`;
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const documentText = (text: string, size = 16, family = 'Articulate', bold = false) => esc(`<Document><Content><Block><Style><ListStyle ListType="None" /></Style><Span Text="${esc(text)}"><Style FontFamily="${family}" FontSize="${size}" FontIsBold="${bold ? 'True' : 'False'}" /></Span></Block></Content></Document>`);
const loc = (l: number, t: number, r: number, b: number) => `<sldSz w="720" h="540" /><loc l="${l}" t="${t}" r="${r}" b="${b}" />`;
const timing = (start = 0) => `<tmCtxLst version="1"><txtTmCtx start="${start}" dur="5000" /></tmCtxLst>`;

export function storySourceFiles(): Files {
  const files: Files = new Map();
  const photo = png(24, 18, [90, 160, 90]);
  const texture = png(8, 8, [140, 100, 60]);
  const md5 = (bytes: Buffer) => crypto.createHash('md5').update(bytes).digest('hex');
  const G = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  files.set('[Content_Types].xml', xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml" /></Types>'));
  files.set('_rels/.rels', xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="story" Target="/story/story.xml" Id="R1" /></Relationships>'));
  files.set('package/services/metadata/core-properties/fixture.psmdcp', xml('<coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Les gestes de premiers secours</dc:title></coreProperties>'));
  files.set('story/story.xml', xml(`<story id="fixture"><varLst><var g="${G(901)}" name="Essais" dataType="num" val="0" type="user" /><var g="${G(902)}" name="Prenom" dataType="text" val="" type="user" /><var g="${G(903)}" name="Results.ScorePercent" dataType="num" val="0" type="prop" /></varLst><mediaLst><mediaLst><media g="${G(801)}" type="Png" displayName="victime.png" origFile="C:\\Users\\auteur\\Images\\victime.png" bytes="${photo.length}"><md5Checksum><stream>${md5(photo)}</stream><source></source></md5Checksum></media><media g="${G(802)}" type="Png" displayName="Bois.png" origFile="C:\\Program Files\\Common Files\\Articulate\\Shared\\Textures\\Bois.png" bytes="${texture.length}"><md5Checksum><stream></stream><source></source></md5Checksum></media></mediaLst></mediaLst><propLst><prop id="StorySize"><sz w="720" h="540" /></prop></propLst><quizMgr><quizLst><quiz g="${G(701)}" name="Quiz" passPct="70" /></quizLst></quizMgr><sceneLst><scene g="${G(601)}" name="Alerter"><sldIdLst><sldId>R11</sldId><sldId>R12</sldId></sldIdLst></scene></sceneLst></story>`));
  files.set('story/_rels/story.xml.rels', xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="slide" Target="/story/slides/slide1.xml" Id="R11" /><Relationship Type="slide" Target="/story/slides/slide2.xml" Id="R12" /></Relationships>'));
  files.set('story/slides/slide1.xml', xml(`<sld g="${G(101)}" name="Protéger, alerter, secourir"><shapeLst>`
    + `<pic g="${G(110)}" name="Texture bois" assetG="${G(802)}" zOrder="0">${timing()}${loc(600, 20, 680, 100)}</pic>`
    + `<textBox g="${G(111)}" name="Titre" zOrder="1">${timing()}${loc(40, 20, 680, 70)}<text>${documentText('Les trois gestes', 36, 'Articulate', true)}</text><plain>Les trois gestes</plain></textBox>`
    + `<textBox g="${G(112)}" name="Corps" zOrder="2">${timing()}${loc(40, 110, 340, 300)}<text>${documentText('Protéger la victime, alerter les secours, puis secourir.')}</text><plain>Protéger la victime, alerter les secours, puis secourir.</plain></textBox>`
    + `<pic g="${G(113)}" name="Victime" assetG="${G(801)}" zOrder="3">${timing()}${loc(380, 110, 680, 300)}<alt>Une personne allongée sur le côté</alt></pic>`
    + `<textBox g="${G(114)}" name="Astuce" zOrder="4" initState="Hidden">${timing(3000)}${loc(40, 330, 680, 380)}<text>${documentText('Le 15 est le numéro du SAMU.')}</text><plain>Le 15 est le numéro du SAMU.</plain></textBox>`
    + `<btn g="${G(115)}" name="Voir" zOrder="5">${timing()}${loc(40, 400, 240, 440)}<plain>Voir l'astuce</plain><trigLst><trig g="${G(116)}"><data enabled="true" event="OnClick" action="changeShapeState"><shape setStateG="${G(117)}" setStateName="Normal" /><other /></data><condLst /></trig><trig g="${G(118)}"><data enabled="true" event="OnClick" action="adjustVar"><other varG="${G(901)}" op="add" dblVal="1" useVar="false" /></data><condLst /></trig></trigLst></btn>`
    + `<btn g="${G(119)}" name="Suite" zOrder="6">${timing()}${loc(520, 470, 680, 510)}<plain>Suite</plain><trigLst><trig g="${G(120)}"><data enabled="true" event="OnClick" action="jumpToSlide" actSubType="spec"><slide jumpG="${G(201)}" /><other /></data><condLst><trigCond varG="${G(901)}" op="gte" floatVal1="1" andOr="and" /></condLst></trig><trig g="${G(121)}"><data enabled="true" event="OnClick" action="executeJavaScript"><other js="void 0" /></data><condLst /></trig></trigLst></btn>`
    + `<rect g="${G(122)}" name="Bandeau" zOrder="7">${timing()}${loc(0, 520, 720, 540)}<plain /></rect>`
    + `</shapeLst><trigLst /><note>${documentText('Voix off : en cas d\'accident, gardez votre calme.')}</note>`
    // The tip's own states, so that changeShapeState finds whose Normal state it sets.
    + `</sld>`).replace(`name="Astuce" zOrder="4" initState="Hidden">`, `name="Astuce" zOrder="4" initState="Hidden"><stateLst><state g="${G(117)}" name="Normal" /></stateLst>`));
  files.set('story/slides/_rels/slide1.xml.rels', xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="media" Target="/story/media/R5aaaa.png" Id="Rm1" /><Relationship Type="media" Target="/story/media/R5bbbb.png" Id="Rm2" /></Relationships>'));
  files.set('story/slides/slide2.xml', xml(`<sld g="${G(201)}" name="Question"><shapeLst>`
    + `<intrTitleTextBox g="${G(211)}" name="Titre" zOrder="0">${loc(40, 30, 680, 80)}<text>${documentText('Quel numéro appeler ?', 24)}</text><plain>Quel numéro appeler ?</plain></intrTitleTextBox>`
    + `<multiChoiceIntr g="${G(212)}" zOrder="1">${loc(40, 100, 680, 300)}<childLst><g>${G(213)}</g><g>${G(214)}</g></childLst><intrProps titleBoxG="${G(211)}" attempts="one" /></multiChoiceIntr>`
    + `<radio g="${G(213)}" parentG="${G(212)}" zOrder="2">${loc(60, 120, 400, 150)}<stateLst><state name="Normal"><text>${documentText('Le 15')}</text></state></stateLst><scoreData correct="true" /></radio>`
    + `<radio g="${G(214)}" parentG="${G(212)}" zOrder="3">${loc(60, 170, 400, 200)}<stateLst><state name="Normal"><text>${documentText('Le 36 15')}</text></state></stateLst><scoreData correct="false" /></radio>`
    + `</shapeLst><trigLst /><sldLayerLst>`
    + `<feedBackLayer g="${G(221)}" defaultName="Correct" modal="true"><shapeLst><feedbackTextBox g="${G(222)}" zOrder="0">${loc(160, 200, 560, 230)}<plain>Correct</plain></feedbackTextBox><feedbackTextBox g="${G(223)}" zOrder="1">${loc(160, 240, 560, 300)}<plain>Oui, le 15 joint le SAMU.</plain></feedbackTextBox></shapeLst></feedBackLayer>`
    + `<feedBackLayer g="${G(224)}" defaultName="Incorrect" modal="true"><shapeLst><feedbackTextBox g="${G(225)}" zOrder="0">${loc(160, 200, 560, 230)}<plain>Incorrect</plain></feedbackTextBox><feedbackTextBox g="${G(226)}" zOrder="1">${loc(160, 240, 560, 300)}<plain>Non, composez le 15.</plain></feedbackTextBox></shapeLst></feedBackLayer>`
    + `<sldLayer g="${G(231)}" name="Rappel" modal="false"><shapeLst><textBox g="${G(232)}" zOrder="0">${loc(400, 300, 700, 360)}<plain>Gardez votre calme.</plain></textBox></shapeLst></sldLayer>`
    + `</sldLayerLst></sld>`));
  files.set('story/media/R5aaaa.png', photo);
  files.set('story/media/R5bbbb.png', texture);
  return files;
}

// The files as a ZIP (deterministic), or written into a folder.
export const zipOf = (files: Files): Buffer => createZip(files as ReadonlyMap<string, Uint8Array | string>).zip;

export function writeFolder(dir: string, files: Files): void {
  for (const [name, content] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.resolve(process.argv[2] ?? 'import-fixtures');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'rise-scorm.zip'), zipOf(riseScormFiles()));
  writeFolder(path.join(out, 'rise-web'), riseLocaleFiles());
  writeFolder(path.join(out, 'rise-2026'), riseRuntimeFiles());
  fs.writeFileSync(path.join(out, 'rise-2017.zip'), zipOf(riseLegacyFiles()));
  fs.writeFileSync(path.join(out, 'storyline-published.zip'), zipOf(storylinePublishedFiles()));
  writeFolder(path.join(out, 'storyline-published'), storylinePublishedFiles());
  fs.writeFileSync(path.join(out, 'fixture.story'), zipOf(storySourceFiles()));
  console.log(`Import fixtures written into ${out}`);
}
