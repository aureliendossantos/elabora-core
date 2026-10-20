import { libraryRoot, listProjects, getProject, resolveProjectId } from '@elabora/node/library/index';
import { defineTool, objectSchema, textResult } from './tool.ts';

// The app's project library, read only: agents find a project's folder here, then work on its
// files. Creating, importing, replacing or trashing projects stays with people (the app, or the
// elabora command).

export const listLibraryProjects = defineTool({
  name: 'elabora_projects_list',
  readOnly: true,
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
  description: 'Folder of the Elabora app\'s library, or of one of its projects (id, or its first characters as elabora_projects_list shows them).',
  inputSchema: objectSchema({ id: { type: 'string' } }),
  handler(args) {
    if (args.id === undefined) return textResult({ library: libraryRoot() });
    const project = getProject(resolveProjectId(args.id));
    return textResult({ library: libraryRoot(), id: project.id, title: project.title, courseId: project.courseId, path: project.path });
  }
});
