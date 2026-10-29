import { readDocs } from '../docs.ts';
import { defineTool, errorResult, objectSchema, textResult } from './tool.ts';

// Elabora's documentation for agents without a checkout: the same pages as docs/ and the site.
export const docsTool = defineTool({
  name: 'elabora_docs',
  readOnly: true,
  anywhere: true,
  description: 'Elabora\'s documentation as Markdown. No page: the map (each page\'s id and what it covers). page: a page by its id (design, components, free-object-contract, spec, delivery-scorm12, architecture/media…) or a decision by its number (D29); the bundled skills too, for a host that does not show MCP resources (page skills lists them); a long page comes as its opening and its sections, then ask for one with section (its words or its #anchor), or for all of it with full. Read the page a tool, a diagnostic\'s fix or the course rules name before designing, extending or explaining a behaviour. search: words to find (« what persists from one screen to the next », « backdrop safe area »): the sections that hold them, to read next. The CLI equivalent is elabora docs [page] [--section <s>] [--search <words>] (no course needed).',
  inputSchema: objectSchema({
    page: { type: 'string', description: 'A page id from the map (design, spec, architecture/media), a decision (D29) or a skill (skills/<name>, skills/<name>/<reference>).' },
    section: { type: 'string', description: 'One section of the page: its heading\'s words (Steps) or its anchor (#steps).' },
    full: { type: 'boolean', description: 'The whole page even when it is long.' },
    search: { type: 'string', description: 'Words to find in every page, decision and skill: the sections that hold them all, with the page and anchor to read.' }
  }),
  handler(args) {
    const result = readDocs(args);
    return result.ok ? textResult(result.text) : errorResult({ error: result.error });
  }
});
