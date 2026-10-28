// Host side of the free-object contract.
// The object runs in <iframe sandbox="allow-scripts"> without allow-same-origin: it has an opaque
// origin, no access to the course page, the LMS API, cookies or storage, and a CSP without
// network. It talks to the host with JSON-RPC 2.0 over postMessage. Because its origin is
// opaque, messages are addressed with targetOrigin "*" and authenticated by event.source.
// Only the host talks to the LMS. What the frame sends is untrusted: every field is checked.

import { validateData } from './data-schema.ts';
import { fieldOf, isRecord, rpcError } from './json.ts';
import type { JsonObject, JsonValue } from './json.ts';
import type { FontData, ObjectDefinition, ObjectEventDeclaration, TokenValues } from './course-data.ts';
import type { FontPayload, FrameMethod, FrameMethods, LogEntry, ObjectContext, ObjectTransition, ObjectView, SafeArea, TestClickTarget } from './object-protocol.ts';

// What the host reads of the object definition (the compiled course data, or the object test page).
export type ObjectHostDefinition = Pick<ObjectDefinition, 'dir'> & Partial<Pick<ObjectDefinition, 'objects' | 'events' | 'assets'>>;

export interface ObjectHostOptions {
  iframe: HTMLIFrameElement;
  def: ObjectHostDefinition;
  props: JsonObject;
  strings?: Record<string, string>;
  tokens: TokenValues;
  locale: string;
  reducedMotion: boolean;
  // The object's state saved for the learner (null: none).
  savedState?: unknown;
  // In px, or a function returning it when the frame initialises.
  safeArea?: Partial<SafeArea> | (() => SafeArea);
  // A backdrop decoration (still frames under reduced motion or on slow machines).
  decorative?: boolean;
  // For decorations: where the learner is (or a function returning it).
  context?: ObjectContext | null | (() => ObjectContext | null);
  // Where the frame is in the window when it starts (or a function returning it); default: in view.
  view?: ObjectView | null | (() => ObjectView | null);
  seed?: number;
  testMode?: boolean;
  // Prefix of package URLs (fonts, assets), for pages that do not sit at the package root.
  baseUrl?: string;
  fonts?: FontData[];
  // 1rem of the page in px (the object test page gives none: the frame keeps its own).
  rootSize?: number;
  // A declared event whose payload matches its schema; without a schema the payload is unchecked.
  onEvent?: (name: string, payload: unknown, declaration: ObjectEventDeclaration) => void;
  onError?: (message: string) => void;
  onReady?: (result: unknown) => void;
  onLog?: (entry: LogEntry) => void;
  // Height requested by the object (host.requestHeight), in px.
  onResize?: (height: number) => void;
}

export interface ObjectHost {
  // Events accepted so far.
  emitted: { name: string; payload: unknown }[];
  readonly ready: boolean;
  updateProps(props: JsonObject): void;
  // The block carries on from another screen (D65): the arriving block's props, words and safe area,
  // with the hint of the passage.
  carryOn(props: JsonObject, transition: ObjectTransition, extra?: { strings?: Record<string, string>; safeArea?: Partial<SafeArea> }): void;
  setRootSize(px: number): void;
  setSafeArea(area: Partial<SafeArea>): void;
  setContext(context: ObjectContext): void;
  setView(view: ObjectView): void;
  pause(): void;
  resume(): void;
  getState(): Promise<unknown>;
  setState(state: JsonValue): Promise<unknown>;
  step(frames: number): Promise<unknown>;
  perf(): Promise<unknown>;
  testClick(target: TestClickTarget): Promise<unknown>;
  testKey(key: string): Promise<unknown>;
  testDry(dry: boolean, drawOffscreen?: boolean): Promise<unknown>;
  dispose(): void;
}

let requestCount = 0;
// Embedded fonts are fetched once per page (same origin as the package) and sent to each frame.
const fontCache = new Map<string, Promise<ArrayBuffer | null>>();
function loadFonts(fonts: readonly FontData[] | undefined, baseUrl: string): Promise<FontPayload[]> {
  return Promise.all((fonts || []).map((font) => {
    const url = `${baseUrl}${font.src}`;
    let bytes = fontCache.get(url);
    if (!bytes) {
      bytes = fetch(url).then((response) => (response.ok ? response.arrayBuffer() : null)).catch(() => null);
      fontCache.set(url, bytes);
    }
    return bytes.then((data): FontPayload | null => (data ? { family: font.family, weight: font.weight, style: font.style, ...(font.unicodeRange ? { unicodeRange: font.unicodeRange } : {}), data: data.slice(0) } : null));
  })).then((list) => list.filter((font): font is FontPayload => font !== null));
}

