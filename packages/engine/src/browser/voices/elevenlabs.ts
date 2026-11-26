// ElevenLabs in a browser's session (D29): the core's provider, given the page that holds the author's
// key as its way to the service (keys.elabora.studio, browser/keys/). The window frames that page and
// gives this session a port to it (voiceKeyPort); every operation goes through it, and the key never
// comes here: the page answers with ElevenLabs' answer, and says whether it holds a key and how it is
// shown. What was asked once this session is answered again from memory, the takes being kept anyway
// (takes.ts). The page cannot read what ElevenLabs charged (it does not show it to pages): the
// expected charge is counted instead.

import { createElevenLabs } from '@elabora/core/voice/elevenlabs/provider';
import type { ElevenLabs, ElevenLabsHost } from '@elabora/core/voice/elevenlabs/provider';
import { failure } from '@elabora/core/voice/elevenlabs/answers';
import type { SpeechAnswer } from '@elabora/core/voice/elevenlabs/answers';
import { QuotaCount } from '@elabora/core/voice/elevenlabs/quota';
import type { ElevenOp } from '@elabora/core/voice/elevenlabs/requests';
import type { OwnCharge } from '@elabora/core/ai/costs';
import { VoiceError } from '@elabora/core/voice/provider';

const VERSION = 1;
const NEW_KEY = '« Clé ElevenLabs »';

interface KeyState { present: boolean; masked: string | null; kept: boolean }
type Answer = { ok: true; status: number; body?: unknown; bytes?: ArrayBuffer; cost: number | null; key?: KeyState } | { ok: false; code: string; message: string };

export class BrowserElevenLabs {
  #port: MessagePort | null = null;
  #state: KeyState = { present: false, masked: null, kept: false };
  #next = 0;
  readonly #waiting = new Map<number, (answer: Answer) => void>();
  readonly #generations = new Map<string, SpeechAnswer>();
  readonly #charges: OwnCharge[] = [];
  readonly #rates = new Map<string, number>();
  readonly elevenLabs: ElevenLabs;

  constructor() {
    const host: ElevenLabsHost = {
      key: () => (this.#port && this.#state.present && this.#state.masked ? { id: this.#state.masked, masked: this.#state.masked, source: 'app' } : null),
      missing: () => new VoiceError('E_VOICE_KEY_MISSING', `No ElevenLabs key in this browser: add it in ${NEW_KEY}.`),
      call: async <T>(op: ElevenOp, params: Record<string, unknown>, { what }: { what: string }) => {
        const answer = await this.#ask(op, params);
        if (!answer.ok) throw new VoiceError(answer.code, answer.message);
        if (answer.status >= 400) throw failure(answer.status, typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? ''), what, { newKey: NEW_KEY });
        return { body: answer.body as T, cost: answer.cost };
      },
      cache: {
        get: async (op, params) => this.#generations.get(`${op}\0${JSON.stringify(params)}`) ?? null,
        put: async (op, params, answer) => { this.#generations.set(`${op}\0${JSON.stringify(params)}`, answer); }
      },
      charges: () => this.#charges,
      recordCharge: (charge) => { this.#charges.push(charge); this.#charges.splice(0, this.#charges.length - 200); },
      voiceRate: (voice) => this.#rates.get(voice) ?? null,
      rememberVoiceRate: (voice, rate) => { if (typeof rate === 'number' && rate > 0) this.#rates.set(voice, rate); },
      quota: new QuotaCount()
    };
    this.elevenLabs = createElevenLabs(host);
  }

  // The port to the key's page, which the window transferred: the one before it, if any, is closed.
  connect(port: MessagePort): void {
    this.#port?.close();
    for (const resolve of this.#waiting.values()) resolve({ ok: false, code: 'E_VOICE_SERVICE', message: 'The key\'s page was replaced.' });
    this.#waiting.clear();
    this.#port = port;
    port.onmessage = ({ data }) => {
      if (data?.v !== VERSION) return;
      if (data.kind === 'key') { this.#state = data.key as KeyState; return; }
      const resolve = this.#waiting.get(data.id);
      if (!resolve) return;
      this.#waiting.delete(data.id);
      if (data.key) this.#state = data.key as KeyState;
      resolve(data as Answer);
    };
    port.start();
  }

  // The key forgotten by its page (setVoiceKey { key: null }).
  async forget(): Promise<void> {
    if (!this.#port) return;
    const answer = await this.#ask('forgetKey', {});
    if (!answer.ok) throw new VoiceError(answer.code, answer.message);
  }

  close(): void {
    this.#port?.close();
    this.#port = null;
  }

  #ask(op: string, params: Record<string, unknown>): Promise<Answer> {
    const port = this.#port;
    if (!port) return Promise.resolve({ ok: false, code: 'E_VOICE_KEY_MISSING', message: `No ElevenLabs key in this browser: add it in ${NEW_KEY}.` });
    const id = ++this.#next;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      port.postMessage({ v: VERSION, id, op, params });
    });
  }
}
