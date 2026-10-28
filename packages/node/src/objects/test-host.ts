// Host page used by `elabora object test`: the same host code as the player, in test mode.
import { createObjectHost } from '@elabora/player/object-host';
import type { HostCall, HostDefinition, HostFont, HostStarted, SafeArea } from './host-api.ts';
import type { ObjectTestContext, ObjectTestView } from '@elabora/format';

// The player's object host, as this page uses it.
interface TestHostOptions {
  iframe: HTMLIFrameElement;
  def: HostDefinition;
  props: Record<string, unknown>;
  strings: Record<string, string>;
  tokens: Record<string, string | number>;
  fonts: HostFont[];
  locale: string;
  reducedMotion: boolean;
  savedState: unknown;
  safeArea: SafeArea | null;
  decorative: boolean;
  context: ObjectTestContext | null;
  view: ObjectTestView | null;
  seed: number;
  testMode: boolean;
  baseUrl: string;
  onEvent(name: string, payload: unknown): void;
  onError(message: string): void;
  onReady(): void;
  onLog(entry: { message: string }): void;
}

interface TestHost {
  step(frames: number): Promise<unknown>;
  getState(): Promise<unknown>;
  setState(state: Record<string, unknown>): Promise<unknown>;
  updateProps(props: Record<string, unknown>): void;
  carryOn(props: Record<string, unknown>, transition: { from: { screen: string; block: string }; to: { screen: string; block: string }; direction: 'forward' | 'back'; duration: number; reducedMotion: boolean }, extra: { safeArea?: Partial<SafeArea> }): void;
  setContext(context: ObjectTestContext): void;
  setSafeArea(area: SafeArea): void;
  setView(view: ObjectTestView): void;
  testClick(target: { object: string } | { at: [number, number] | undefined }): Promise<unknown>;
  testKey(key: string): Promise<unknown>;
  testDry(dry: boolean, drawOffscreen: boolean): Promise<unknown>;
  perf(): Promise<unknown>;
  dispose(): void;
}

// The player's object host is not typed in this branch: its option types are inferred from their
// defaults (fonts: never[], context: null). It is called through the signature this page relies on.
const createHost = createObjectHost as unknown as (options: TestHostOptions) => TestHost;

let host: TestHost | null = null;
let reduced = false;
window.__events = [];
window.__startHost = ({ def, props, strings, tokens, fonts, language, seed, reducedMotion, savedState, safeArea, decorative, context, view }) => new Promise<HostStarted>((resolve) => {
  reduced = !!reducedMotion;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('allow', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.title = def.id;
  iframe.src = `${def.dir}/frame.html`;
  const timer = setTimeout(() => resolve({ ok: false, error: 'timeout: the object never answered object/initialize (see console errors)' }), 15000);
  host = createHost({
    iframe, def, props, strings, tokens, fonts: fonts || [], locale: language, reducedMotion, savedState, safeArea, decorative, context, view, seed, testMode: true, baseUrl: '',
    onEvent: (name, payload) => window.__events.push({ name, payload }),
    onError: (message) => { clearTimeout(timer); console.error(`[object] ${message}`); resolve({ ok: false, error: message }); },
    onReady: () => { clearTimeout(timer); resolve({ ok: true }); },
    onLog: (entry) => console.warn(`[object] ${entry.message}`)
  });
  const box = document.getElementById('box');
  if (!box) throw new Error('the test page has no #box');
  box.appendChild(iframe);
});
// The events received once the frame has answered a request. Messages between two windows keep
// their order, so the events the frame sent before its answer are in the list: those of every
// earlier step, notifications (set-props, set-view…) included, and of what they ran at once.
// object/perf is the request: it reads the renderer's counters, runs no frame and leaves virtual
// time alone.
window.__settle = async () => {
  if (!host) throw new Error('host not started');
  await host.perf();
  return window.__events;
};
window.__call = (call: HostCall) => {
  if (!host) throw new Error('host not started');
  switch (call.method) {
    case 'step': return host.step(call.frames);
    case 'getState': return host.getState();
    case 'setState': return host.setState(call.state);
    case 'updateProps': return host.updateProps(call.props);
    // A block of another screen gives way to this one (D65): a test names no screens.
    case 'carryOn': return host.carryOn(call.props, { from: { screen: 'before', block: 'before' }, to: { screen: 'test', block: 'test' }, direction: call.direction, duration: reduced ? 0 : call.duration, reducedMotion: reduced }, call.safeArea ? { safeArea: call.safeArea } : {});
    case 'setContext': return host.setContext(call.context);
    case 'setSafeArea': return host.setSafeArea(call.safeArea);
    case 'setView': return host.setView(call.view);
    case 'testClick': return host.testClick(call.target);
    case 'testKey': return host.testKey(call.key);
    case 'testDry': return host.testDry(call.dry, call.drawOffscreen);
    case 'perf': return host.perf();
    case 'dispose': return host.dispose();
  }
};