export function createObjectHost({ iframe, def, props, strings = {}, tokens, locale, reducedMotion, savedState, safeArea, decorative = false, context = null, view = null, seed = 1, testMode = false, baseUrl = '', fonts = [], rootSize, onEvent, onError, onReady, onLog, onResize }: ObjectHostOptions): ObjectHost {
  const pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  let ready = false;
  let disposed = false;
  const queue: (() => void)[] = [];
  const emitted: { name: string; payload: unknown }[] = [];

  const post = (message: Record<string, unknown>, transfer?: Transferable[]) => {
    const target = iframe.contentWindow;
    if (!target || disposed) return;
    target.postMessage({ jsonrpc: '2.0', ...message }, '*', transfer || []);
  };
  // Requests and notifications wait for the frame to be initialised.
  const request = <M extends FrameMethod>(method: M, params: FrameMethods[M]) => new Promise<unknown>((resolve, reject) => {
    const id = `h${++requestCount}`;
    pending.set(id, { resolve, reject });
    const send = () => post({ id, method, params });
    if (ready || method === 'object/initialize') send();
    else queue.push(send);
  });
  const notify = <M extends FrameMethod>(method: M, params: FrameMethods[M]) => {
    const send = () => post({ method, params });
    if (ready) send(); else queue.push(send);
  };

  const onMessage = async (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || disposed) return;
    const message: unknown = event.data;
    if (!isRecord(message) || message.jsonrpc !== '2.0') return;
    const id = message.id;
    const answered = typeof id === 'string' ? pending.get(id) : undefined;
    if (typeof id === 'string' && answered && (('result' in message) || ('error' in message))) {
      pending.delete(id);
      if (message.error) answered.reject(rpcError(message.error)); else answered.resolve(message.result);
      return;
    }
    const params = message.params;
    switch (message.method) {
      case 'object/ready':
        loadFonts(fonts, baseUrl).then((fontData) => request('object/initialize', {
          props, strings, seed, locale, reducedMotion, tokens, testMode, rootSize, savedState: savedState ?? null,
          safeArea: (typeof safeArea === 'function' ? safeArea() : safeArea) || { top: 0, right: 0, bottom: 0, left: 0 },
          decorative, context: (typeof context === 'function' ? context() : context) || null,
          ...(view ? { view: (typeof view === 'function' ? view() : view) || undefined } : {}),
          objects: def.objects || [], fonts: fontData
        })).then((result) => {
          ready = true;
          for (const send of queue.splice(0)) send();
          onReady?.(result);
        }, (error: Error) => onError?.(error.message));
        break;
      case 'object/event': {
        const name = fieldOf(params, 'name');
        const sent = fieldOf(params, 'payload');
        const payload = sent === undefined ? {} : sent;
        const declaration = typeof name === 'string' ? def.events?.[name] : undefined;
        if (typeof name !== 'string' || !declaration) { onLog?.({ level: 'warn', message: `Undeclared event "${String(name)}" rejected` }); break; }
        const errors = declaration.payload ? validateData(declaration.payload, payload) : [];
        if (errors.length) { onLog?.({ level: 'warn', message: `Event "${name}" rejected: ${errors.join('; ')}` }); break; }
        emitted.push({ name, payload });
        onEvent?.(name, payload, declaration);
        break;
      }
      case 'object/asset': {
        const assetId = fieldOf(params, 'id');
        const asset = (def.assets || []).find((candidate) => candidate.id === assetId);
        if (!asset) { post({ id, error: { code: -32602, message: `Unknown asset ${String(assetId)}` } }); break; }
        try {
          const response = await fetch(`${baseUrl}${def.dir}/${asset.file}`);
          const data = await response.arrayBuffer();
          post({ id, result: { id: asset.id, type: asset.type, data } }, [data]);
        } catch (error) {
          post({ id, error: { code: -32000, message: `Asset ${asset.id} could not be loaded: ${(error as Error).message}` } });
        }
        break;
      }
      case 'object/error':
        onError?.(String(fieldOf(params, 'message') || 'error'));
        break;
      case 'object/resize': {
        const height = fieldOf(params, 'height');
        if (typeof height === 'number' && Number.isFinite(height)) onResize?.(height);
        break;
      }
      case 'object/log':
        if (isRecord(params)) onLog?.({ level: String(params.level), message: String(params.message) });
        break;
    }
  };
  window.addEventListener('message', onMessage);

  return {
    emitted,
    get ready() { return ready; },
    updateProps: (next) => notify('object/update-props', { props: next }),
    carryOn: (next, transition, extra = {}) => notify('object/update-props', { props: next, transition, ...(extra.strings ? { strings: extra.strings } : {}), ...(extra.safeArea ? { safeArea: extra.safeArea } : {}) }),
    setRootSize: (px) => notify('object/set-root-size', { rootSize: px }),
    setSafeArea: (area) => { if (ready) notify('object/safe-area', { safeArea: area }); },
    setContext: (where) => { if (ready) notify('object/context', { context: where }); },
    setView: (where) => { if (ready) notify('object/view', { view: where }); },
    pause: () => notify('object/pause', {}),
    resume: () => notify('object/resume', {}),
    getState: () => request('object/get-state', {}),
    setState: (state) => request('object/set-state', { state }),
    step: (frames) => request('object/step', { frames }),
    perf: () => request('object/perf', {}),
    testClick: (target) => request('object/test-click', target),
    testKey: (key) => request('object/test-key', { key }),
    testDry: (dry, drawOffscreen = false) => request('object/test-dry', { dry, drawOffscreen }),
    dispose() {
      if (disposed) return;
      try { post({ method: 'object/dispose', params: {} }); } catch { /* frame gone */ }
      disposed = true;
      window.removeEventListener('message', onMessage);
      for (const call of pending.values()) call.reject(new Error('disposed'));
      pending.clear();
    }
  };
}
