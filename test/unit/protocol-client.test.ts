import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolClient, ProtocolRequestError } from '@elabora/engine/protocol';
import type { RequestMessage } from '@elabora/engine/protocol';

// The app's side of the engine's protocol when the connection goes (the module closed, the engine
// stopped): every request still waiting is rejected as closed, later requests at once, and an answer
// that comes after is ignored.

const closedError = (error: unknown) => error instanceof ProtocolRequestError && error.kind === 'closed';

test('closing the client rejects the requests in flight and every later one', async () => {
  const sent: RequestMessage[] = [];
  const client = new ProtocolClient((message) => sent.push(message));
  const summary = client.request('summary', {});
  const history = client.request('history', { limit: 10 });
  client.close('The module closed.');
  await assert.rejects(summary, closedError);
  await assert.rejects(history, (error: unknown) => closedError(error) && (error as Error).message === 'The module closed.');
  // An answer after the close changes nothing; a new request is refused without being sent.
  client.receive({ kind: 'response', id: sent[0]!.id, type: 'summary', ok: true, result: {} as never });
  await assert.rejects(client.request('summary', {}), closedError);
  assert.equal(sent.length, 2);
  assert.equal(client.closed, true);
  // Closing twice is closing once.
  client.close();
});

test('a transport that cannot send any more rejects the request instead of leaving it waiting', async () => {
  const client = new ProtocolClient(() => { throw new Error('port closed'); });
  await assert.rejects(client.request('summary', {}), closedError);
});
