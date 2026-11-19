import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolClient } from '@elabora/engine/protocol';
import type { EngineEvent, EventMessage, RequestMessage, RequestType, ResponseMessage, Service } from '@elabora/engine/protocol';
import { SERVICES, SERVICE_REQUESTS, serviceOf } from '@elabora/engine/base/services';

// The engine's protocol, played against a session (docs/architecture/engine.md, The protocol): each
// request of packages/engine/src/protocol.ts at least once, judged on its answer and on the events
// the session sends, never on how the session does it. The same cases run against every session
// that speaks the protocol: the desktop's today (test/unit/engine-conformance.test.ts), the
// browser's tomorrow. A target opens a session on a copy of a sample module and gives the suite a
// transport to it, the messages carried as a message port carries them (structured clone).
//
// What a target says of itself, besides the transport: how a file the person picks reaches the
// session (an absolute path on a desktop), and where an export is written. Its session has no
// ElevenLabs key and cannot reach ElevenLabs: no case spends anything.

export type Sample =
  // The network sample as the engine's tests keep it (test/fixtures/diagnostic-reseau-v1): seven
  // screens, narrated screens with their recordings and word times, a voiced layer, a dialogue, a
  // free object, plan versions V1 and V2.
  | 'network'
  // A smaller module without narration (test/fixtures/format-0.1/diagnostic-reseau), for what builds.
  | 'basic'
  // A module of two languages, its French translation approved (test/fixtures/format-0.1/orbital-rendezvous).
  | 'bilingual';

export interface ConformanceTarget {
  name: string;
  // The services its sessions have (D102): every one by default. A case of another is skipped.
  services?: readonly Service[];
  // services: those the session opened has, fewer than the target's (none for the case of a service
  // that is not here).
  open(sample: Sample, options?: { services?: readonly Service[] }): Promise<Connection>;
}

export interface Connection {
  send(message: RequestMessage): void;
  // Every response and event, from the session's opening on.
  receive(listener: (message: ResponseMessage | EventMessage) => void): void;
  // A file the person picked, named name, holding the bytes of the sample's file from (a path in the
  // module): what a request that takes a file is given.
  pick(name: string, from: string): string;
  // Where an export the person asked for is written, named name.
  saveAs(name: string): string;
  // Ends what the target made for this session (its copy of the module), the session closed or not.
  dispose(): Promise<void>;
}

// Every request of the protocol, checked complete by the compiler: the last case says which ones no
// case sent, so that a request added to the protocol gets its case here.
const REQUESTS: Record<RequestType, true> = {
  summary: true, readFile: true, listFiles: true, readScreen: true, screenParts: true, narration: true, timeline: true, timelineAt: true, timelineMarks: true,
  effects: true, transcribers: true, transcribeRecording: true, transcriptionEstimate: true, transcribeLine: true, planVoiceover: true, planVersions: true, planDiff: true,
  planDocument: true, planDocumentPage: true, exportPlanDocument: true, dialogue: true, dialoguePlay: true, dialoguePage: true, exportDialogue: true, narrationPeaks: true,
  importNarrationFiles: true, findText: true, conversions: true, translationStatus: true, translationTable: true, screenTranslation: true, buildTranslation: true, run: true,
  undo: true, redo: true, undoBatch: true, history: true, mark: true, endTurn: true, diagnostics: true, importMedia: true, mediaJobs: true, activity: true, cancelMediaJob: true,
  backups: true, createBackup: true, restoreBackup: true, renderScreen: true, openCanvas: true, canvasView: true, closeCanvas: true, migrate: true, voices: true,
  installVoices: true, setSpeakerVoice: true, setVoiceKey: true, voiceAccount: true, voiceSearch: true, voiceEstimate: true, soundSearch: true, soundPreview: true,
  courseSounds: true, soundEstimate: true, generateSound: true, generateVoice: true, voiceTakes: true, cancelVoice: true, voiceSample: true, aligners: true,
  alignNarration: true, build: true, packageWeights: true, close: true
};

// A wait in a test is bounded for failures only.
const WAIT_MS = 30_000;

type Changed = Extract<EngineEvent, { type: 'changed' }>;
const changed = (command?: string) => (event: EngineEvent): event is Changed => event.type === 'changed' && (!command || event.change.command?.name === command);
const refused = (kind: string, code?: string | RegExp) => (error: unknown) => {
  const { kind: actual, code: given, message } = error as { kind?: string; code?: string; message?: string };
  assert.equal(actual, kind, message);
  if (typeof code === 'string') assert.equal(given, code, message);
  else if (code) assert.match(message ?? '', code);
  return true;
};

interface Engine {
  client: ProtocolClient;
  events: EngineEvent[];
  connection: Connection;
  // The first event that matches, waiting for it; from: only those after that many events.
  next<T extends EngineEvent>(match: (event: EngineEvent) => event is T, from?: number): Promise<T>;
}

