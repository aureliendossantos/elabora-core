// The agent operations shared by MCP, shell callers and embedded integrations.
// Keep domain logic in @elabora/core and @elabora/node; adapters only carry inputs and results.
import fs from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EditError } from '@elabora/node/edit';
import { errorDiagnostics, errorMessage } from './commands/command.ts';
import { errorResult } from './mcp/tool.ts';
import type { Tool, ToolContext } from './mcp/tool.ts';
import * as course from './mcp/course-tools.ts';
import * as content from './mcp/content-tools.ts';
import * as components from './mcp/component-tools.ts';
import * as objects from './mcp/object-tools.ts';
import * as design from './mcp/design-tools.ts';
import * as fonts from './mcp/font-tools.ts';
import * as packages from './mcp/build-tools.ts';
import * as library from './mcp/projects-tools.ts';
import * as media from './mcp/media-tools.ts';
import * as narration from './mcp/narration-tools.ts';
import * as voice from './mcp/voice-tools.ts';
import * as downloads from './mcp/download-tools.ts';
import * as cloud from './mcp/cloud-tools.ts';
import * as sources from './mcp/source-tools.ts';
import * as player from './mcp/player-tools.ts';
import { agentGuideTool } from './mcp/guide-tool.ts';
import { docsTool } from './mcp/docs-tool.ts';

// The tools in the order agents see them: reading first, then writing.
export const TOOLS: readonly Tool[] = [
  course.overview, agentGuideTool, docsTool, sources.listSourcesTool, sources.readSourceTool, course.getPlan, course.planDiffTool, course.getScreen, content.findTextTool, content.translationTableTool, content.translationStatusTool, components.listComponents, course.getSchema, components.getComponent, course.validate,
  objects.getObject, packages.listProfiles, fonts.listFonts, design.look, design.checkFit, design.previewScreenshot, objects.replayObject, course.history, library.listLibraryProjects, library.projectPath, media.mediaStatus, narration.timeline, voice.listVoicesTool, downloads.listDownloadsTool, voice.voiceTakesTool, voice.searchVoicesTool, voice.estimateVoiceTool, voice.voiceAccountTool, cloud.listReviewsTool, cloud.reviewCommentsTool,
  content.createScreen, content.updateScreen, content.deleteScreen, content.moveScreen, content.duplicateScreen,
  content.addBlock, content.updateBlock, content.removeBlock, content.moveBlock, content.duplicateBlock, content.detachBlock,
  content.upsertLayer, content.removeLayer, content.upsertEvent, content.removeEvent, content.upsertVariable, content.renameVariable, content.removeVariable,
  content.replaceTextTool, content.translateTextTool, content.updateCourse, course.ignoreFinding, content.rename, sources.addSourcesTool, media.importMediaTool, media.setCaptions, narration.importNarrationTool, narration.lineFromAudioTool, narration.textFromAudioTool, narration.transcribeTool, narration.alignNarrationTool, narration.setTiming, voice.setVoiceTool, voice.generateVoiceTool, voice.installVoiceTool, downloads.installDownloadTool, downloads.uninstallDownloadTool,
  objects.createObject, objects.writeObjectFile, objects.testObject, course.writePlan, course.setPlanVoiceover, course.exportPlanDocumentTool,
  packages.build, packages.testPackage, design.writeDesignFile, design.upgradeTheme, player.playerTool, fonts.addFont,
  components.createComponent, components.forkComponent, components.writeComponentFile, components.migrateComponents,
  components.addLibraryComponent, components.publishComponent, components.previewComponent, design.buildAssets, course.undo
];

export interface ToolOptions {
  readOnly?: boolean;
  // An explicit host allowlist, shared by discovery and invocation. Undefined exposes all tools;
  // [] exposes none. This is capability selection, not a filesystem or process sandbox.
  tools?: readonly string[];
}

export function agentTools({ readOnly = false, tools }: ToolOptions = {}): readonly Tool[] {
  const selected = tools === undefined ? null : new Set(tools);
  const known = new Set(TOOLS.map((tool) => tool.name));
  const unknown = tools?.filter((name) => !known.has(name));
  if (unknown?.length) throw new Error(`Unknown agent tools: ${unknown.join(', ')}`);
  return TOOLS.filter((tool) => (!readOnly || tool.readOnly) && (!selected || selected.has(tool.name)));
}

export function listAgentTools(options: ToolOptions = {}) {
  return agentTools(options).map((tool) => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, idempotentHint: tool.readOnly, openWorldHint: tool.openWorld }
  }));
}

// Both transports use exactly this validation, dispatch and error conversion. The caller supplies
// the author; MCP uses its client's name, the CLI the normal CLI author detection.
export async function callAgentTool(name: string, args: unknown, context: ToolContext, options: ToolOptions = {}): Promise<CallToolResult> {
  const tool = agentTools(options).find((candidate) => candidate.name === name);
  if (!tool) return errorResult({ error: `Unknown tool ${name}` });
  const root = path.resolve(context.root);
  if (!fs.existsSync(path.join(root, 'course.json'))) return errorResult({ error: `${root} is not an Elabora course (no course.json)` });
  try {
    return await tool.call(args, { ...context, root });
  } catch (error) {
    if (error instanceof EditError) return errorResult({ error: error.message, diagnostics: errorDiagnostics(error) });
    return errorResult({ error: errorMessage(error) });
  }
}
