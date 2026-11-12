import { binaryFile, makeFiles, type Files } from '@elabora/core/ops/index';

// A small course for the convergence bench (test/unit/sync-convergence.test.ts): text but a
// picture, three screens in two sections, blocks of several kinds, narration lines, pronunciations
// (an array without ids: a diff replaces it whole), a stylesheet. Validates with no error.

const screen = (id: string, title: string, blocks: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ $schema: 'https://elabora.studio/schemas/0.1.12/screen.schema.json', id, title, covers: ['ITEM-1'], blocks, ...extra }, null, 2) + '\n';

const text = (id: string, markdown: string) => ({ id, type: 'text', props: { markdown } });

export function benchCourse(): Files {
  return makeFiles({
    'course.json': JSON.stringify({
      $schema: 'https://elabora.studio/schemas/0.1.12/course.schema.json',
      format: 'elabora/0.1',
      id: 'sync-bench',
      title: 'Sync bench',
      language: 'en',
      version: '0.1.0',
      sections: [
        { id: 'first', title: 'First', screens: ['one', 'two'] },
        { id: 'second', title: 'Second', screens: ['three'] }
      ],
      variables: [],
      theme: { cascade: 'components-over-theme' },
      navigation: { mode: 'free' },
      completion: { reportAs: 'completed-incomplete' },
      pronunciations: { en: [{ text: 'SQL', say: 'sequel' }, { text: 'GUI', say: 'gooey' }] }
    }, null, 2) + '\n',
    'screens/one.json': screen('one', 'One', [
      text('one-intro', 'Intro of one.'),
      { id: 'one-heading', type: 'heading', props: { text: 'A heading' } },
      text('one-body', 'Body of one.'),
      { id: 'one-picture', type: 'image', props: { asset: 'pic.png', alt: 'A picture' } }
    ], { narration: { lines: [{ id: 'l1', text: 'First line.' }, { id: 'l2', text: 'Second line.' }] } }),
    'screens/two.json': screen('two', 'Two', [text('two-intro', 'Intro of two.'), text('two-body', 'Body of two.')]),
    'screens/three.json': screen('three', 'Three', [text('three-intro', 'Intro of three.')]),
    'plan.json': JSON.stringify({
      $schema: 'https://elabora.studio/schemas/0.1.12/plan.schema.json',
      id: 'PLAN-SYNC-BENCH', title: 'Sync bench', businessGoal: '', audience: { role: '', priorKnowledge: 'low' }, sources: [],
      objectives: [{ id: 'OBJ-1', statement: 'Converge.' }],
      items: [{ id: 'ITEM-1', kind: 'intro', title: 'Intro', objectives: ['OBJ-1'] }],
      spacing: [], waivers: []
    }, null, 2) + '\n',
    'theme/theme.css': '.t-text { color: #222; }\n',
    'assets/pic.png': binaryFile('sha256:' + '0'.repeat(64), 68)
  });
}
