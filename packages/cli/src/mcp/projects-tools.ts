import path from 'node:path';
import { libraryRoot, listProjects, getProject, resolveProjectId, createModule, duplicateProject } from '@elabora/node/library/index';
import type { LibraryProject } from '@elabora/node/library/index';
import { listModuleTemplates } from '@elabora/node/module-templates';
import { LANGUAGE, SLUG, defineTool, errorResult, objectSchema, textResult } from './tool.ts';
import type { ToolContext } from './tool.ts';

// The app's project library: agents find a project's folder here, and start one (a new module, a copy,
// an import), which the author finds in « Mes modules ». Starting one needs no approval: it only adds
// to the library, and the trash takes it back. Replacing and trashing projects stay with people (the
// app, or the elabora command).

export const listLibraryProjects = defineTool({
  name: 'elabora_projects_list',
  readOnly: true,
  anywhere: true,
  description: 'Projects of the Elabora app\'s library, newest first: id, title, course id, language, last change, size, cached validation summary, any error, and the folder to work in.',
  inputSchema: objectSchema({ courseId: { type: 'string', description: 'Only the projects of this course id.' } }),
  handler(args) {
    const projects = listProjects().filter((project) => args.courseId === undefined || project.courseId === args.courseId);
    return textResult({
      library: libraryRoot(),
      projects: projects.map(({ id, title, courseId, language, modifiedAt, size, validation, error, path }) => ({ id, title, courseId, language, modifiedAt, size, validation, error, path }))
    });
  }
});

export const projectPath = defineTool({
  name: 'elabora_projects_path',
  readOnly: true,
  anywhere: true,
  description: 'Folder of the Elabora app\'s library, or of one of its projects (its id; a UUID\'s first characters, or the six letters that end an « elabora-module-… » id).',
  inputSchema: objectSchema({ id: { type: 'string' } }),
  handler(args) {
    if (args.id === undefined) return textResult({ library: libraryRoot() });
    const project = getProject(resolveProjectId(args.id));
    return textResult({ library: libraryRoot(), id: project.id, title: project.title, courseId: project.courseId, path: project.path });
  }
});

export const templatesTool = defineTool({
  name: 'elabora_templates',
  readOnly: true,
  anywhere: true,
  description: 'The module templates a new module can start from (elabora_projects_create template): a charter (theme, fonts, an animated backdrop) and placeholder screens. Name and summary in the app\'s languages: offer them to the author by name, as the app\'s home does.',
  inputSchema: objectSchema({}),
  handler() {
    return textResult(listModuleTemplates().map(({ id, name, summary, audiences, language, translations }) => ({ id, name, summary, audiences, languages: [language, ...translations] })));
  }
});

// A project just added to the library, and how to go on with it: by the name this server serves it
// under when it does (a server started with no folder reads the library again), else by its folder.
function started(project: LibraryProject, context: ToolContext, more: Record<string, unknown> = {}) {
  const course = context.courseName?.(project.path) ?? null;
  return {
    ok: true, course, folder: project.path, id: project.id, courseId: project.courseId, title: project.title, language: project.language, ...more,
    next: course
      ? `Pass course "${course}" to the course tools. Read its AGENTS.md (elabora://course/${course}/AGENTS.md) and the elabora-course-authoring skill first.`
      : `This connection does not serve it. Started with no folder (Elabora's extension for Claude), the server serves every module of the library; with a shell, elabora tools call <tool> "${project.path}" --args '<json>'.`
  };
}

export const createProjectTool = defineTool({
  name: 'elabora_projects_create',
  anywhere: true,
  description: 'Create a module in the Elabora app\'s library, blank, from a module template (elabora_templates), or blank in the charter of another module (charter: its theme, fonts, components, backdrop and player bars, copied; one screen to start from), and return the name to pass as course and its folder; the author finds it in « Mes modules ». No approval needed: the trash takes it back. For a module on a subject, follow the elabora-course-authoring skill next: write the whole draft plan (elabora_write_plan), then build all its screens in one go, without waiting for the plan\'s validation.',
  inputSchema: objectSchema({
    title: { type: 'string', minLength: 1, description: 'The module\'s title, in its language.' },
    courseId: { ...SLUG, description: 'Its course id (an LMS tells courses by it). Default: the title\'s, numbered when the library has it.' },
    language: { ...LANGUAGE, description: 'The language of its texts, a BCP 47 tag: the author\'s, the one you talk with them in. Default: the app\'s (French or English).' },
    template: { type: 'string', description: 'A module template\'s id (elabora_templates). Default: a blank module.' },
    charter: { type: 'string', description: 'Another module whose charter the new one takes, when the author wants the same look: its project id (elabora_projects_list) or its folder. Not with template.' },
    request: { type: 'string', description: 'What the author asked for, in their words: kept in the module\'s notes for agents (its AGENTS.md), and the label of your work on it in its history.' }
  }, ['title']),
  async handler(args, context) {
    if (args.template && args.charter) return errorResult({ error: 'Give template or charter, not both: a template brings its screens, a charter only the look.' });
    const { project, template, charter, languageFrom } = await createModule({ ...args, author: context.author });
    return textResult(started(project, context, { template: template?.id ?? null, ...(charter ? { charter: charter.title ?? charter.dir } : {}), languageFrom }));
  }
});

