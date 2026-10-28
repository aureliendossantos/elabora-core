import zlib from 'node:zlib';
import { createZip, crc32 } from '@elabora/node/zip';

// Synthetic sources for the tests of docs/decisions.md D49, written here byte by byte: no document
// of anyone, no tool that made them. A Word brief with what agencies' briefs hold (headings, lists,
// a table, an image, a footnote, a link, a field, a text box, comments with a reply, tracked
// changes) and a PowerPoint deck (placeholders placed by their layout, shapes out of reading order,
// a group, a table, notes, a comment, a hidden slide, a thumbnail, and the pictures slides place: one
// kept, a shape filled with a picture, a background, a linked picture, and a bullet, a rule and a logo
// placed as a dot, which are left out). The ZIP writer is
// deterministic: the same bytes every time. `pnpm run fixtures:sources` writes them to
// test/fixtures/sources/ to open them by hand.

// A PNG of one colour, width × height.
export function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)), { level: 9 });
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (entries: [id: string, type: string, target: string, external?: boolean][]) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
const core = (title: string) => `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>Agence Exemple</dc:creator></cp:coreProperties>`;

// ── Word ────────────────────────────────────────────────────────────────

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const WORD_NS = `${W} xmlns:r="${REL}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"`;

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (content: string, style?: string, numbering?: [numId: number, level: number]) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${numbering ? `<w:numPr><w:ilvl w:val="${numbering[1]}"/><w:numId w:val="${numbering[0]}"/></w:numPr>` : ''}</w:pPr>${content}</w:p>`;
const cell = (text: string, extra = '') => `<w:tc><w:tcPr>${extra}</w:tcPr>${para(run(text))}</w:tc>`;

export function briefDocx(): Buffer {
  const image = `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Image 1" descr="Plan d'évacuation du bâtiment A"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImage"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const textBox = `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:docPr id="2" name="Zone de texte 2"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent>${para(run('Encadré : rappeler le numéro 18 sur chaque écran.'))}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict>${para(run('Encadré : rappeler le numéro 18 sur chaque écran.'))}</w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
  const body = [
    para(run('Brief : formation sécurité incendie'), 'Title'),
    para(run('Contexte'), 'Heading1'),
    para(`${run('Le client forme ')}<w:commentRangeStart w:id="0"/>${run('300 collaborateurs')}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>${run(' répartis sur deux sites')}<w:ins w:id="10" w:author="Paul Martin" w:date="2026-10-02T09:00:00Z">${run(' dès janvier 2027')}</w:ins>${run('.')}<w:del w:id="11" w:author="Paul Martin" w:date="2026-10-02T09:01:00Z"><w:r><w:delText xml:space="preserve"> Budget à confirmer.</w:delText></w:r></w:del>`),
    para(`${run('Voir la norme')}<w:r><w:footnoteReference w:id="1"/></w:r>${run(' et le ')}<w:hyperlink r:id="rIdLink">${run('site du client')}</w:hyperlink>${run('.')}`),
    // A French style id ("Titre2"), a heading by its name.
    para(run('Objectifs pédagogiques'), 'Titre2'),
    para(run('Reconnaître une alarme'), 'ListParagraph', [1, 0]),
    para(run('Distinguer les deux signaux sonores'), 'ListParagraph', [1, 1]),
    para(run('Évacuer par l’issue la plus proche'), 'ListParagraph', [1, 0]),
    para(run('Étapes'), 'Heading2'),
    para(run('Donner l’alerte'), undefined, [2, 0]),
    para(run('Fermer les portes'), undefined, [2, 0]),
    para(run('Rejoindre le point de rassemblement'), undefined, [2, 0]),
    `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>
      <w:tr>${cell('Public')}${cell('Durée')}${cell('Format')}</w:tr>
      <w:tr>${cell('Agents | accueil')}${cell('20 min')}${cell('E-learning', '<w:vMerge w:val="restart"/>')}</w:tr>
      <w:tr>${cell('Encadrants')}${cell('35 min')}${cell('', '<w:vMerge/>')}</w:tr>
    </w:tbl>`,
    para(`${run('Page ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('2')}<w:r><w:fldChar w:fldCharType="end"/></w:r>${textBox}`),
    para(image),
    '<w:sectPr/>',
  ].join('');
  const document = `${XML}<w:document ${WORD_NS}><w:body>${body}</w:body></w:document>`;
  const styles = `${XML}<w:styles ${W}>
    <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
    <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
    <w:style w:type="paragraph" w:styleId="Titre2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>
  </w:styles>`;
  const numbering = `${XML}<w:numbering ${W}>
    <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  </w:numbering>`;
  const comments = `${XML}<w:comments ${WORD_NS}>
    <w:comment w:id="0" w:author="Marie Dupont" w:date="2026-10-01T10:00:00Z"><w:p w14:paraId="0A000001">${run('Chiffre à vérifier avec les RH.')}</w:p></w:comment>
    <w:comment w:id="1" w:author="Paul Martin" w:date="2026-10-02T11:00:00Z"><w:p w14:paraId="0A000002">${run('Confirmé : 312 en tout.')}</w:p></w:comment>
  </w:comments>`;
  const commentsExtended = `${XML}<w15:commentsEx ${WORD_NS}><w15:commentEx w15:paraId="0A000001" w15:done="0"/><w15:commentEx w15:paraId="0A000002" w15:paraIdParent="0A000001" w15:done="0"/></w15:commentsEx>`;
  const footnotes = `${XML}<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1">${para(run('Norme NF S 61-938.'))}</w:footnote></w:footnotes>`;
  const types = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  return createZip(new Map<string, string | Uint8Array>([
    ['[Content_Types].xml', types],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml'], ['rId2', 'metadata/core-properties', 'docProps/core.xml']])],
    ['docProps/core.xml', core('Brief formation incendie')],
    ['word/document.xml', document],
    ['word/_rels/document.xml.rels', rels([
      ['rIdStyles', 'styles', 'styles.xml'], ['rIdNumbering', 'numbering', 'numbering.xml'], ['rIdComments', 'comments', 'comments.xml'],
      ['rIdCommentsEx', 'commentsExtended', 'commentsExtended.xml'], ['rIdFootnotes', 'footnotes', 'footnotes.xml'], ['rIdImage', 'image', 'media/image1.png'],
      ['rIdLink', 'hyperlink', 'https://example.com/securite', true],
    ])],
    ['word/styles.xml', styles],
    ['word/numbering.xml', numbering],
    ['word/comments.xml', comments],
    ['word/commentsExtended.xml', commentsExtended],
    ['word/footnotes.xml', footnotes],
    ['word/media/image1.png', png(4, 3, [200, 40, 40])],
  ])).zip;
}

