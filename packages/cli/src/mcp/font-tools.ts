import { FONTS, FONT_CATALOGUE } from '@elabora/node/fonts';
import * as edit from '@elabora/node/edit';
import { defineTool, editResult, objectSchema, textResult } from './tool.ts';

// Fonts: the vetted fonts shipped with Elabora, and embedding one (or any other font with its licence).

const CATEGORIES = ['serif', 'sans-serif', 'monospace', 'display', 'handwriting'] as const;

export const listFonts = defineTool({
  name: 'elabora_list_fonts',
  readOnly: true,
  description: 'The vetted free fonts shipped with Elabora (available offline): family, category and style, what each is good for, weights, italic, subsets, size, licence (SIL OFL), the tokens elabora_add_font sets by default and fonts it pairs with. Files hold the latin subset (Western European languages) and, except UnifrakturMaguntia, the latin-ext subset (Central European, Baltic, Romanian, Turkish…): subsets lists the languages of each. Pick from it first; any other font can still be embedded with its licence (elabora_add_font from or files).',
  inputSchema: objectSchema({ category: { enum: CATEGORIES } }),
  handler: (args) => textResult({
    subsets: FONT_CATALOGUE.subsets,
    families: FONTS.filter((font) => !args.category || font.category === args.category).map((font) => ({
      family: font.family, category: font.category, style: font.style, use: font.use, variable: font.variable,
      weights: font.variable ? font.files[0].weight : [...new Set(font.files.map((file) => `${file.weight}${file.style === 'italic' ? ' italic' : ''}`))].join(', '),
      italic: font.styles.includes('italic'), subsets: font.subsets, kb: Math.round(font.bytes / 1024), license: font.license.id, for: font.for, stack: font.stack, pairs: font.pairs
    }))
  })
});

export const addFont = defineTool({
  name: 'elabora_add_font',
  description: 'Embed a font in the course with its licence: copies its WOFF2 files and licence into theme/fonts/<id>/, declares its faces in course.json theme.fonts (the player writes the @font-face rules) and gives its CSS stack to tokens (for: body → font.body, heading → font.heading, any other name → custom token font.<name> such as mono or display, read as var(--t-font-mono); none for no token; default: the font\'s usual role). Takes the latin files, and the latin-ext files too when the language of the course or of a translation needs them (Polish, Czech, Romanian, Turkish…: one face per file, with its unicode range, loaded only by pages that use its letters); subsets chooses. family: a vetted font (elabora_list_fonts). Another font: from, the folder or .tgz of its Fontsource package (npm pack @fontsource-variable/<id>), whose other subsets (cyrillic, greek, vietnamese…) subsets can name; or files, local WOFF2 files, with license, their licence file (weights and style are read from the files). Adding a family again replaces its faces (add it again after adding a language). Undo with elabora_undo.',
  inputSchema: objectSchema({
    family: { type: 'string', description: 'A vetted family ("EB Garamond"), or the family name to declare for from/files (default: the font\'s own).' },
    weights: { type: 'array', items: { type: 'integer', minimum: 100, maximum: 900, multipleOf: 100 }, description: 'Static fonts: the weights to take (default: all vetted; 400 and 700 for a Fontsource package). A variable file covers its whole range.' },
    styles: { type: 'array', items: { enum: ['normal', 'italic'] }, description: 'Default: every style there is.' },
    subsets: { type: 'array', items: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' }, minItems: 1, description: 'The subsets to embed: latin, latin-ext (vetted fonts), or any of a Fontsource package (cyrillic, greek, vietnamese…). Default: latin, and latin-ext when a language of the course needs it.' },
    for: { type: 'array', items: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' }, description: 'Tokens that get the font\'s stack: body, heading, mono, display… or ["none"].' },
    from: { type: 'string', description: 'Folder or .tgz of a Fontsource package (npm @fontsource/<id>, @fontsource-variable/<id>): its files of the subsets (with their unicode ranges) and LICENSE.' },
    files: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Local WOFF2 (or WOFF) files of one family.' },
    license: { type: 'string', description: 'With files: the licence file of the font (OFL.txt, LICENSE…).' }
  }),
  handler: (args, { root, author }) => editResult(edit.addFont(root, args, { author }))
});
