import path from 'node:path';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { exportDialogue } from '@elabora/node/dialogue-export';
import { setDialogueNode, removeDialogueNode } from '@elabora/node/edit';
import { findDialogue, dialogueBlocks, projectDialogue } from '@elabora/core/dialogue/project';
import { dialogueScript, formatScript } from '@elabora/core/dialogue/script';
import { playDialogue, formatPlay, dialoguePaths, formatPaths } from '@elabora/core/dialogue/play';
import type { Project } from '@elabora/core/project/model';
import { defineTool, editResult, errorResult, objectSchema, SLUG, textResult } from './tool.ts';

// Dialogues (docs/decisions.md D61): read as a script, played and listed by the player's own walk,
// exported for the client; one node written whole. The dialogue is a block: elabora_add_block and
// elabora_update_block write it too.

const BLOCK = { ...SLUG, description: 'A dialogue block (its id).' } as const;

function located(root: string, block: string): { project: Project; ref: NonNullable<ReturnType<typeof findDialogue>> } | { error: string } {
  const project = loadProjectFromDir(root);
  const ref = findDialogue(project, block);
  return ref ? { project, ref } : { error: `No dialogue block "${block}" (dialogues: ${dialogueBlocks(project).map((other) => other.id).join(', ') || 'none'}).` };
}

export const showDialogueTool = defineTool({
  name: 'elabora_dialogue_show',
  readOnly: true,
  description: 'A dialogue block as a script, to reread what was written: each node with its lines (speaker, stage direction, line, cues), its options with quality, points, effects and where each goes (« then … »), their reply and feedback, then the endings. text is stable (it also serves diffs); script holds the same as data.',
  inputSchema: objectSchema({ block: BLOCK }, ['block']),
  handler(args, { root }) {
    const found = located(root, args.block);
    if ('error' in found) return errorResult(found);
    const script = dialogueScript(projectDialogue(found.project, found.ref), { id: found.ref.id, screen: found.ref.screen });
    return textResult({ text: formatScript(script), script });
  }
});

export const playDialogueTool = defineTool({
  name: 'elabora_dialogue_play',
  readOnly: true,
  description: '« Jouer un chemin » without a preview: the path of these choices (option ids, one for each decision met, a retried option and the next one included) as the player plays it: its lines and notes, the ending, the score (0-100), points, the decisions and the duration (the lines\' audio, else estimated). ok false when a choice is not offered (offered lists those that were). Check the best path and each mistake after writing a dialogue.',
  inputSchema: objectSchema({ block: BLOCK, choose: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9]{1,8}$' }, description: 'Option ids in order (default: none, the dialogue up to its first decision).' } }, ['block']),
  handler(args, { root }) {
    const found = located(root, args.block);
    if ('error' in found) return errorResult(found);
    const report = playDialogue(found.project, found.ref, args.choose ?? []);
    return textResult({ ...report, text: formatPlay(report) });
  }
});

export const dialoguePathsTool = defineTool({
  name: 'elabora_dialogue_paths',
  readOnly: true,
  description: 'Every path of a dialogue block: how many, best and worst score and points, endings reached and never reached, nodes never reached, and each path with its choices, ending, score and duration (2000 at most; complete false past it). Run it after writing or changing a dialogue: an ending or node never reached, or a best score under 100, says what to fix.',
  inputSchema: objectSchema({ block: BLOCK, limit: { type: 'integer', minimum: 1, maximum: 10000, description: 'Paths at most (default 2000).' } }, ['block']),
  handler(args, { root }) {
    const found = located(root, args.block);
    if ('error' in found) return errorResult(found);
    const report = dialoguePaths(found.project, found.ref, args.limit ? { limit: args.limit } : {});
    return textResult({ ...report, text: formatPaths(report) });
  }
});

export const exportDialogueTool = defineTool({
  name: 'elabora_dialogue_export',
  description: 'Write a dialogue block for the client to dist/<course>-<block>.<to>: its map (every node and ending, placed by Elabora), then its script (who says what, each option with its quality, where it goes and its note), in the course\'s language; html (one page) or pdf (needs a Chromium: Elabora\'s or Google Chrome). For when the author asks to send a dialogue for validation; the client also plays it in the Revue.',
  inputSchema: objectSchema({ block: BLOCK, to: { enum: ['html', 'pdf'], description: 'html or pdf.' } }, ['block', 'to']),
  async handler(args, { root }) {
    try {
      const result = await exportDialogue(root, { block: args.block, to: args.to });
      return textResult({ ok: true, ...result, file: path.relative(root, result.file) || result.file });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }
});

export const setDialogueNodeTool = defineTool({
  name: 'elabora_set_dialogue_node',
  description: 'Write one node of a dialogue block whole, in one undoable change: a new node (after: a node id, first: at the start; default: at the end), or the node with the same id replaced in place (moved with after or first). A node: { "id", "title"?, "lines": [{ "id", "speaker"?, "text", "expression"?, "cues"? }], "prompt"?, "options": [{ "id", "text", "label"?, "quality", "reply"?, "feedback"?, "points"?, "next"?, "retry"?, … }], "next"?, "end"? } (elabora_get_schema dialogue). To add an option or a line, write its node again with it. The findings say what is left to fix (a next to a node that does not exist).',
  inputSchema: objectSchema({ block: BLOCK, node: { type: 'object', description: 'The node, with its id.' }, after: { ...SLUG, description: 'Add (or move) it after this node.' }, first: { type: 'boolean', description: 'Add (or move) it first.' } }, ['block', 'node']),
  handler: (args, { root, author }) => editResult(setDialogueNode(root, args, { author }))
});

export const removeDialogueNodeTool = defineTool({
  name: 'elabora_remove_dialogue_node',
  destructive: true,
  description: 'Remove one node of a dialogue block, in one undoable change. What went to it (a next, an option\'s next, a start) is left for you to fix: the findings name it (E_DIALOGUE_TARGET).',
  inputSchema: objectSchema({ block: BLOCK, node: { ...SLUG, description: 'The node\'s id.' } }, ['block', 'node']),
  handler: (args, { root, author }) => editResult(removeDialogueNode(root, args, { author }))
});