// ── PowerPoint ──────────────────────────────────────────────────────────

const P_NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const EMU = 914400 / 2.54; // per centimetre
const xfrm = (x: number, y: number, cx: number, cy: number) => `<a:xfrm><a:off x="${Math.round(x * EMU)}" y="${Math.round(y * EMU)}"/><a:ext cx="${Math.round(cx * EMU)}" cy="${Math.round(cy * EMU)}"/></a:xfrm>`;
const paragraphs = (lines: (string | [string, number])[]) => lines.map((line) => (typeof line === 'string' ? `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>` : `<a:p><a:pPr lvl="${line[1]}"/><a:r><a:t>${line[0]}</a:t></a:r></a:p>`)).join('');
let shapeId = 10;
const placeholder = (type: string | null, idx: number | null, lines: (string | [string, number])[], position?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId++}" name="Espace réservé"/><p:cNvSpPr/><p:nvPr><p:ph${type ? ` type="${type}"` : ''}${idx !== null ? ` idx="${idx}"` : ''}/></p:nvPr></p:nvSpPr><p:spPr>${position ?? ''}</p:spPr><p:txBody><a:bodyPr/>${paragraphs(lines)}</p:txBody></p:sp>`;
const textBox = (lines: (string | [string, number])[], position: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId++}" name="ZoneTexte"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${position}</p:spPr><p:txBody><a:bodyPr/>${paragraphs(lines)}</p:txBody></p:sp>`;
const tree = (shapes: string) => `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld>`;
const slide = (shapes: string, hidden = false, background?: string) => `${XML}<p:sld ${P_NS}${hidden ? ' show="0"' : ''}>${background ? tree(shapes).replace('<p:cSld>', `<p:cSld><p:bg><p:bgPr><a:blipFill><a:blip r:embed="${background}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`) : tree(shapes)}</p:sld>`;
const picture = (relId: string, name: string, descr: string, position: string, attribute = 'r:embed') =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${shapeId++}" name="${name}"${descr ? ` descr="${descr}"` : ''}/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip ${attribute}="${relId}"/></p:blipFill><p:spPr>${position}</p:spPr></p:pic>`;

