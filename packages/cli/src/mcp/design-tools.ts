import { loadProjectFromDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { fitSizes } from '../commands/build-and-test.ts';
import { defineTool, editResult, errorResult, imageResult, objectSchema, textResult, SLUG } from './tool.ts';
import { startLookServer } from '../look-server.ts';
import { styleConflictDiagnostics } from '@elabora/node/style-cascade';
import { withCourseLanguage } from '@elabora/node/translate';
import { LANGUAGE } from './tool.ts';

// Design: stylesheets and generators, and looking at the result (fit of slides, screenshots).

const SIZE = { type: 'string', pattern: '^[1-9][0-9]{2,3}x[1-9][0-9]{2,3}$' } as const;

export const checkFit = defineTool({
  name: 'elabora_check_fit',
  readOnly: true,
  description: 'Measure every screen with all its steps in a real browser at the fit sizes of the course (presentation.fit: reference 1600×900, minimum 1280×720 by default) and say which slides scroll, by how many px, which blocks end below the fold, and what moves once the activities are answered (layout shift), plus text too faint against what is behind it. In scroll presentation (pages of any length) nothing has to fit: it gives the length of each page and the contrast of its text, down the whole page. Seconds, not a full elabora test.',
  inputSchema: objectSchema({ reference: SIZE, minimum: SIZE, language: LANGUAGE, allowMissing: { type: 'boolean', description: 'With language: check the draft, leaving missing/stale texts in the source language.' } }),
  async handler(args, { root }) {
    const { measureFit, fitDiagnostics } = await import('@elabora/node/preview');
    return withCourseLanguage(root, args, async (dir) => {
      const result = await measureFit(dir, { sizes: fitSizes(args.reference, args.minimum) });
      if (!result.ok) return errorResult({ diagnostics: result.diagnostics?.filter((d) => d.severity === 'error') });
      return textResult({ ...result, ...(args.language ? { language: args.language } : {}), diagnostics: fitDiagnostics(result) });
    });
  }
});

export const look = defineTool({
  name: 'elabora_look',
  readOnly: true,
  description: 'See a screen while designing, in well under a second: a look server kept warm for the course (one browser, no build; started by the first look, stopped after 15 minutes without one) renders it from the files as they are, as learners will see it, with the player\'s header and footer and its free objects (3D included). Objects an edit did not touch keep running. Look after every visual change; keep elabora_check_fit, elabora_preview_screenshot, elabora_test_object and elabora_test_package as the final checks. Says whether a slide fits at this size, how long a page is, and where every block is. To inspect: scroll (the window at a position, or a sheet down the page), block (a close-up, scale 2), act (drive a free object from inside its frame), with what moves and what cannot finish. Also gives a page that follows the looks and the files, to open in a browser pane (in-app browsers included: its free objects show there).',
  inputSchema: objectSchema({ screen: { ...SLUG, description: 'Default: the screen of the last look, else the first screen.' }, width: { type: 'integer', minimum: 320, maximum: 2560, default: 1600 }, height: { type: 'integer', minimum: 320, maximum: 2000, default: 900 }, state: { enum: ['initial', 'answered'], default: 'initial' }, step: { type: 'integer', minimum: 1, maximum: 12, description: 'Reveal the steps of the screen up to this one (default: all).' }, layer: { ...SLUG, description: 'Open this layer of the screen (the window is captured).' }, at: { type: 'string', minLength: 1, maxLength: 120, description: 'A timed screen at a moment (the window is captured, with the bar): "l2" (a line starts, its caption shown), "l2:end", "l2:imprimante" (a word of it), "l2:imprimante+0.3s", "1.5s@2" (seconds into step 2, screens without narration), "step2:end", or "12.5" (seconds on the timeline).' }, sheet: { type: 'boolean', description: 'A contact sheet of a timed screen: one capture per mark of its timeline (its start, each block that comes or goes, each cue, each step\'s end), captioned with the anchor and what happens: review a narrated slide as a storyboard.' }, language: { ...LANGUAGE, description: 'A translation of the course (default: its language).' }, viewport: { type: 'boolean', description: 'Only the window (default: the whole page).' }, motion: { type: 'boolean', description: 'Animations on (default: reduced motion, transitions settled).' },
    scroll: { type: 'array', items: { type: 'string', pattern: '^([0-9]{1,6}(\\.[0-9]+)?%?|[a-z0-9][a-z0-9-]{0,63})$' }, minItems: 1, maxItems: 9, description: 'The window scrolled to a position, animations on: px ("1800"), a percentage of the page ("100%"), or a block\'s id (the block in view). Several positions (or sheet on a screen without a timeline, default 0/25/50/75/100%): a contact sheet down the page, to see scroll-driven animations build up.' },
    block: { ...SLUG, description: 'A close-up of this block (cropped to its box with a small margin; PNG by default up to 2 megapixels, else JPEG), scrolled into view unless scroll says where. With scroll, block or motion the note says what moves: visible/clipped/outside, the animations and transitions of each block in the window (or of this block), their timeline (time, scroll, view) and progress, and the scroll-driven ones that CANNOT FINISH because the page ends before their range.' },
    scale: { enum: [1, 2], description: 'The close-up drawn at twice its size (2) to read fine detail.' },
    act: { type: 'array', items: { type: 'string', minLength: 5, maxLength: 200 }, maxItems: 12, description: 'Drive the free object of block from inside its frame, in order, before the capture: "click:<text>" (a button, link, text or label named so), "click:role=<role>[name=<name>]", "key:<key>" (Enter, ArrowRight, a), "drag:x,y->x,y" (0 to 1 across the object). The note gives the object\'s state and the events it emitted; a missing target names what the frame offers. Explore with it; keep an interaction worth keeping in object.tests.json (elabora_test_object).' },
    type: { enum: ['jpeg', 'png'], description: 'Image format (default: JPEG; PNG for a close-up up to 2 megapixels).' } }),
  async handler(args, { root }) {
    const { lookThroughServer } = await import('@elabora/node/look-client');
    const { motionText } = await import('@elabora/node/motion-report');
    const { result, server } = await lookThroughServer(root, {
      screen: args.screen, width: args.width || 1600, height: args.height || 900, state: args.state, step: args.step, layer: args.layer, ...(args.at ? { at: args.at } : {}), ...(args.sheet ? { sheet: true } : {}), ...(args.language ? { language: args.language } : {}), full: !args.viewport, motion: args.motion,
      ...(args.scroll?.length ? { scroll: args.scroll } : {}), ...(args.block ? { block: args.block } : {}), ...(args.scale ? { scale: args.scale } : {}), ...(args.act?.length ? { act: args.act } : {}), ...(args.type ? { type: args.type } : {})
    }, { start: () => startLookServer(root) });
    if (!result.ok) return errorResult({ error: result.error });
    const motion = result.motion ? `\n${motionText(result.motion).join('\n')}` : '';
    const acted = result.act ? `\nAfter ${result.act.actions.join(', ')}: state ${JSON.stringify(result.act.state)}; ${result.act.events.length ? `events ${JSON.stringify(result.act.events)}` : 'no event'}.` : '';
    if (result.scrolled && result.scrolled.length > 1) return imageResult(result.image, `Contact sheet of ${result.screen}${args.block ? `, block ${args.block}` : ''} down the page (in ${(result.ms / 1000).toFixed(2)} s): ${result.scrolled.map((stop) => stop.label).join(' | ')}.${result.consoleErrors.length ? ` Console errors: ${result.consoleErrors.join(' | ')}` : ''}${motion}`, 'image/png');
    if (result.clip) return imageResult(result.image, `Close-up of ${args.block} on ${result.screen} at ${result.width}×${result.height}${result.scrolled ? `, scrolled to ${result.scrolled[0].label}` : ''}: ${result.clip.width}×${result.clip.height} px of the page at ${result.clip.x},${result.clip.y}, ×${result.clip.scale}, in ${(result.ms / 1000).toFixed(2)} s.${result.consoleErrors.length ? ` Console errors: ${result.consoleErrors.join(' | ')}` : ''}${acted}${motion}`, result.type === 'png' ? 'image/png' : 'image/jpeg');
    const room = result.presentation === 'slides' ? (result.page.overflow ? `the slide scrolls by ${result.page.overflow} px` : 'the slide fits') : `page of ${result.page.windows} window(s)`;
    const objects = result.objects.length ? ` Free objects: ${result.objects.map((object) => `${object.block} ${object.failed ? 'failed' : object.ready ? 'ready' : 'not ready'}`).join(', ')} (${result.started ? `${result.started} (re)started` : 'kept running'}).` : '';
    if (result.marks) return imageResult(result.image, `Contact sheet of ${result.screen}, ${result.marks.length} marks (in ${(result.ms / 1000).toFixed(2)} s):\n${result.marks.map((mark) => mark.label).join('\n')}${result.consoleErrors.length ? `\nConsole errors: ${result.consoleErrors.join(' | ')}` : ''}`, 'image/png');
    const styles = styleConflictDiagnostics([{ screen: result.screen, conflicts: result.styles ?? [] }]).map((finding) => ` ${finding.code}: ${finding.message}`).join('');
    const note = `Screen ${result.screen} at ${result.width}×${result.height}${result.state === 'answered' ? ', answered' : ''}${result.step ? `, step ${result.step}` : ''}${result.layer ? `, layer ${result.layer}` : ''}: ${room}, in ${(result.ms / 1000).toFixed(2)} s.${objects}${result.consoleErrors.length ? ` Console errors: ${result.consoleErrors.join(' | ')}` : ' No console errors.'}${styles} Blocks (px of the page): ${JSON.stringify(result.blocks.filter((block) => !block.hidden).map((block) => ({ id: block.id, ...block.rect })))}.${result.scrolled ? ` Scrolled to ${result.scrolled[0].label}.` : ''}${motion} Live page for a browser pane: ${server.url}`;
    return imageResult(result.image, note, result.type === 'png' ? 'image/png' : 'image/jpeg');
  }
});

export const previewScreenshot = defineTool({
  name: 'elabora_preview_screenshot',
  readOnly: true,
  description: 'Render one screen (or one of its layers) in a real browser once images and free objects are ready, and return a PNG with console errors. Check every designed screen at the reference size (1600×900), at 1280×720 and at 375 px wide: text follows the size classes (1rem is 16, 14 and 15 px). state "answered" shows every activity with its tallest feedback. at: a filmstrip of the animations (contact sheet of frames at these times). scroll: a filmstrip down the page (scroll presentation: scroll-driven animations and objects that follow the scroll), at px or percentages of the page.',
  inputSchema: objectSchema({ language: LANGUAGE, allowMissing: { type: 'boolean', description: 'With language: capture the draft, leaving missing/stale texts in the source language.' }, screen: SLUG, width: { type: 'integer', minimum: 320, maximum: 2560, default: 1600 }, height: { type: 'integer', minimum: 400, maximum: 2000, default: 900 }, layer: { ...SLUG, description: 'Open this layer of the screen before the capture.' }, step: { type: 'integer', minimum: 1, maximum: 12, description: 'Reveal the steps of the screen up to this one (default: all).' }, state: { enum: ['initial', 'answered'], default: 'initial' }, at: { type: 'array', items: { anyOf: [{ type: 'integer', minimum: 0, maximum: 60000 }, { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}(:(start|end))?$' }] }, maxItems: 9, description: 'Filmstrip: frames at these times in ms, animations on; or, on a narrated screen, as each of these lines starts ("l2") or ends ("l2:end"), its caption shown.' }, scroll: { type: 'array', items: { type: 'string', pattern: '^[0-9]{1,6}(\\.[0-9]+)?%?$' }, maxItems: 9, description: 'Filmstrip down the page: the window scrolled to each position, in px ("1800") or a percentage of the page ("40%"), animations on.' }, motion: { type: 'boolean', description: 'Animations on (default: reduced motion, transitions settled).' } }),
  async handler(args, { root }) {
    const { screenshot } = await import('@elabora/node/preview');
    return withCourseLanguage(root, args, async (dir) => {
      const shot = await screenshot(dir, { screen: args.screen, width: args.width || 1600, height: args.height || 900, layer: args.layer, fullPage: !args.layer, step: args.step, state: args.state, at: args.at as (number | string)[] | undefined, scroll: args.scroll, motion: args.motion });
      if (!shot.ok) return errorResult({ error: shot.error, diagnostics: shot.diagnostics?.filter((d) => d.severity === 'error') });
      const note = `Screen ${shot.screen}${shot.answered ? `, answered (${shot.answered.join(', ') || 'no activity'})` : ''}${shot.scroll ? `, filmstrip down the page at ${shot.scroll.join(', ')} px` : shot.frames ? `, filmstrip at ${shot.frames.map((frame) => frame.label ?? `${frame.ms} ms`).join(', ')}` : ''}.`;
      return imageResult(shot.png, `${note}${shot.consoleErrors.length ? ` Console errors: ${shot.consoleErrors.join(' | ')}` : ' No console errors.'}`);
    });
  }
});

export const writeDesignFile = defineTool({
  name: 'elabora_write_design_file',
  description: 'Write a design file: theme/<name>.css (course stylesheet) or generators/<name>.mjs (asset generator). Design is free; content stays in blocks. Read the design layer first (elabora_docs design; skill elabora-visual-design).',
  inputSchema: objectSchema({ file: { type: 'string' }, content: { type: 'string' } }, ['file', 'content']),
  handler: (args, { root, author }) => editResult(edit.writeDesignFile(root, args, { author }))
});

export const buildAssets = defineTool({
  name: 'elabora_build_assets',
  description: 'Run the asset generators (generators/*.mjs) and record their provenance: figures are regenerated from code, theme tokens and plan. Run it after changing a generator or a token. sheet: also return a contact sheet of what they wrote, on the course\'s surface colour.',
  inputSchema: objectSchema({ only: { type: 'string', description: 'Only generators whose file name contains this text.' }, sheet: { type: 'boolean', description: 'Return a contact sheet (PNG) of the assets written.' } }),
  async handler(args, { root }) {
    const { runGenerators } = await import('@elabora/node/generators');
    const project = loadProjectFromDir(root);
    const { results } = await runGenerators(root, { course: project.course, plan: project.plan, only: args.only });
    const ok = !results.some((run) => run.error);
    if (!args.sheet) return textResult({ ok, results });
    const { assetsSheet } = await import('@elabora/node/preview');
    const surface = project.course?.theme?.tokens?.['color.surface'];
    const groups = results.flatMap((run) => (run.error === undefined ? [{ generator: run.generator, description: run.description ?? undefined, outputs: run.outputs }] : []));
    const png = await assetsSheet(root, groups, { surface: typeof surface === 'string' ? surface : undefined });
    return imageResult(png, results.map((run) => (run.error !== undefined ? `✘ ${run.generator}: ${run.error}` : `✔ ${run.generator}: ${run.outputs.length} asset(s)`)).join('\n'));
  }
});

export const upgradeTheme = defineTool({
  name: 'elabora_upgrade_theme',
  description: 'Put the theme\'s rules under the components (course.json theme.cascade components-over-theme, docs D32) without changing how the course looks: a course without theme.cascade (I_THEME_CASCADE_OLD) still has its theme after the component stylesheets, so a general theme rule (.t-figure img { width: 100% }) silently overrides a component\'s own rule. The theme\'s declarations of properties the components also set go into a top-level @layer overrides { … } block of the theme stylesheet (which stays over the components); the rest become the course\'s defaults, under them. Then move out of that block the rules that are course-wide defaults, and look again (elabora_look, elabora_check_fit name what the theme still overrides: W_STYLE_COMPONENT_OVERRIDDEN). One change; elabora_undo reverts it.',
  inputSchema: objectSchema({}),
  handler: (_args, { root, author }) => editResult(edit.upgradeThemeCascade(root, { author }))
});
