import { installDownload, optionalDownloads, uninstallDownload } from '@elabora/node/downloads/index';
import { defineTool, errorResult, objectSchema, textResult } from './tool.ts';

// Optional downloads (docs/decisions.md D38): the models Elabora downloads once per computer on first
// use (the local voices, the word aligners), never in a course.

const failure = (error: unknown) => errorResult({ error: error instanceof Error ? error.message : String(error), ...(error && typeof error === 'object' && 'code' in error ? { code: (error as { code: unknown }).code } : {}) });
const ID = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$', description: 'An id from elabora_downloads: voices-fr, aligner-en…' } as const;

export const listDownloadsTool = defineTool({
  name: 'elabora_downloads',
  readOnly: true,
  description: 'What Elabora downloads once per computer on first use, never into a course: the local voices\' models and the word aligners, by language, each with what it is for (serves), what happens without it (without), what it holds (a language\'s voices), installed with its size on disk or the size to download, installing (bytes received, by the app, a command or an agent) and inUse.',
  inputSchema: objectSchema({ kind: { type: 'string', description: 'Only this kind: voices, aligner.' }, language: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$', description: 'Only this language.' } }),
  handler(args) {
    return textResult({ downloads: optionalDownloads({ ...(args.kind ? { kind: args.kind } : {}), ...(args.language ? { language: args.language } : {}) }) });
  }
});

export const installDownloadTool = defineTool({
  name: 'elabora_download_install',
  description: 'Downloads one now (checked, resumable): the tools that need it do it on first use too; call this first when a long call would time out. force: removes it first and downloads it again (a reinstall, refused as elabora_download_uninstall is).',
  inputSchema: objectSchema({ id: ID, force: { type: 'boolean' } }, ['id']),
  async handler(args) {
    try {
      return textResult({ ok: true, download: await installDownload(args.id, { force: !!args.force }) });
    } catch (error) { return failure(error); }
  }
});

export const uninstallDownloadTool = defineTool({
  name: 'elabora_download_uninstall',
  destructive: true,
  description: 'Removes one from this computer to free its space: only when the author asks. Refused (E_VOICE_IN_USE, E_ALIGN_IN_USE) while it is in use (lines said, words placed) or being downloaded, in any process. What modules already contain stays; the next use downloads it again.',
  inputSchema: objectSchema({ id: ID }, ['id']),
  async handler(args) {
    try {
      return textResult({ ok: true, ...(await uninstallDownload(args.id)) });
    } catch (error) { return failure(error); }
  }
});