export function workshopPptx(): Buffer {
  shapeId = 10;
  // Slide « 1 » of the file is shown second: the order is presentation.xml's.
  const intro = slide([
    // Drawn first, read last: a note at the bottom right.
    textBox(['Durée : 20 minutes'], xfrm(22, 16, 9, 1.5)),
    placeholder('title', null, ['Pourquoi évacuer ?']),
    placeholder(null, 1, ['Le feu se propage vite', ['Une pièce s’embrase en 3 minutes', 1], 'La fumée tue avant les flammes']),
    picture('rIdPicture', 'Image', 'Pictogramme sortie de secours', xfrm(24, 5, 6, 6)),
    // A bullet (8 px) and a rule (1200 × 4 px) drawn as pictures: left out.
    picture('rIdBullet', 'Puce', '', xfrm(1, 5, 0.5, 0.5)),
    picture('rIdRule', 'Filet', '', xfrm(2, 3.6, 20, 0.1)),
  ].join(''));
  const opening = slide([
    placeholder('ctrTitle', null, ['Sécurité incendie'], xfrm(2, 5, 29, 4)),
    placeholder('subTitle', 1, ['Atelier de lancement'], xfrm(2, 10, 29, 2)),
    placeholder('sldNum', 12, ['1'], xfrm(28, 17, 4, 1)),
  ].join(''));
  const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${shapeId++}" name="Tableau"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${Math.round(2 * EMU)}" y="${Math.round(4 * EMU)}"/><a:ext cx="${Math.round(20 * EMU)}" cy="${Math.round(4 * EMU)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="3657600"/><a:gridCol w="3657600"/></a:tblGrid>
    <a:tr h="100"><a:tc><a:txBody><a:bodyPr/>${paragraphs(['Signal'])}</a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/>${paragraphs(['Conduite'])}</a:txBody></a:tc></a:tr>
    <a:tr h="100"><a:tc><a:txBody><a:bodyPr/>${paragraphs(['Sonnerie continue'])}</a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/>${paragraphs(['Évacuer'])}</a:txBody></a:tc></a:tr>
  </a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${shapeId++}" name="Groupe"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${Math.round(2 * EMU)}" y="${Math.round(10 * EMU)}"/><a:ext cx="${Math.round(20 * EMU)}" cy="${Math.round(4 * EMU)}"/><a:chOff x="0" y="0"/><a:chExt cx="${Math.round(20 * EMU)}" cy="${Math.round(4 * EMU)}"/></a:xfrm></p:grpSpPr>
    ${textBox(['Point de rassemblement : parking B'], xfrm(10, 0, 10, 2))}${textBox(['Serre-file : badge orange'], xfrm(0, 0, 10, 2))}</p:grpSp>`;
  // A shape filled with a picture beside the table; the pictogram of the second slide again, as a 0.8 cm logo in a corner (a dot: left out here, kept there).
  const photo = `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId++}" name="Photo" descr="Extincteur à eau"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(24, 4.2, 8, 5.3)}<a:blipFill><a:blip r:embed="rIdPhoto"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr></p:sp>`;
  const signals = slide([placeholder('title', null, ['Les deux signaux']), group, table, photo, picture('rIdPicture', 'Logo', 'Logo', xfrm(32, 17, 0.8, 0.8))].join(''));
  // A hidden annex with a picture for its background and one linked to a file outside the deck.
  const annex = slide([placeholder('title', null, ['Annexe : contacts']), textBox(['Service sécurité : poste 4400'], xfrm(2, 5, 20, 2)), picture('rIdLinked', 'Plan', 'Plan du site B', xfrm(2, 8, 10, 6), 'r:link')].join(''), true, 'rIdBackground');
  const notes = `${XML}<p:notes ${P_NS}>${tree(`${placeholder('sldImg', null, [])}${placeholder('body', 1, ['Insister sur la fumée.', 'Demander qui connaît son serre-file.'])}`)}</p:notes>`;
  const comments = `${XML}<p:cmLst ${P_NS}><p:cm authorId="0" dt="2026-10-03T08:00:00Z" idx="1"><p:pos x="10" y="10"/><p:text>Ajouter le plan du site B ?</p:text></p:cm></p:cmLst>`;
  const authors = `${XML}<p:cmAuthorLst ${P_NS}><p:cmAuthor id="0" name="Léa Bernard" initials="LB" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`;
  const layout = `${XML}<p:sldLayout ${P_NS} type="titleAndBody">${tree(`${placeholder('title', null, [], xfrm(2, 1, 29, 3))}${placeholder(null, 1, [], xfrm(2, 4.5, 20, 12))}`)}</p:sldLayout>`;
  const master = `${XML}<p:sldMaster ${P_NS}>${tree(`${placeholder('title', null, [], xfrm(2, 1, 29, 3))}${placeholder('body', 1, [], xfrm(2, 4.5, 29, 12))}`)}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
  const theme = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Elabora"><a:themeElements><a:clrScheme name="Elabora"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="C82828"/></a:accent1><a:accent2><a:srgbClr val="2563EB"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="CA8A04"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Elabora"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Elabora"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const presentation = `${XML}<p:presentation ${P_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rIdSlide2"/><p:sldId id="257" r:id="rIdSlide1"/><p:sldId id="258" r:id="rIdSlide3"/><p:sldId id="259" r:id="rIdSlide4"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const slideTypes = [1, 2, 3, 4].map((n) => `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  const types = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideTypes}<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/><Override PartName="/ppt/comments/comment1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/><Override PartName="/ppt/commentAuthors.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const toLayout: [string, string, string] = ['rIdLayout', 'slideLayout', '../slideLayouts/slideLayout1.xml'];
  return createZip(new Map<string, string | Uint8Array>([
    ['[Content_Types].xml', types],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml'], ['rId2', 'metadata/core-properties', 'docProps/core.xml'], ['rId3', 'metadata/thumbnail', 'docProps/thumbnail.png']])],
    ['docProps/core.xml', core('Atelier sécurité incendie')],
    ['docProps/thumbnail.png', png(16, 9, [240, 240, 240])],
    ['ppt/presentation.xml', presentation],
    ['ppt/_rels/presentation.xml.rels', rels([
      ['rIdMaster', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rIdSlide1', 'slide', 'slides/slide1.xml'], ['rIdSlide2', 'slide', 'slides/slide2.xml'],
      ['rIdSlide3', 'slide', 'slides/slide3.xml'], ['rIdSlide4', 'slide', 'slides/slide4.xml'], ['rIdAuthors', 'commentAuthors', 'commentAuthors.xml'], ['rIdTheme', 'theme', 'theme/theme1.xml'],
    ])],
    ['ppt/commentAuthors.xml', authors],
    ['ppt/theme/theme1.xml', theme],
    ['ppt/slideMasters/slideMaster1.xml', master],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']])],
    ['ppt/slideLayouts/slideLayout1.xml', layout],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])],
    ['ppt/slides/slide1.xml', intro],
    ['ppt/slides/_rels/slide1.xml.rels', rels([toLayout, ['rIdPicture', 'image', '../media/image1.png'], ['rIdBullet', 'image', '../media/image2.png'], ['rIdRule', 'image', '../media/image3.png'], ['rIdNotes', 'notesSlide', '../notesSlides/notesSlide1.xml']])],
    ['ppt/slides/slide2.xml', opening],
    ['ppt/slides/_rels/slide2.xml.rels', rels([toLayout])],
    ['ppt/slides/slide3.xml', signals],
    ['ppt/slides/_rels/slide3.xml.rels', rels([toLayout, ['rIdComments', 'comments', '../comments/comment1.xml'], ['rIdPhoto', 'image', '../media/image4.png'], ['rIdPicture', 'image', '../media/image1.png']])],
    ['ppt/slides/slide4.xml', annex],
    ['ppt/slides/_rels/slide4.xml.rels', rels([toLayout, ['rIdBackground', 'image', '../media/image5.png'], ['rIdLinked', 'image', 'file:///C:/Users/Marie/Documents/plan-site-B.png', true]])],
    ['ppt/notesSlides/notesSlide1.xml', notes],
    ['ppt/notesSlides/_rels/notesSlide1.xml.rels', rels([['rId1', 'slide', '../slides/slide1.xml']])],
    ['ppt/comments/comment1.xml', comments],
    ['ppt/media/image1.png', png(96, 96, [22, 163, 74])],
    ['ppt/media/image2.png', png(8, 8, [200, 40, 40])],
    ['ppt/media/image3.png', png(1200, 4, [150, 150, 150])],
    ['ppt/media/image4.png', png(300, 200, [37, 99, 235])],
    ['ppt/media/image5.png', png(320, 180, [243, 244, 246])],
  ])).zip;
}

// ── PDF ─────────────────────────────────────────────────────────────────

// A PDF of one line of ASCII text a page, in Helvetica, with its cross-reference table.
export function textPdf(pages: readonly string[]): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((text, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`;
    objects[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objects[pageIds[i] + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
