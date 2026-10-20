import fs from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { addSources, listSources, makeSourcesReadable, readSource } from '@elabora/node/sources/index';
import { defineTool, errorResult, objectSchema, textResult } from './tool.ts';

// The author's sources (docs/decisions.md D49): the files a module is made from, in sources/, never
// published. Agents read them through their readable versions, made on this computer.

const failure = (error: unknown) => errorResult({ error: error instanceof Error ? error.message : String(error), ...(error && typeof error === 'object' && 'code' in error ? { code: (error as { code: unknown }).code } : {}) });
const PAGE = 60_000;
const MAX_IMAGES = 8;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const PRIVACY = 'Readable versions are made on this computer and nothing leaves it; sources are never published. A client\'s brief may hold personal data: quote only what the module needs.';

export const listSourcesTool = defineTool({
  name: 'elabora_sources',
  readOnly: true,
  description: `The author's sources: the files the module is made from (a client's brief, a deck, recorded interviews), in sources/, never published. Each with its kind and its readable version: ready, partial (a transcript to come), stale or missing (elabora_source_read writes it), failed (it says why), native (an image, a text, a PDF: read the file itself) or unsupported (an older Office format, .doc .rtf .odt .ppt .odp .key, whose notes say to save it as .docx or .pptx, or as a PDF; other files). ${PRIVACY}`,
  inputSchema: objectSchema({}),
  async handler(_args, { root }) {
    try {
      return textResult({ sources: await listSources(root) });
    } catch (error) { return failure(error); }
  }
});

export const readSourceTool = defineTool({
  name: 'elabora_source_read',
  readOnly: true,
  description: `A source's readable version, as Markdown: a Word document's headings, paragraphs, lists and tables with its comments ({>>…<<}) and tracked changes ({++…++}, {--…--}); a PowerPoint deck slide by slide in reading order, with the speaker's notes, comments and the pictures each slide places (the slides themselves are not drawn: a PDF of the deck shows them); a video or a recording's transcript with times, heard on this computer (the model downloaded once, 671 MB) and a video's frames. Written first when missing or out of date (a long recording takes a while). Long texts come in parts: call again with offset. images: the pictures it names (slides, frames) in the answer, ${MAX_IMAGES} at most; else read them by their paths. An image or a PDF is read as it is: its path. ${PRIVACY}`,
  inputSchema: objectSchema({
    file: { type: 'string', description: 'The source: its name under sources/ (brief.docx), sources/brief.docx or its path.' },
    offset: { type: 'integer', minimum: 0, description: `Where to start in the text (characters), for a text longer than ${PAGE} characters.` },
    images: { type: 'boolean', description: `Send the pictures the readable version names (${MAX_IMAGES} at most) with the text.` },
    refresh: { type: 'boolean', description: 'false: read what is there without writing it again.' }
  }, ['file']),
  async handler(args, { root }) {
    try {
      const reading = await readSource(root, args.file, { refresh: args.refresh !== false, install: true });
      const { source } = reading;
      const parts = source.readable.parts.map((part) => path.join(root, ...part.split('/')));
      const meta = { source: source.name, kind: source.kind, status: source.readable.status, file: reading.file, notes: source.readable.notes, parts };
      const content: CallToolResult['content'] = [];
      if (reading.text === null) {
        content.push({ type: 'text', text: JSON.stringify({ ...meta, read: reading.file ? 'Read this file as it is.' : 'Nothing to read.' }, null, 1) });
      } else {
        const offset = args.offset ?? 0;
        const text = reading.text.slice(offset, offset + PAGE);
        const next = offset + PAGE < reading.text.length ? offset + PAGE : null;
        content.push({ type: 'text', text: JSON.stringify({ ...meta, length: reading.text.length, offset, next }, null, 1) });
        content.push({ type: 'text', text });
      }
      if (args.images) {
        for (const file of parts.filter((part) => IMAGE_TYPES[path.extname(part).toLowerCase()]).slice(0, MAX_IMAGES)) {
          content.push({ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: IMAGE_TYPES[path.extname(file).toLowerCase()] });
        }
      }
      return { content };
    } catch (error) { return failure(error); }
  }
});

export const addSourcesTool = defineTool({
  name: 'elabora_source_add',
  description: `Copies files the author gave into sources/ (a file already there is not copied again; a name taken is numbered), then writes their readable versions: read them with elabora_source_read. Only files the author gave for this module. ${PRIVACY}`,
  inputSchema: objectSchema({ files: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Absolute paths of files or folders.' } }, ['files']),
  async handler(args, { root }) {
    try {
      const added = await addSources(root, args.files.map((file) => path.resolve(root, file)));
      const sources = await makeSourcesReadable(root, { names: [...new Set(added.map((entry) => entry.name))], install: true });
      return textResult({ ok: true, added, sources });
    } catch (error) { return failure(error); }
  }
});