export const duplicateProjectTool = defineTool({
  name: 'elabora_projects_duplicate',
  anywhere: true,
  description: 'Copy a project of the library under a new project id (elabora_projects_list), with the same course id; its history stays with the original. Returns the name to pass as course and its folder.',
  inputSchema: objectSchema({
    id: { type: 'string', description: 'The project\'s id, as elabora_projects_path takes it, or its folder (elabora_courses).' },
    title: { type: 'string', minLength: 1, description: 'The copy\'s title. Default: the same.' }
  }, ['id']),
  async handler(args, context) {
    // Its folder in the library is named by its project id.
    const id = path.isAbsolute(args.id) && path.dirname(path.resolve(args.id)) === path.resolve(libraryRoot()) ? path.basename(args.id) : args.id;
    const copy = await duplicateProject(resolveProjectId(id), { ...(args.title !== undefined ? { title: args.title } : {}), author: context.author });
    return textResult(started(copy, context));
  }
});

const CHOICE = <const Values extends readonly string[]>(values: Values, description: string) => ({ type: 'string', enum: values, description }) as const;

export const importProjectTool = defineTool({
  name: 'elabora_import',
  anywhere: true,
  description: 'Import a file of this computer into the library as a new module: an Elabora archive (.elabora) or course folder, or (beta) a Storyline project (.story), a course Storyline published (zip or folder) or a Rise 360 export. A Storyline or Rise module comes with import-report.json: every loss, and the choices the import made; another import with choices makes them otherwise, as a new module. An archive of a course the library holds already imports nothing until you say copy; replacing or trashing a module stays with the author.',
  inputSchema: objectSchema({
    file: { type: 'string', minLength: 1, description: 'The absolute path of the file or folder on this computer.' },
    copy: { type: 'boolean', description: 'An archive whose course the library holds already: import it as a new project beside it.' },
    title: { type: 'string', minLength: 1, description: 'Storyline or Rise: the module\'s title. Default: the source\'s.' },
    language: { ...LANGUAGE, description: 'Storyline or Rise: the language of its texts. Default: the source\'s.' },
    choices: {
      type: 'object', additionalProperties: false, description: 'Storyline or Rise: the choices of import-report.json made otherwise.',
      properties: {
        presentation: CHOICE(['slides', 'scroll'], 'Slides, or pages that scroll (Rise is always scroll).'),
        backgrounds: CHOICE(['drop', 'keep'], 'The source\'s background pictures.'),
        timing: CHOICE(['together', 'steps'], 'Timed elements: all at once, or step by step.'),
        fonts: CHOICE(['substitute', 'theme'], 'The source\'s fonts: the nearest vetted fonts, or the theme\'s.'),
        mediaAccessibility: CHOICE(['decorative', 'errors'], 'Media without alternatives: decorative, or errors to fix.')
      }
    }
  }, ['file']),
  async handler(args, context) {
    if (!path.isAbsolute(args.file)) return errorResult({ error: `${args.file} is not an absolute path: give the file's whole path on this computer.` });
    // Loaded when used: the importers would slow every server's start.
    const { importModule } = await import('@elabora/node/import/index');
    const { DECISION_CHOICE } = await import('@elabora/core/import/report');
    const { kind, result } = await importModule(args.file, {
      ...(args.copy ? { onExisting: 'copy' as const } : {}), ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.language !== undefined ? { language: args.language } : {}), ...(args.choices ? { choices: args.choices } : {}), author: context.author
    });
    if (result.status === 'exists') {
      return errorResult({
        error: `The library holds the course ${result.archive.courseId} already: nothing imported. Import it again with copy for a new project beside it; replacing one is the author's, in Elabora.`,
        existing: result.existing.map(({ id, title, modifiedAt, path }) => ({ id, title, modifiedAt, folder: path }))
      });
    }
    if ('report' in result) {
      const { report, validation, fonts } = result;
      return textResult(started(result.project!, context, {
        kind, beta: true, summary: report.summary, validation, fonts, losses: report.losses.length,
        decisions: report.decisions.map((decision) => ({ title: decision.title, applied: decision.applied, ...(DECISION_CHOICE[decision.id] && decision.choices.length > 1 ? { choice: DECISION_CHOICE[decision.id], choices: decision.choices.map((choice) => choice.id) } : {}) }))
      }));
    }
    return textResult(started(result.project, context, { kind, validation: result.validation }));
  }
});
