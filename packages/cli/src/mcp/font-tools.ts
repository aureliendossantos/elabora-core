import { FONTS, FONT_CATALOGUE } from '@elabora/node/fonts';
import * as edit from '@elabora/node/edit';
import { fromCommand, defineTool, editResult, objectSchema, textResult } from './tool.ts';

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
  ...fromCommand('add_font'),
  handler: (args, { root, author }) => editResult(edit.run(root, 'add_font', args, { author }))
});
