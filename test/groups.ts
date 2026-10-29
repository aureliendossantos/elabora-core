// The core's map for pnpm run test:affected (scripts/affected.ts): which e2e and matrix files cover
// which sources. Written and read by hand: a file no group names widens the selection, and the test
// of this map (test/unit/test-groups.test.ts) says when a file of test/e2e or test/matrix is in no
// group. The unit suite and the typecheck always run; the whole e2e and matrix run on main once per
// batch.
import type { TestMap } from '../scripts/affected.ts';

const e2e = (name: string) => `e2e/${name}`;
const matrix = (name: string) => `matrix/${name}`;

export const groups: TestMap = {
  smoke: [e2e('player'), e2e('lms')],
  // What every course goes through: the player's frame and layout, the compiler, the format and its
  // schemas, the build, the engine's protocol.
  wide: [
    'packages/player/src/player.ts', 'packages/player/src/player.css', 'packages/player/src/index.ts', 'packages/player/src/dom.ts',
    'packages/player/src/course-data.ts', 'packages/player/src/course-state.ts', 'packages/player/src/screen-*.ts', 'packages/player/src/chrome.ts',
    'packages/player/src/tokens.ts', 'packages/player/src/layout-report.ts', 'packages/player/src/resources.ts', 'packages/player/src/state-codec.ts',
    'packages/core/src/compile/**', 'packages/core/src/format/**', 'packages/core/src/project/**', 'packages/core/src/validate/**', 'packages/core/src/util/**', 'packages/core/src/index.ts',
    'packages/format/**', 'packages/node/src/build.ts', 'packages/node/src/build-types.ts', 'packages/node/src/bundles.ts', 'packages/node/src/util/**',
    'packages/node/src/project-*.ts', 'packages/node/src/index.ts', 'packages/engine/**',
    'packages/core/src/player/**', 'packages/core/src/diagnostics/**', 'packages/*/package.json', 'packages/*/tsconfig.json', 'test/fixtures/format-0.1/**',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig*.json', '.gitattributes', '.gitignore', 'test/helpers.ts', 'test/isolate.ts'
  ],
  wideChecks: [e2e('player'), e2e('lms'), e2e('starter-blocks'), e2e('activities'), e2e('narration'), e2e('canvas'), e2e('design'), e2e('primitives'), matrix('lms-matrix'), matrix('templates')],
  none: ['docs/**', '*.md', '.sampo/**', '.agents/**', '.github/**', 'ai-costs/**', 'LICENSE', 'NOTICE', 'test/unit/**', 'test/bench/**', 'test/groups.ts', 'scripts/affected.ts', 'scripts/test-affected.ts', 'scripts/release.ts', 'scripts/costs-record.ts', 'scripts/gen-ai-costs.ts', 'scripts/gen-docs.ts', 'scripts/gen-agent-rules.ts', 'bin/**'],
  testOf: (file) => /^test\/(e2e|matrix)\/([\w-]+)\.test\.ts$/.exec(file)?.slice(1, 3).join('/') ?? null,
  groups: [
    { name: 'activities', files: ['packages/player/src/activit*.ts', 'packages/player/src/fill-in.ts', 'packages/player/src/sort.ts', 'packages/player/src/numeric.ts', 'packages/core/src/components/**', 'test/activities-fixture.ts'], checks: [e2e('activities'), e2e('starter-interactions'), e2e('lms')] },
    { name: 'starter blocks', files: ['packages/core/src/components/**', 'packages/core/src/render/**', 'test/fixtures/primitives/**', 'packages/player/src/primitives.ts', 'packages/player/src/display.ts', 'packages/player/src/labels.ts', 'packages/player/src/icons.ts', 'packages/player/src/tooltip.ts', 'test/starter-interactions-fixture.ts'], checks: [e2e('starter-blocks'), e2e('starter-interactions'), e2e('panels'), e2e('primitives'), e2e('design'), matrix('coffee')] },
    { name: 'player items', files: ['packages/player/src/about.ts', 'packages/player/src/glossary.ts', 'packages/player/src/transcript.ts', 'packages/player/src/sheet.ts', 'packages/player/src/message.ts', 'packages/player/src/json.ts', 'packages/player/src/data-schema.ts', 'packages/player/src/behaviors.ts'], checks: [e2e('player-items'), e2e('player')] },
    { name: 'canvas', files: ['packages/player/src/canvas*.ts', 'packages/node/src/canvas/**', 'packages/node/src/preview.ts', 'packages/core/src/commands/**', 'packages/core/src/ops/**', 'packages/node/src/edit/**', 'packages/node/src/store/**', 'packages/node/src/journal/**'], checks: [e2e('canvas'), e2e('canvas-live'), e2e('engine-canvas'), e2e('preview-inspection')] },
    { name: 'objects', files: ['packages/player/src/object-*.ts', 'packages/node/src/objects/**', 'packages/node/templates/object*/**', 'packages/node/vendor/**', 'test/fixtures/continuity/**', 'packages/node/src/replay.ts', 'packages/node/src/motion-report.ts'], checks: [e2e('object'), e2e('continuity'), e2e('edge')] },
    { name: 'continuity', files: ['packages/player/src/frames.ts', 'packages/player/src/dry-frames.ts'], checks: [e2e('continuity'), e2e('player')] },
    { name: 'characters and dialogues', files: ['packages/player/src/character/**', 'packages/player/src/dialogue/**', 'packages/core/src/dialogue/**', 'packages/node/src/dialogue-export*.ts', 'test/dialogue-fixture.ts', 'test/fixtures/dialogues/**', 'test/fixtures/characters/**'], checks: [e2e('character'), e2e('dialogues')] },
    { name: 'charts', files: ['packages/player/src/charts/**', 'packages/core/src/charts/**'], checks: [e2e('charts')] },
    { name: 'timeline and narration', files: ['packages/player/src/timeline.ts', 'packages/player/src/timed-blocks.ts', 'packages/player/src/speech.ts', 'packages/core/src/narration/**', 'packages/node/src/narration/**', 'packages/node/src/voice/**', 'packages/node/src/align/**', 'packages/node/src/transcribe/**', 'packages/node/src/models/**', 'packages/node/voices/**', 'test/narration.ts', 'test/fixtures/align-*.ts'], checks: [e2e('timeline'), e2e('narration'), e2e('layer-timeline')] },
    { name: 'sounds', files: ['packages/player/src/sound*.ts', 'packages/player/src/interface-sounds/**', 'packages/core/src/sounds/**', 'packages/node/src/sounds/**', 'packages/node/sounds/**', 'scripts/sounds.ts'], checks: [e2e('sounds')] },
    { name: 'media', files: ['packages/core/src/media/**', 'packages/node/src/media/**', 'packages/node/src/blobs.ts', 'packages/node/src/file-hash.ts', 'packages/node/src/assets-sheet.ts'], checks: [e2e('media')] },
    { name: 'fonts', files: ['packages/fonts/**', 'packages/node/src/fonts/**', 'scripts/fonts.ts'], checks: [e2e('fonts')] },
    { name: 'LMS and packages', files: ['packages/core/profiles/**', 'packages/node/emulator-harness/**', 'packages/player/src/scorm12.ts', 'packages/core/src/lms/**', 'packages/core/src/interop/**', 'packages/node/src/emulator/**', 'packages/node/src/packaging/**', 'packages/node/src/package-folder.ts', 'packages/node/src/zip.ts'], checks: [e2e('lms'), e2e('edge'), e2e('capture-width'), matrix('lms-matrix')] },
    { name: 'web and review', files: ['packages/player/src/web.ts', 'packages/player/src/review*.ts', 'packages/core/src/web-globals.d.ts', 'packages/node/src/cloud/**', 'packages/node/src/http/**'], checks: [e2e('web'), e2e('review')] },
    { name: 'look and fit', files: ['packages/node/src/look*.ts', 'packages/node/src/fit*.ts', 'packages/node/src/contrast.ts', 'packages/node/src/capture.ts', 'packages/node/src/scroll-strip.ts', 'packages/node/src/style-cascade.ts', 'packages/cli/src/look-server.ts'], checks: [e2e('look'), e2e('design'), e2e('capture-width'), e2e('starter-blocks')] },
    { name: 'plan document', files: ['packages/core/src/plan-document/**', 'packages/node/src/plan-document*.ts'], checks: [e2e('plan-document')] },
    { name: 'agents', files: ['packages/cli/**', 'packages/node/src/agent-rules.ts', 'packages/node/src/generators.ts', 'packages/node/src/scaffold.ts', 'packages/node/src/translate.ts', 'packages/core/src/ai/**', 'packages/core/src/i18n/**', 'packages/node/templates/course/**', 'packages/node/templates/agents-revisions.json', 'test/fixtures/cli-help.txt', 'test/fixtures/mcp-tools.json', 'test/fixtures/command-unsettled.ts', 'scripts/gen-builtin-templates.ts'], checks: [e2e('agent-workflow')] },
    { name: 'imports and sources', files: ['packages/core/src/import/**', 'packages/node/src/import/**', 'packages/node/src/sources/**', 'packages/node/src/lesson-md.ts', 'packages/node/src/library/**', 'packages/node/src/backups/**', 'packages/node/src/downloads/**', 'packages/node/src/module-templates.ts', 'packages/node/src/component-migrations.ts', 'packages/node/src/code-version.ts', 'packages/node/src/data-dir.ts', 'packages/node/src/state-lock.ts', 'packages/core/src/update-impact.ts', 'scripts/make-*.ts', 'scripts/source-fixtures.ts', 'test/sources-fixtures.ts', 'test/fixtures/sources/**', 'test/mutations.ts', 'test/cloud-fake.ts'], checks: [e2e('player')] },
    { name: 'three.js and generators', files: ['scripts/vendor-three.ts', 'scripts/gen-format.ts', 'scripts/pocket-voices.ts', 'scripts/heavy-slots.ts'], checks: [e2e('object')] },
    { name: 'templates', files: ['templates/**'], checks: [matrix('templates')] },
    { name: 'coffee-in-brief', files: ['examples/coffee-in-brief/**'], checks: [matrix('coffee')] },
    { name: 'medieval-charts', files: ['examples/medieval-charts/**'], checks: [matrix('medieval')] },
    { name: 'phishing-by-numbers', files: ['examples/phishing-by-numbers/**'], checks: [matrix('phishing')] },
    { name: 'planetary-gearset', files: ['examples/planetary-gearset/**'], checks: [matrix('planetary')] },
    { name: 'diagnostic-reseau and orbital-rendezvous', files: ['examples/diagnostic-reseau/**', 'examples/orbital-rendezvous/**'], checks: [matrix('lms-matrix'), e2e('player')] }
  ]
};
