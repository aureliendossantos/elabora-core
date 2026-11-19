import { failures, type DrawOptions } from './convergence.ts';

// The convergence bench in a browser's Worker (test/e2e/sync-convergence-browser.test.ts): each message
// is a run, answered with what its draws found wrong, or the error that stopped it.
const scope = self as unknown as { onmessage: ((event: { data: { seeds: number[]; options: DrawOptions } }) => void) | null; postMessage(message: unknown): void };
scope.onmessage = ({ data }) => {
  try {
    scope.postMessage({ failures: failures(data.seeds, data.options) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  }
};