export function engineConformance(target: ConformanceTarget): void {
  const services = new Set(target.services ?? SERVICES);
  const sent = new Set<string>();
  // The sessions a case opened, closed when it ends.
  const open: Engine[] = [];

  async function engine(sample: Sample): Promise<Engine> {
    const connection = await target.open(sample);
    const events: EngineEvent[] = [];
    const client = new ProtocolClient((message) => {
      sent.add(message.type);
      connection.send(message);
    });
    connection.receive((message) => {
      if (message.kind === 'event') events.push(message.event);
      client.receive(message);
    });
    const next = async <T extends EngineEvent>(match: (event: EngineEvent) => event is T, from = 0): Promise<T> => {
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const found = events.slice(from).find(match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`No such event in ${WAIT_MS} ms; the session sent ${JSON.stringify(events.map((event) => event.type))}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const made = { client, events, connection, next };
    open.push(made);
    return made;
  }

  // A case of services the target does not have is skipped (the case of a service not here judges them).
  const it = (name: string, run: () => Promise<void>, needs: readonly Service[] = []) => test(`${target.name}: ${name}`, { skip: needs.some((service) => !services.has(service)) && `no ${needs.filter((service) => !services.has(service)).join(', ')} service here` }, async () => {
    try {
      await run();
    } finally {
      for (const { client, connection } of open.splice(0)) {
        if (!client.closed) await client.request('close', {}).catch(() => {});
        await connection.dispose();
      }
    }
  });

  // ── reads ────────────────────────────────────────────────────────────

  it('the summary, the files and a screen, as the module holds them', async () => {
    const { client } = await engine('network');
    const summary = await client.request('summary', {});
    const course = await client.request('readFile', { path: 'course.json' });
    assert.equal(course.kind, 'text');
    const json = JSON.parse(course.kind === 'text' ? course.text : '{}');
    assert.equal(summary.course?.id, json.id);
    assert.deepEqual(summary.outline.map((section) => section.screens.map((screen) => screen.id)), json.sections.map((section: { screens: string[] }) => section.screens));
    assert.equal(summary.format.state, 'current');
    assert.deepEqual(summary.unlisted, []);
    // Every screen with how long a learner spends on it (D50).
    assert.ok(summary.outline.flatMap((section) => section.screens).every((screen) => screen.seconds >= 10));
    const versions = await client.request('planVersions', {});
    assert.deepEqual([summary.plan.state, summary.plan.latest, summary.plan.validated, summary.plan.unversioned], [versions.state, 2, 2, versions.current.unversioned]);
    assert.equal(summary.plan.items, 7);
    assert.deepEqual([...summary.services].sort(), [...services].sort());

    const recording = await client.request('readFile', { path: 'assets/narration/fr/chemin/chemin-depart.m4a' });
    assert.ok(recording.kind === 'binary' && recording.size > 0 && /^sha256:/.test(recording.hash ?? ''));
    await assert.rejects(client.request('readFile', { path: 'absent.json' }), refused('not-found'));
    await assert.rejects(client.request('readFile', { path: '../course.json' }), refused('not-found'));

    const all = await client.request('listFiles', {});
    assert.ok(all.some((file) => file.path === 'course.json' && file.kind === 'text' && file.size === new TextEncoder().encode(course.kind === 'text' ? course.text : '').length));
    assert.deepEqual(all.map((file) => file.path), all.map((file) => file.path).sort((a, b) => a.localeCompare(b)));
    const chemin = await client.request('listFiles', { dir: 'assets/narration/fr/chemin' });
    assert.ok(chemin.length >= 6 && chemin.every((file) => file.path.startsWith('assets/narration/fr/chemin/')));
    await assert.rejects(client.request('listFiles', { dir: '..' }), refused('bad-request'));

    const screen = await client.request('readScreen', { screen: 'chemin' });
    assert.deepEqual([screen.id, screen.file, screen.data.id], ['chemin', 'screens/chemin.json', 'chemin']);
    assert.ok(Array.isArray(screen.diagnostics) && screen.error === undefined);
    await assert.rejects(client.request('readScreen', { screen: 'absent' }), refused('not-found'));

    const findings = await client.request('diagnostics', {});
    assert.equal(findings.summary.errors, summary.diagnostics.errors);
    const one = await client.request('diagnostics', { screen: 'chemin' });
    assert.deepEqual(Object.keys(one.screens), ['chemin']);
    assert.deepEqual(one.screens.chemin, screen.diagnostics);

    assert.equal((await client.request('effects', {}))[0]?.name, 'none');
    assert.deepEqual(await client.request('courseSounds', {}), [], 'no sound in the module');
  });

  it('what the events of a screen can name: its blocks, steps and layers, the course\'s screens and variables', async () => {
    const { client } = await engine('network');
    const parts = await client.request('screenParts', { screen: 'simulation' });
    const scene = parts.blocks.find((block) => block.id === 'simulation-scene');
    assert.equal(scene?.behavior, 'object');
    assert.deepEqual(scene?.object?.events.map((event) => [event.name, event.fields]), [['device_inspected', ['device', 'inOrder', 'faulty']], ['hint_shown', []], ['completed', ['score', 'attempts']]]);
    assert.ok(scene?.object?.props.some((prop) => prop.name === 'packetSpeed' && prop.type === 'number'));
    assert.deepEqual(parts.blocks.find((block) => block.id === 'simulation-bravo')?.controls, []);
    assert.deepEqual(parts.steps, [1]);
    assert.equal(parts.screens[0]?.id, 'titre');
    assert.ok(parts.variables.some((variable) => variable.id === 'indiceVu'));
    assert.deepEqual((await client.request('screenParts', { screen: 'premier-reflexe' })).layers.map((layer) => layer.id), ['rappel-regle']);
    await assert.rejects(client.request('screenParts', { screen: 'absent' }), refused('not-found'));
  });

  // ── changes ──────────────────────────────────────────────────────────

  it('a command: its change, then the findings it changed, in events; refusals typed', async () => {
    const { client, events, next } = await engine('network');
    const run = await client.request('run', { command: 'update_screen', args: { id: 'chemin', title: 'Le chemin' } });
    assert.equal(run.command, 'update_screen');
    assert.deepEqual([run.change?.command?.name, run.change?.author, run.files], ['update_screen', { kind: 'human' }, ['screens/chemin.json']]);
    const event = await next(changed('update_screen'));
    assert.deepEqual([event.source, event.change.id], ['engine', run.change?.id]);
    assert.equal((await client.request('readScreen', { screen: 'chemin' })).data.title, 'Le chemin');
    assert.equal((await client.request('summary', {})).journal.seq, run.change?.seq);

    // A missing image: found on its screen, in the answer and in an event after the change's.
    const before = events.length;
    const added = await client.request('run', { command: 'add_block', args: { screen: 'chemin', block: { id: 'chemin-plan', type: 'image', props: { asset: 'images/absent.svg', alt: 'Plan du réseau' } }, after: 'chemin-schema' } });
    assert.ok(added.diagnostics.some((finding) => finding.code === 'E_ASSET_MISSING'));
    const findings = await next((e): e is Extract<EngineEvent, { type: 'diagnostics' }> => e.type === 'diagnostics', before);
    assert.ok(events.indexOf(findings) > events.findIndex((e, i) => i >= before && changed('add_block')(e)));
    assert.deepEqual(Object.keys(findings.screens), ['chemin']);
    assert.ok(findings.screens.chemin?.some((finding) => finding.code === 'E_ASSET_MISSING'));
    assert.equal(findings.summary.errors, added.summary.errors);

    await assert.rejects(client.request('run', { command: 'remove_block', args: { block: 'absent' } }), refused('refused'));
    // The author writes the plan as an agent does; versions are a person's.
    await assert.rejects(client.request('run', { command: 'write_plan', args: { patch: [{ op: 'remove', path: '/items/9' }] } }), refused('refused', /does not apply/));
    await assert.rejects(client.request('run', { command: 'approve_plan', args: { by: 'Claire Martin' }, author: { kind: 'agent', name: 'assistant' } }), refused('refused', /Only a person/));
    await assert.rejects(client.request('run', { command: 'format_disk', args: {} } as never), refused('bad-request'));
    // The values a change was decided on (an AI's alt text for an image without one), changed
    // meanwhile: refused, nothing written.
    const seq = (await client.request('summary', {})).journal.seq;
    await assert.rejects(client.request('run', { command: 'update_block', args: { block: 'chemin-plan', props: { alt: 'Un plan' } }, expect: [{ block: 'chemin-plan', props: { alt: null } }] }), refused('refused', 'E_EXPECTED'));
    assert.equal((await client.request('summary', {})).journal.seq, seq);
    const plan = (await client.request('readScreen', { screen: 'chemin' })).data.blocks?.find((block) => block.id === 'chemin-plan');
    assert.equal((plan?.props as { alt?: string }).alt, 'Plan du réseau');
  });

  it('a message that is not a request of the protocol is answered as a bad request', async () => {
    const connection = await target.open('basic');
    const answers: ResponseMessage[] = [];
    connection.receive((message) => { if (message.kind === 'response') answers.push(message); });
    try {
      connection.send({ kind: 'request', id: 'x1', type: 'format_disk', params: {} } as never);
      connection.send({ kind: 'request', type: 'summary', params: {} } as never);
      const deadline = Date.now() + WAIT_MS;
      while (answers.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(answers.map((answer) => [answer.id, answer.ok, !answer.ok && answer.error.kind]), [['x1', false, 'bad-request'], ['', false, 'bad-request']]);
      connection.send({ kind: 'request', id: 'c', type: 'close', params: {} });
    } finally {
      await connection.dispose();
    }
  });

  it('undo, redo and the history: the author\'s last step, back and again', async () => {
    const { client, next } = await engine('network');
    const original = (await client.request('readScreen', { screen: 'chemin' })).data.title;
    const run = await client.request('run', { command: 'update_screen', args: { id: 'chemin', title: 'Le chemin' } });
    const undone = await client.request('undo', {});
    assert.deepEqual(undone.undone, [run.change?.seq]);
    assert.equal(undone.change?.type, 'undo');
    assert.deepEqual(undone.change?.undoes?.changes, [run.change?.id]);
    assert.equal((await next((event): event is Changed => event.type === 'changed' && event.change.type === 'undo')).change.id, undone.change?.id);
    assert.equal((await client.request('readScreen', { screen: 'chemin' })).data.title, original);
    const redone = await client.request('redo', {});
    assert.equal(redone.change?.type, 'undo');
    assert.equal((await client.request('readScreen', { screen: 'chemin' })).data.title, 'Le chemin');
    await assert.rejects(client.request('redo', {}), refused('refused'));
    await assert.rejects(client.request('undo', { seq: 999 }), refused('not-found'));

    const seq = run.change!.seq;
    const history = await client.request('history', { limit: 10 });
    assert.deepEqual(history.changes.filter((change) => change.seq >= seq).map((change) => [change.seq - seq, change.op, change.undone]), [[0, 'update_screen', false], [1, 'undo', true], [2, 'undo', false]]);
    assert.ok(history.changes.every((change) => change.ops === undefined));
    const withOps = await client.request('history', { limit: 1, ops: true });
    assert.deepEqual(withOps.changes.map((change) => change.seq), [seq + 2]);
    assert.ok(withOps.changes[0]?.ops?.length);
  });

  it('an agent\'s turn: a mark, its changes, its end; undoing its batch keeps the author\'s later edit', async () => {
    const { client, events, next } = await engine('network');
    const mark = await client.request('mark', { request: 'Reformule le titre', chat: 'conversation-1' });
    assert.ok(mark.mark.id && mark.mark.seq > 0);
    const agent = { kind: 'agent', name: 'assistant', chat: 'conversation-1' } as const;
    const wrote = await client.request('run', { command: 'update_screen', args: { id: 'chemin', title: 'Le chemin des données' }, author: agent });
    assert.equal(wrote.change?.batch, mark.mark.id);
    assert.deepEqual(wrote.change?.author, agent);
    assert.equal((await client.request('summary', {})).journal.openBatch, mark.mark.id);
    const ended = await client.request('endTurn', { turn: mark.mark.id });
    assert.deepEqual(ended, { batch: mark.mark.id, changes: 1 });
    const closed = await next((event): event is Extract<EngineEvent, { type: 'batchClosed' }> => event.type === 'batchClosed');
    assert.deepEqual([closed.batch, closed.reason], [mark.mark.id, 'turn']);
    await assert.rejects(client.request('endTurn', { turn: 'absent' }), refused('not-found'));

    await client.request('run', { command: 'update_block', args: { block: 'chemin-regle', props: { markdown: 'Toujours dans l\'ordre.' } } });
    const from = events.length;
    const undone = await client.request('undoBatch', {});
    assert.equal(undone.batch, mark.mark.id);
    assert.deepEqual(undone.undone, [wrote.change?.seq]);
    assert.equal(undone.change?.type, 'undo');
    await next((event): event is Changed => event.type === 'changed' && event.change.id === undone.change?.id, from);
    const screen = await client.request('readScreen', { screen: 'chemin' });
    assert.notEqual(screen.data.title, 'Le chemin des données');
    assert.equal((screen.data.blocks?.find((block) => block.id === 'chemin-regle')?.props as { markdown?: string })?.markdown, 'Toujours dans l\'ordre.');
  });

  // ── narration ────────────────────────────────────────────────────────

  it('a narrated screen: its lines, timeline, a moment, its marks, the plan\'s voice-over', async () => {
    const { client } = await engine('network');
    const narration = await client.request('narration', { screen: 'chemin' });
    assert.deepEqual(narration?.lines.map((line) => [line.id, line.status]), [['chemin-depart', 'ok'], ['chemin-reseaux', 'ok'], ['chemin-diagnostic', 'ok']]);
    assert.equal(narration?.language, 'fr');
    assert.equal(await client.request('narration', { screen: 'bilan' }), null);
    await assert.rejects(client.request('narration', { screen: 'absent' }), refused('not-found'));
    const layer = await client.request('narration', { screen: 'premier-reflexe', layer: 'rappel-regle' });
    assert.ok(layer?.lines.length);

    const timeline = await client.request('timeline', { screen: 'chemin' });
    assert.ok(timeline && timeline.duration > 6);
    assert.equal(timeline.lines[0]?.words?.[0]?.text, 'Regardez');
    assert.equal(await client.request('timeline', { screen: 'bilan' }), null);
    const at = await client.request('timelineAt', { screen: 'chemin', time: 1 });
    assert.ok(at && at.time === 1);
    const atWord = await client.request('timelineAt', { screen: 'chemin', at: { line: 'chemin-reseaux' } });
    assert.ok(atWord && atWord.time > 6);
    await assert.rejects(client.request('timelineAt', { screen: 'chemin' }), refused('bad-request'));
    const marks = await client.request('timelineMarks', { screen: 'chemin' });
    assert.ok(marks && marks[0]?.time === 0 && marks.every((mark, i) => i === 0 || mark.time >= marks[i - 1]!.time));

    const voiceover = await client.request('planVoiceover', { screen: 'chemin' });
    assert.ok(Array.isArray(voiceover) && voiceover.every((part) => typeof part.item === 'string' && typeof part.text === 'string'));
    await assert.rejects(client.request('planVoiceover', { screen: 'absent' }), refused('not-found'));
  });

  it('recordings: a screen\'s waveform; several imported together, each to the line its name gives, one change a line', async () => {
    const { client, connection, next } = await engine('network');
    const peaks = await client.request('narrationPeaks', { screen: 'chemin', perSecond: 20 });
    assert.deepEqual(peaks?.lines.map((line) => line.line), ['chemin-depart', 'chemin-reseaux', 'chemin-diagnostic']);
    assert.equal(peaks?.perSecond, 20);
    assert.ok(peaks?.lines.every((line) => line.peaks.length > 0));
    assert.equal(await client.request('narrationPeaks', { screen: 'bilan' }), null);
    const file = connection.pick('chemin-depart.m4a', 'assets/narration/fr/chemin/chemin-reseaux.m4a');
    const imported = await client.request('importNarrationFiles', { files: [file], screen: 'chemin', keepSilence: true });
    assert.equal(imported.language, 'fr');
    assert.deepEqual(imported.files.map((one) => [one.status, one.screen, one.line, one.by]), [['imported', 'chemin', 'chemin-depart', 'name']]);
    const event = await next(changed('set_narration_audio'));
    assert.ok(event.change.files.some((path) => path.startsWith('assets/narration/fr/chemin/chemin-depart')));
    await assert.rejects(client.request('importNarrationFiles', { files: [] }), refused('bad-request'));
  }, ['media']);

  // ── the plan ─────────────────────────────────────────────────────────

  it('the plan: its versions, what changed between two, its document as data', async () => {
    const { client } = await engine('network');
    const versions = await client.request('planVersions', {});
    assert.deepEqual([versions.latest, versions.validated], [2, 2]);
    assert.deepEqual(versions.versions.map((version) => version.number), [1, 2]);
    const diff = await client.request('planDiff', { from: 1, to: 2 });
    assert.ok(diff.changes.length > 0);
    assert.equal((await client.request('planDiff', {})).changes.length, versions.current.sinceValidated, 'what changed since the validated version');
    await assert.rejects(client.request('planDiff', { from: 'yesterday' as never }), refused('bad-request'));
    await assert.rejects(client.request('planDiff', { from: 9 }), refused('not-found'));

    const document = await client.request('planDocument', { date: '2026-11-18' });
    assert.equal(document?.date, '2026-11-18');
    assert.equal(document?.plan.version, 'V2');
    assert.equal((await client.request('planDocument', { version: 'current' }))?.plan.version, null);
    await assert.rejects(client.request('planDocument', { version: 'V2' as never }), refused('bad-request'));
  });

  // ── a dialogue ───────────────────────────────────────────────────────

  it('a dialogue: its view, a path played', async () => {
    const { client } = await engine('network');
    const view = await client.request('dialogue', { block: 'appel-marc' });
    assert.deepEqual([view?.id, view?.screen], ['appel-marc', 'premier-reflexe']);
    assert.ok(view && view.map.nodes.length > 1);
    assert.equal(await client.request('dialogue', { block: 'absent' }), null);
    const start = await client.request('dialoguePlay', { block: 'appel-marc', choices: [] });
    assert.deepEqual([start.dialogue, start.screen, start.ok, start.ended], ['appel-marc', 'premier-reflexe', true, false]);
    assert.ok(start.offered.length > 1 && start.waiting);
    const path = await client.request('dialoguePlay', { block: 'appel-marc', choices: [start.offered[0]!] });
    assert.ok(path.ok && path.choices.length === 1);
    const wrong = await client.request('dialoguePlay', { block: 'appel-marc', choices: ['not-an-option'] });
    assert.equal(wrong.ok, false);
    assert.ok(wrong.error);
    await assert.rejects(client.request('dialoguePlay', { block: 'absent', choices: [] }), refused('not-found'));
  });

  it('documents: the plan\'s and a dialogue\'s as a page to print and as a file, the plan\'s send recorded', async () => {
    const { client, connection, next } = await engine('network');
    const document = await client.request('planDocument', { date: '2026-11-18' });
    const page = await client.request('planDocumentPage', { date: '2026-11-18' });
    assert.match(page.html, /^<!doctype html>/i);
    assert.deepEqual([page.date, page.version, page.title], ['2026-11-18', 'V2', document?.title]);

    const exported = await client.request('exportPlanDocument', { format: 'html', file: connection.saveAs('plan.html'), date: '2026-11-18' });
    assert.ok(exported.bytes > 1000);
    assert.deepEqual([exported.format, exported.version, exported.sent], ['html', 'V2', true]);
    const sent = await next(changed('record_plan_send'));
    assert.deepEqual(sent.change.command?.args, { version: 'V2', format: 'html', date: '2026-11-18' });
    await assert.rejects(client.request('exportPlanDocument', { format: 'odt' as never, file: connection.saveAs('plan.odt') }), refused('bad-request'));

    const dialoguePage = await client.request('dialoguePage', { block: 'appel-marc', date: '2026-11-18' });
    assert.match(dialoguePage.html, /^<!doctype html>/i);
    assert.equal(dialoguePage.date, '2026-11-18');
    const dialogue = await client.request('exportDialogue', { block: 'appel-marc', format: 'html', file: connection.saveAs('dialogue.html'), date: '2026-11-18' });
    assert.ok(dialogue.bytes > 1000 && dialogue.format === 'html');
    await assert.rejects(client.request('exportDialogue', { block: 'appel-marc', format: 'docx' as never, file: connection.saveAs('dialogue.docx') }), refused('bad-request'));
  }, ['documents']);

  // ── texts and languages ──────────────────────────────────────────────

  it('texts and languages: words found, a block\'s conversions, a language started and its table', async () => {
    const { client } = await engine('network');
    const found = await client.request('findText', { query: 'pare-feu' });
    assert.ok(found.some((match) => match.screen === 'chemin' && match.block === 'chemin-roles'));
    assert.ok(found.every((match) => match.file.startsWith('screens/') || match.file === 'course.json'));
    assert.deepEqual(await client.request('findText', { query: 'PARE-FEU', caseSensitive: true }), []);

    assert.deepEqual(await client.request('conversions', { probe: true }), { supported: true, targets: [], refused: [] });
    const conversions = await client.request('conversions', { block: 'chemin-roles', language: 'en' });
    assert.equal(conversions.block, 'chemin-roles');
    assert.ok(conversions.targets.length > 0 && conversions.targets.every((target) => typeof target.kept === 'string'));
    await assert.rejects(client.request('conversions', { block: 'absent' }), refused('not-found'));

    assert.deepEqual(await client.request('translationStatus', {}), []);
    await client.request('run', { command: 'export_translation', args: { to: 'en' } });
    assert.deepEqual((await client.request('translationStatus', {})).map((status) => [status.language, status.exists]), [['en', true]]);
    const table = await client.request('translationTable', { language: 'en' });
    assert.ok(table.rows.length > 20 && table.rows.every((row) => row.status === 'to-translate'));
    await assert.rejects(client.request('translationTable', { language: 'fr' }), refused('bad-request'));
    const screen = await client.request('screenTranslation', { screen: 'chemin', language: 'en' });
    assert.equal(screen.screen, 'chemin');
    assert.ok(screen.rows.length > 0 && screen.rows.every((row) => row.status === 'to-translate'));
    await assert.rejects(client.request('screenTranslation', { screen: 'absent', language: 'en' }), refused('not-found'));
  });

  it('a language built as its own package', async () => {
    const { client } = await engine('bilingual');
    const status = await client.request('translationStatus', {});
    assert.deepEqual(status.map((language) => language.language), ['fr']);
    const built = await client.request('buildTranslation', { language: 'fr' });
    assert.deepEqual([built.language, built.ok, built.untranslated], ['fr', true, 0]);
    assert.ok(built.zip && built.size > 0 && built.units > 0);
    await assert.rejects(client.request('buildTranslation', { language: 3 as never }), refused('bad-request'));
  }, ['build']);

  // ── publishing ───────────────────────────────────────────────────────

  it('a package: its weight first, then built, its state keys a system change; bad parameters refused', async () => {
    const { client, next } = await engine('basic');
    const weights = await client.request('packageWeights', {});
    assert.deepEqual(weights.qualities.map((size) => size.quality), ['high', 'medium', 'low']);
    const built = await client.request('build', { profiles: ['moodle'] });
    assert.ok(built.ok && built.zip && built.report, JSON.stringify(built.errors));
    assert.ok(Math.abs(weights.qualities[0]!.bytes - built.size) < 16 * 1024, `weighed ${weights.qualities[0]!.bytes}, built ${built.size}`);
    assert.deepEqual([built.change?.author, built.change?.command?.name], [{ kind: 'system' }, 'build']);
    assert.equal((await next(changed('build'))).change.id, built.change?.id);
    assert.ok((await client.request('build', null as never)).ok, 'a request without parameters: the defaults');
    for (const params of [{ mediaQuality: 'ultra' }, { profiles: 'moodle' }, { release: 'yes' }, { name: 3 }, { target: 'web', profiles: ['moodle'] }]) {
      await assert.rejects(client.request('build', params as never), refused('bad-request'), JSON.stringify(params));
    }
  }, ['build']);

  // ── media ────────────────────────────────────────────────────────────

  it('media: an import becomes the requester\'s change when its job is done', async () => {
    const { client, connection, next } = await engine('basic');
    const imported = await client.request('importMedia', { path: connection.pick('Schéma Réseau.svg', 'assets/images/chemin-impression.svg') });
    assert.match(imported.path, /^assets\/images\/schema-reseau\.svg$/);
    const change = await next(changed('import_media'));
    assert.deepEqual([change.source, change.change.author, change.change.files], ['media', { kind: 'human' }, [imported.path]]);
    assert.ok((await next((event): event is Extract<EngineEvent, { type: 'mediaJob' }> => event.type === 'mediaJob' && event.job.id === imported.job.id && event.job.status === 'done')));
    assert.equal((await client.request('mediaJobs', {})).find((job) => job.id === imported.job.id)?.status, 'done');
    assert.ok((await client.request('listFiles', { dir: 'assets/images' })).some((file) => file.path === imported.path));
    await assert.rejects(client.request('cancelMediaJob', { id: 'absent' }), refused('not-found'));
  }, ['media']);

  // ── versions ─────────────────────────────────────────────────────────

  it('versions: a named one, then a file of it restored as the author\'s change', async () => {
    const { client, next } = await engine('basic');
    const named = await client.request('createBackup', { name: 'Avant la relecture' });
    assert.deepEqual([named?.name, named?.reason], ['Avant la relecture', 'manual']);
    assert.ok((await client.request('backups', {})).some((version) => version.id === named?.id));
    const original = (await client.request('readScreen', { screen: 'chemin' })).data.title;
    await client.request('run', { command: 'update_screen', args: { id: 'chemin', title: 'Titre modifié' } });
    await client.request('run', { command: 'update_screen', args: { id: 'accueil', title: 'Accueil modifié' } });
    const restored = await client.request('restoreBackup', { version: named!.id, paths: ['screens/chemin.json'] });
    assert.equal(restored.version, named?.id);
    assert.deepEqual([restored.change?.author, restored.change?.command?.name, restored.change?.files], [{ kind: 'human' }, 'restore_backup', ['screens/chemin.json']]);
    assert.equal((await next(changed('restore_backup'))).change.id, restored.change?.id);
    assert.equal((await client.request('readScreen', { screen: 'chemin' })).data.title, original);
    assert.equal((await client.request('readScreen', { screen: 'accueil' })).data.title, 'Accueil modifié');
    assert.ok((await client.request('backups', {})).some((version) => version.id === restored.before));
    await assert.rejects(client.request('restoreBackup', { version: 'absent' }), refused('not-found'));
  }, ['backups']);

  // ── the canvas ───────────────────────────────────────────────────────

  it('a screen rendered as the player shows it', async () => {
    const { client } = await engine('network');
    const render = await client.request('renderScreen', { screen: 'chemin', step: 1 });
    assert.equal(render.screen, 'chemin');
    assert.equal(render.course.screens[0]?.id, 'chemin');
    assert.deepEqual(render.view, { state: 'initial', step: 1, layer: null });
    assert.ok(render.files.some((file) => file.kind === 'asset' && file.path.startsWith('assets/images/')));
    await assert.rejects(client.request('renderScreen', { screen: 'absent' }), refused('not-found'));
  });

  it('the canvas: the page opened, shown another view, closed', async () => {
    const { client } = await engine('network');
    await assert.rejects(client.request('canvasView', { screen: 'chemin' }), refused('not-available'));
    const canvas = await client.request('openCanvas', {});
    assert.ok(canvas.url.includes(canvas.token));
    const view = await client.request('canvasView', { screen: 'chemin', step: 1 });
    assert.deepEqual([view.view.screen, view.view.step], ['chemin', 1]);
    assert.ok(view.id);
    assert.deepEqual(await client.request('closeCanvas', {}), { closed: true });
    await assert.rejects(client.request('canvasView', { screen: 'accueil' }), refused('not-available'));
  }, ['canvas']);

  // ── voices ───────────────────────────────────────────────────────────

  it('voices: those here, installed, a speaker\'s voice set, lines said again and their takes, a sample', async () => {
    const { client, next } = await engine('network');
    const voices = await client.request('voices', { language: 'fr' });
    const claire = voices.find((voice) => voice.provider === 'pocket-tts' && voice.id === 'claire');
    assert.ok(claire, JSON.stringify(voices.map((voice) => [voice.provider, voice.id])));
    assert.deepEqual(await client.request('installVoices', { language: 'fr' }), { language: 'fr', installed: true });
    await assert.rejects(client.request('installVoices', { language: 'tlh' }), refused('not-found'));

    const set = await client.request('setSpeakerVoice', { speaker: 'guide', voice: 'henri', provider: 'pocket-tts' });
    assert.ok(set.change !== null);
    await next(changed('update_course'));
    const estimate = await client.request('voiceEstimate', { screen: 'chemin', all: true });
    assert.equal(estimate.needsApproval, false);

    await client.request('run', { command: 'update_narration_line', args: { screen: 'chemin', line: 'chemin-depart', text: 'Suivez le schéma de gauche à droite.' } });
    assert.equal((await client.request('narration', { screen: 'chemin' }))?.lines[0]?.status, 'stale');
    const said = await client.request('generateVoice', { screen: 'chemin' });
    // The new voice makes every line out of date.
    assert.deepEqual(said.lines.map((line) => [line.line, line.status]), [['chemin-depart', 'generated'], ['chemin-reseaux', 'generated'], ['chemin-diagnostic', 'generated']]);
    await next(changed('set_narration_audio'));
    assert.equal((await client.request('narration', { screen: 'chemin' }))?.lines[0]?.status, 'ok');
    const takes = await client.request('voiceTakes', { screen: 'chemin', line: 'chemin-depart' });
    assert.equal(takes.language, 'fr');
    assert.ok(takes.takes.length >= 1);
    await assert.rejects(client.request('generateVoice', { screen: 'absent' }), refused('not-found'));

    // Stopped while it says a screen: what it said stays, the answer says so.
    const running = client.request('generateVoice', { screen: 'chemin', all: true });
    assert.deepEqual(await client.request('cancelVoice', { screen: 'accueil' }), { cancelled: 0 });
    assert.deepEqual(await client.request('cancelVoice', { screen: 'chemin' }), { cancelled: 1 });
    assert.equal((await running).cancelled, true);

    const sample = await client.request('voiceSample', { voice: 'claire', provider: 'pocket-tts', text: 'Bonjour.' });
    assert.ok(sample.audio instanceof Uint8Array && sample.duration > 0);
    assert.equal(new TextDecoder().decode(sample.audio.slice(0, 4)), 'RIFF');
  }, ['voices']);

  it('ElevenLabs without a key: refused with its code; a key given is kept masked, ElevenLabs out of reach said not available, the key forgotten', async () => {
    const { client } = await engine('network');
    await assert.rejects(client.request('voiceAccount', { provider: 'elevenlabs' }), refused('refused', 'E_VOICE_KEY_MISSING'));
    await assert.rejects(client.request('voiceSearch', { query: 'warm' } as never), refused('refused', 'E_VOICE_KEY_MISSING'));
    await assert.rejects(client.request('setVoiceKey', { provider: 'elevenlabs', key: 'not a key' }), refused('refused', 'E_VOICE_KEY_FORMAT'));
    const key = 'sk_0123456789abcdef0123456789abcdef';
    const given = await client.request('setVoiceKey', { provider: 'elevenlabs', key });
    assert.ok(given.key && given.key !== key && given.key.endsWith(key.slice(-4)));
    // ElevenLabs out of reach: its account not possible now.
    await assert.rejects(client.request('voiceAccount', { provider: 'elevenlabs' }), refused('not-available', 'E_VOICE_OFFLINE'));
    assert.deepEqual(await client.request('setVoiceKey', { provider: 'elevenlabs', key: null }), { key: null });
  }, ['voices']);

  it('transcription: what can transcribe, a recording heard, a line\'s recording beside its text', async () => {
    const { client, connection } = await engine('network');
    const here = await client.request('transcribers', {});
    assert.equal(here.language, 'fr');
    assert.equal(here.local?.installed, true);
    const heard = await client.request('transcribeRecording', { file: connection.pick('appel.m4a', 'assets/narration/fr/accueil/marc-appel.m4a') });
    assert.ok(heard.text.length > 0 && heard.words.length > 0 && heard.duration > 0);
    // A generated voice says its text: only a recording is heard again.
    await assert.rejects(client.request('transcribeLine', { screen: 'chemin', line: 'chemin-depart' }), refused('refused', 'E_NARRATION_GENERATED'));
    await client.request('importNarrationFiles', { files: [connection.pick('chemin-depart.m4a', 'assets/narration/fr/chemin/chemin-depart.m4a')], screen: 'chemin' });
    const line = await client.request('transcribeLine', { screen: 'chemin', line: 'chemin-depart' });
    const narration = await client.request('narration', { screen: 'chemin' });
    assert.equal(line.before, narration?.lines[0]?.text);
    assert.ok(line.transcript.text.length > 0 && /^sha256:/.test(line.audioHash ?? ''));
    await assert.rejects(client.request('transcribeLine', { screen: 'absent', line: 'x' }), refused('not-found'));
    // What ElevenLabs would take of the quota: its key first.
    await assert.rejects(client.request('transcriptionEstimate', { screen: 'chemin', line: 'chemin-depart' }), refused('refused', 'E_VOICE_KEY_MISSING'));
    await assert.rejects(client.request('transcriptionEstimate', { screen: 'chemin', line: 'absent' }), refused('not-found'));
  }, ['transcribe', 'media']);

  it('word times: the aligners of a language; lines already timed by the same aligner are left', async () => {
    const { client, events } = await engine('network');
    const aligners = await client.request('aligners', { language: 'fr-CA' });
    assert.deepEqual(aligners.map((aligner) => aligner.language), ['fr']);
    const before = events.length;
    const result = await client.request('alignNarration', { screen: 'chemin' });
    assert.deepEqual(result.lines.map((line) => [line.line, line.status]), [['chemin-depart', 'skipped'], ['chemin-reseaux', 'skipped'], ['chemin-diagnostic', 'skipped']]);
    assert.deepEqual(result.changes, []);
    assert.ok(!events.slice(before).some(changed()), 'nothing written');
    await assert.rejects(client.request('alignNarration', { screen: 'chemin', lines: ['absent'] }), refused('not-found', 'E_ALIGN_LINE'));
  }, ['align']);

  // ── sounds ───────────────────────────────────────────────────────────

  it('sounds: the library searched and heard, one added, the module\'s sounds', async () => {
    const { client, next } = await engine('network');
    assert.deepEqual(await client.request('courseSounds', {}), []);
    const found = await client.request('soundSearch', { source: 'library', query: '' } as never);
    assert.ok(found.sounds.length > 0);
    const sound = found.sounds[0]!;
    const heard = await client.request('soundPreview', { from: sound.from });
    assert.ok(heard.audio instanceof Uint8Array && heard.audio.length > 1000 && /^audio\//.test(heard.type));
    await assert.rejects(client.request('soundPreview', { from: 'absent' }), refused('not-found'));
    await assert.rejects(client.request('soundSearch', { source: 'everywhere' } as never), refused('bad-request'));
    const added = await client.request('run', { command: 'add_sound', args: { from: sound.from } });
    await next(changed('add_sound'));
    const sounds = await client.request('courseSounds', {});
    assert.deepEqual(sounds.map((one) => one.path), [added.result.path]);
  }, ['sounds']);

  it('a sound made with ElevenLabs: refused without a key; with one and ElevenLabs out of reach, estimated without the quota, the author\'s approval asked', async () => {
    const { client } = await engine('network');
    await assert.rejects(client.request('generateSound', { prompt: 'Un clic de souris' } as never), refused('refused', 'E_VOICE_KEY_MISSING'));
    await assert.rejects(client.request('soundEstimate', { duration: 2 }), refused('refused', 'E_VOICE_KEY_MISSING'));
    await client.request('setVoiceKey', { provider: 'elevenlabs', key: 'sk_0123456789abcdef0123456789abcdef' });
    try {
      const estimate = await client.request('soundEstimate', { duration: 2 });
      assert.deepEqual([estimate.quota, estimate.percent, estimate.needsApproval], [null, null, true]);
      assert.ok(estimate.credits > 0);
    } finally {
      await client.request('setVoiceKey', { provider: 'elevenlabs', key: null });
    }
  }, ['sounds', 'voices']);

  // ── the module's format and its agents ───────────────────────────────

  it('a module in the format this Elabora writes needs no migration', async () => {
    const { client } = await engine('basic');
    assert.equal(await client.request('migrate', {}), null);
  });

  it('agents did nothing in a module just opened', async () => {
    const { client } = await engine('basic');
    assert.deepEqual(await client.request('activity', {}), []);
    assert.deepEqual(await client.request('activity', { limit: 5 }), []);
  }, ['activity']);

  // ── a service not here ───────────────────────────────────────────────

  it('a session without a service: each of its requests, and a command that needs it, answer not-available, E_NOT_HERE; the summary says which it has', async () => {
    const connection = await target.open('basic', { services: [] });
    const answers = new Map<string, ResponseMessage>();
    connection.receive((message) => { if (message.kind === 'response') answers.set(message.id, message); });
    try {
      const types = SERVICES.flatMap((service) => SERVICE_REQUESTS[service]);
      for (const type of [...types, 'summary' as const]) connection.send({ kind: 'request', id: type, type, params: {} } as RequestMessage);
      // A command whose need belongs to a service the session does not have (a sound of the library).
      connection.send({ kind: 'request', id: 'run', type: 'run', params: { command: 'add_sound', args: { from: 'applaudissements' } } } as RequestMessage);
      const deadline = Date.now() + WAIT_MS;
      while (answers.size <= types.length + 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      for (const type of [...types, 'run' as const]) {
        const answer = answers.get(type);
        assert.ok(answer && !answer.ok, `${type}: ${JSON.stringify(answer)}`);
        assert.deepEqual([answer.error.kind, answer.error.code], ['not-available', 'E_NOT_HERE'], type);
      }
      const summary = answers.get('summary');
      assert.ok(summary?.ok && summary.type === 'summary');
      assert.deepEqual((summary.result as { services: Service[] }).services, []);
      connection.send({ kind: 'request', id: 'close', type: 'close', params: {} });
    } finally {
      await connection.dispose();
    }
  });

  // ── closing ──────────────────────────────────────────────────────────

  it('closing: answered with the version kept, the closed event, then every request refused as closed', async () => {
    const { client, next } = await engine('basic');
    await client.request('run', { command: 'update_screen', args: { id: 'chemin', title: 'Le chemin' } });
    const closed = await client.request('close', {});
    assert.ok(typeof closed.version === 'string' || closed.version === null);
    await next((event): event is Extract<EngineEvent, { type: 'closed' }> => event.type === 'closed');
    await assert.rejects(client.request('summary', {}), refused('closed'));
    await assert.rejects(client.request('run', { command: 'update_screen', args: { id: 'chemin', title: 'Encore' } }), refused('closed'));
    // Every request, those that call no file of the module included, those of a service too.
    await assert.rejects(client.request('setVoiceKey', { provider: 'elevenlabs', key: null }), refused('closed'));
    await assert.rejects(client.request('voiceAccount', { provider: 'elevenlabs' }), refused('closed'));
    await assert.rejects(client.request('voiceSearch', { query: 'warm' } as never), refused('closed'));
  });

  // Last: every request of the protocol was sent by a case above (those of the target's services).
  it('every request of the protocol has its case', async () => {
    assert.deepEqual((Object.keys(REQUESTS) as RequestType[]).filter((type) => !sent.has(type) && !(serviceOf(type) && !services.has(serviceOf(type)!))), []);
  });
}
