// What the app's dialogue editor reads (D61: Script, Carte, Tableau, « Jouer un chemin »): the
// dialogue's data, its script, its map and its paths, from the project as the engine holds it.

import type { DialogueData } from '@elabora/player/dialogue/types';
import { findDialogue, projectDialogue, dialogueBlocks } from './project.ts';
import { dialogueScript, scriptWords } from './script.ts';
import type { DialogueScript } from './script.ts';
import { dialogueMap } from './layout.ts';
import type { DialogueMap } from './layout.ts';
import { dialoguePaths } from './play.ts';
import type { PathsReport } from './play.ts';
import type { Project } from '../project/model.ts';

export interface DialogueView {
  id: string;
  screen: string;
  data: DialogueData;
  script: DialogueScript;
  map: DialogueMap;
  paths: PathsReport;
}

export function dialogueView(project: Project, block: string): DialogueView | null {
  const ref = findDialogue(project, block);
  if (!ref) return null;
  const data = projectDialogue(project, ref);
  const words = scriptWords(project.course?.language);
  return { id: ref.id, screen: ref.screen, data, script: dialogueScript(data, { id: ref.id, screen: ref.screen, words }), map: dialogueMap(data, { words }), paths: dialoguePaths(project, ref) };
}

// The dialogue blocks of the course: where each one is.
export function dialogueList(project: Project): { id: string; screen: string; title: string }[] {
  return dialogueBlocks(project).map((ref) => ({ id: ref.id, screen: ref.screen, title: typeof ref.props.title === 'string' ? ref.props.title : ref.id }));
}
