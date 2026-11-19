import { readProjectFiles } from '@elabora/node/project-reader';
import { openCopy } from '@elabora/engine/browser/session';
import { memoryCopy } from '@elabora/engine/browser/store';
import type { RoomSocket } from '@elabora/engine/base/session-cloud';
import type { EventMessage, ResponseMessage } from '@elabora/engine/protocol';
import { engineConformance, type ConformanceTarget, type Sample } from '../conformance/engine.ts';
import { EXAMPLE, BILINGUAL, NETWORK_SAMPLE } from '../helpers.ts';

// The engine's protocol (test/conformance/engine.ts) played against a browser engine's session
// (D103) under Node: a copy of the sample as the room would give it, kept in memory, offline (its room
// never answers), without any service: every case of a service is skipped, and the case of a
// service not here judges them.

const SAMPLES: Record<Sample, string> = { network: NETWORK_SAMPLE, basic: EXAMPLE, bilingual: BILINGUAL };

// A room that never answers: the copy keeps its changes waiting.
const offline = (): RoomSocket => ({ readyState: 0, send() {}, close() {}, addEventListener() {} });

const browser: ConformanceTarget = {
  name: 'browser (memory)',
  services: [],
  async open(sample, { services } = {}) {
    const { files } = readProjectFiles(SAMPLES[sample]);
    const store = memoryCopy({ link: { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 }, confirmed: files });
    const session = await openCopy({ id: `cloud:tm_test/prj_test`, store, api: 'http://localhost:1', connect: offline, ...(services ? { services } : {}) });
    const listeners: ((message: ResponseMessage | EventMessage) => void)[] = [];
    session.subscribe((message) => { for (const listener of listeners) listener(structuredClone(message)); });
    return {
      send(message) { void session.handle(structuredClone(message)).then((response) => { for (const listener of listeners) listener(structuredClone(response)); }); },
      receive(listener) { listeners.push(listener); },
      pick: (name) => name,
      saveAs: (name) => name,
      async dispose() { await session.close(); }
    };
  }
};

engineConformance(browser);
