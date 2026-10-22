import { listVoices, voiceProvider, voiceProviders, generateNarration, estimateNarration, setSpeakerVoice, voiceTakes } from '@elabora/node/voice/index';
import type { VoiceEstimate, VoiceQuery } from '@elabora/node/voice/index';
import { defineTool, errorResult, objectSchema, SLUG, textResult } from './tool.ts';

// Generated narration (docs/decisions.md D25, D29): the voices, a speaker's voice, the lines said by it.
// The model of a language's local voices is downloaded once per computer, on first use. ElevenLabs
// voices spend the author's quota, told as a share of the month's (D30): under 1 % of it an agent
// generates without asking; from 1 %, it tells the author the share, asks, and passes the share
// approved (approvedPercent); without it the generation is refused with the estimate.

const LANGUAGE = { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$', description: 'A language of the course or of one of its translations (default: the course language).' } as const;

const failure = (error: unknown) => errorResult({ error: error instanceof Error ? error.message : String(error), ...(error && typeof error === 'object' && 'code' in error ? { code: (error as { code: unknown }).code } : {}) });

export const listVoicesTool = defineTool({
  name: 'elabora_voice_list',
  readOnly: true,
  description: 'The voices a narration line can be generated with: id (what course.json speakers[].voices[<lang>].voice names), name, gender, register and pace, the licence of the recording it was made from, and whether its model is on this computer (installed) or the size downloaded on first use. Generated voices are marked as such in their files and in the module credits (AI Act). Choose one per speaker with elabora_voice_set.',
  inputSchema: objectSchema({ language: { ...LANGUAGE, description: 'Only the voices speaking this language.' } }),
  handler(args) {
    return textResult({ voices: listVoices(args.language).map((voice) => ({ ...voice, ...(voiceProvider(voice.provider).status(voice.language) ?? {}) })) });
  }
});

export const setVoiceTool = defineTool({
  name: 'elabora_voice_set',
  description: 'The voice of a speaker (course.json speakers[]) in a language: speakers[].voices[<lang>] = { provider, voice, name, settings }, its settings kept unless given. Lines of that speaker made with another voice become out of date (W_NARRATION_AUDIO_STALE): elabora_voice_generate makes them again. One undoable change. An ElevenLabs voice (elabora_voice_search): provider "elevenlabs", its name, and settings { model (eleven_v4 by default, the one that plays stage directions), stability, similarity (0 to 1; lower stability: more expressive) }. Choosing a voice costs nothing.',
  inputSchema: objectSchema({
    speaker: SLUG, voice: { type: 'string', description: 'A voice id from elabora_voice_list or elabora_voice_search.' }, language: LANGUAGE,
    provider: { type: 'string', description: 'The voice\'s provider when its id alone is not enough: "elevenlabs".' },
    name: { type: 'string', maxLength: 120, description: 'An ElevenLabs voice\'s name, as elabora_voice_search gave it.' },
    settings: { type: 'object', description: 'ElevenLabs: { model?: "eleven_v4" | "eleven_v4_turbo" | "eleven_v3", stability?: 0–1, similarity?: 0–1 }. Replaces the voice\'s settings.' }
  }, ['speaker', 'voice']),
  async handler(args, { root, author }) {
    try {
      const change = await setSpeakerVoice(root, { speaker: args.speaker, voice: args.voice, ...(args.language ? { language: args.language } : {}), ...(args.provider ? { provider: args.provider } : {}), ...(args.name ? { name: args.name } : {}), ...(args.settings ? { settings: args.settings as Record<string, unknown> } : {}) }, { author });
      return textResult({ ok: true, speaker: args.speaker, voice: args.voice, change, ...(change === null ? { note: 'unchanged' } : { undo: `elabora_undo { change: ${change} }` }) });
    } catch (error) { return failure(error); }
  }
});

export const generateVoiceTool = defineTool({
  name: 'elabora_voice_generate',
  description: 'Generates the narration lines of a screen with their speaker\'s voice (course.json speakers[].voices[<lang>]): by default the lines whose audio is missing or out of date (W_NARRATION_AUDIO_MISSING, W_NARRATION_AUDIO_STALE); lines: those; all: every line. Each generation is a new take, written to assets/narration/<lang>/<screen>/<line>.m4a with its sidecar (generated voice, take, credit for the module credits): one undoable change per line. The text said is the line\'s, after the pronunciations of the line and of the course (course.json pronunciations { "<lang>": [{ text, say }] }: add one when a word is said wrong, then generate again). voice: set that voice for the speaker of the lines first. take: put back an earlier take of one line (elabora_voice_takes). Local voices are free: the first use of a language downloads its model once (fr 354 MB, en 126 MB); a line takes a few seconds. ElevenLabs voices spend the author\'s monthly quota, which Elabora always says as a share of it, never in credits: under 1 % of the quota (a line is about 0.07 % of a Starter plan; a screen of a few lines is under it, a long script is not: elabora_voice_estimate says) generate without asking. From 1 % the call spends nothing and returns needsApproval with the estimate: tell the author « ~N % of your monthly ElevenLabs quota » (estimate.percent), ASK them, and only with their agreement call again with approvedPercent: N. A generation stops by itself if the service charges far more than allowed (overBudget). A line out of date gets back an earlier take of the same text, voice and delivery at no cost. dialogue: lines of several ElevenLabs speakers that follow each other in a step are said as one exchange (turns, interruptions written with « — »), then cut into lines, the pauses between them taken from it. Stage directions in square brackets in a line ([chuchote], [rit], [un temps]) are played by Eleven v4 and never shown nor counted as words.',
  inputSchema: objectSchema({
    screen: SLUG,
    lines: { type: 'array', items: SLUG, description: 'Line ids (narration.lines[].id). Default: those missing or out of date.' },
    all: { type: 'boolean', description: 'Every line of the screen, a new take each.' },
    voice: { type: 'string', description: 'Set this voice (elabora_voice_list) for the speaker of the lines first.' },
    language: LANGUAGE,
    take: { type: 'integer', minimum: 1, description: 'Put back this take of one line (with lines: [id]).' },
    dialogue: { type: 'boolean', description: 'Say runs of a step\'s lines by several ElevenLabs speakers as one exchange (the whole run again).' },
    approvedPercent: { type: 'number', minimum: 0, maximum: 100, description: 'The share of their monthly quota, in percent, the author agreed to spend after you told them the estimate\'s percent. Only needed from 1 %; never set it without asking.' }
  }, ['screen']),
  async handler(args, { root, author }) {
    try {
      const result = await generateNarration(root, {
        screen: args.screen, ...(args.lines ? { lines: args.lines } : {}), all: !!args.all, ...(args.voice ? { voice: args.voice } : {}),
        ...(args.language ? { language: args.language } : {}), ...(args.take !== undefined ? { take: args.take } : {}),
        dialogue: !!args.dialogue, ...(typeof args.approvedPercent === 'number' ? { approvedPercent: args.approvedPercent } : {})
      }, { author });
      return textResult({ ok: true, ...result, ...(result.changes.length ? { undo: `elabora_undo { change: <seq> } for each line (${result.changes.join(', ')})` } : {}) });
    } catch (error) {
      const estimate = error && typeof error === 'object' && 'code' in error && error.code === 'E_VOICE_SPEND' ? (error as { estimate?: VoiceEstimate }).estimate : undefined;
      if (estimate) return textResult({ ok: false, needsApproval: true, estimate, ask: `Ask the author: generating these ${estimate.lines.filter((line) => line.credits).length} lines uses ~${estimate.percent ?? '?'} % of their monthly ElevenLabs quota. Say it as a share of their quota, never in credits. With their agreement, call again with approvedPercent: ${estimate.percent ?? '<percent>'}.` });
      return failure(error);
    }
  }
});

export const estimateVoiceTool = defineTool({
  name: 'elabora_voice_estimate',
  readOnly: true,
  description: 'What elabora_voice_generate would make and cost, spending nothing: per line its voice, characters and credits (about, and at most: the list price), the lines a local voice makes free, those given back an earlier take, and the runs said as one exchange (dialogue); in total, the share of the author\'s monthly ElevenLabs quota (percent) and whether that needs their approval (needsApproval: from 1 %). Speak to the author in shares of their quota, never in credits; under 1 % generate without asking.',
  inputSchema: objectSchema({
    screen: SLUG,
    lines: { type: 'array', items: SLUG },
    all: { type: 'boolean' },
    dialogue: { type: 'boolean' },
    language: LANGUAGE
  }, ['screen']),
  async handler(args, { root }) {
    try {
      return textResult(await estimateNarration(root, { screen: args.screen, ...(args.lines ? { lines: args.lines } : {}), all: !!args.all, dialogue: !!args.dialogue, ...(args.language ? { language: args.language } : {}) }));
    } catch (error) { return failure(error); }
  }
});

export const searchVoicesTool = defineTool({
  name: 'elabora_voice_search',
  readOnly: true,
  description: 'Searches ElevenLabs voices (needs the author\'s key): the account\'s own voices, then the library\'s thousands, most used first. Each has its id, name, language (its accent: any voice speaks every language of Eleven v4), gender, accent, age, use case, a preview URL to hear it free, rate (2: twice the credits), quality (high: a professional clone that passed ElevenLabs\' quality check; professional, premade, designed, instant, iconic) and models: by model, the languages ElevenLabs checked the voice speaks well with it, or "failed" when its training for that model failed; a model not named was not trained for it (it still speaks, less like the voice and less expressive). Prefer voices whose models.eleven_v4 (the default model) includes the course\'s language. Propose two or three to the author with their previews; set the chosen one with elabora_voice_set { provider: "elevenlabs", name }. Free: it spends no credits.',
  inputSchema: objectSchema({
    text: { type: 'string', description: 'Words of its name or description (calm narrator, support agent…).' },
    language: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$' },
    gender: { enum: ['female', 'male', 'neutral'] },
    age: { enum: ['young', 'middle_aged', 'old'] },
    accent: { type: 'string', description: 'parisian, quebec, standard, british, american…' },
    useCase: { type: 'string', description: 'narrative_story, conversational, informative_educational, characters_animation, advertisement…' },
    scope: { enum: ['all', 'account', 'library'] },
    quality: { enum: ['high'], description: 'Only professional clones that passed ElevenLabs\' quality check.' },
    readyFor: { type: 'string', description: 'Only voices ElevenLabs checked with this model (eleven_v4) in the language. With quality "high": the best voices for that model.' },
    page: { type: 'integer', minimum: 0 }
  }),
  async handler(args) {
    try {
      const query: VoiceQuery = { provider: 'elevenlabs', ...(args as Omit<VoiceQuery, 'provider'>), pageSize: 20 };
      const result = await voiceProvider('elevenlabs').search!(query);
      return textResult({ ...result, voices: result.voices.map(({ credit: _credit, source: _source, ...voice }) => voice) });
    } catch (error) { return failure(error); }
  }
});

export const voiceAccountTool = defineTool({
  name: 'elabora_voice_account',
  readOnly: true,
  description: 'The author\'s ElevenLabs plan and quota: the share used this month (usedPercent; speak to the author in shares, never in credits), when it renews, what a line costs of it (linePercent), whether the plan allows commercial use and the voice library, and the key masked (never the key). check: tries each permission Elabora needs (Text to Speech, Voices: read, User: read) without spending.',
  inputSchema: objectSchema({ check: { type: 'boolean' } }),
  async handler(args) {
    try { return textResult(await voiceProvider('elevenlabs').account!({ check: !!args.check })); } catch (error) { return failure(error); }
  }
});

export const voiceTakesTool = defineTool({
  name: 'elabora_voice_takes',
  readOnly: true,
  description: 'The takes of a generated narration line kept on this computer (never in the course): which one is the line\'s audio (current), which can be put back with elabora_voice_generate { take } (usable: same text, voice and delivery).',
  inputSchema: objectSchema({ screen: SLUG, line: SLUG, language: LANGUAGE }, ['screen', 'line']),
  handler(args, { root }) {
    try {
      const result = voiceTakes(root, { screen: args.screen, line: args.line, ...(args.language ? { language: args.language } : {}) });
      return textResult({ language: result.language, takes: result.takes.map(({ file: _file, ...take }) => take) });
    } catch (error) { return failure(error); }
  }
});

export const installVoiceTool = defineTool({
  name: 'elabora_voice_install',
  description: 'Downloads the model of a language\'s local voices once for this computer (fr 354 MB, en 126 MB; checked, resumable). elabora_voice_generate does it on first use too: call this first when a long call would time out. force: removes it first and downloads it again (a reinstall, refused as elabora_download_uninstall is).',
  inputSchema: objectSchema({ language: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$' }, force: { type: 'boolean' } }, ['language']),
  async handler(args) {
    try {
      const providers = voiceProviders().filter((provider) => !provider.paid && provider.status(args.language));
      if (!providers.length) return errorResult({ error: `No voice speaks ${args.language}.` });
      for (const provider of providers) await provider.install(args.language, { force: !!args.force });
      return textResult({ ok: true, language: args.language, providers: providers.map((provider) => ({ id: provider.id, ...provider.status(args.language) })) });
    } catch (error) { return failure(error); }
  }
});
