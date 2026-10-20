// npm run costs:record [-- --dry-run]: appends to the ledger of what paid AI services charge
// (ai-costs/, docs/decisions.md D36) the requests the service's history has that the ledger lacks, then
// generates the averages again (npm run gen's cost-ledger.generated.ts). A tool for Elabora's own
// experiments, run by us with our own key: authors never run it.
//
// ElevenLabs: GET /v1/history (reading it costs no credits; the text sent is in each item's dialogue,
// or text for older models), each item once (history_item_id); the credits billed are
// character_count_change_to − from; the plan is the one the account has now; GET /v1/models is read
// at that moment and its character_cost_multiplier and cost_discount_multiplier kept with each new
// request (observed), and said when they no longer match the current period: a new list price or a
// discount opens a period (ai-costs/README.md). The key is read from
// ~/.config/elabora-dev/elevenlabs-api-key (ELABORA_DEV_ELEVENLABS_KEY_FILE elsewhere) and never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costAverages, costKey, ledgerProblems, listCost, listPriceOf, periodsAt, priceSettings } from '@elabora/core/ai/costs';
import type { CostAverage, Measurement } from '@elabora/core/ai/costs';
import { aiCostsModule, LEDGER_DIR, OUTPUT, measurementLine, readLedger, readMeasurements } from './gen-ai-costs.ts';

interface HistoryItem {
  history_item_id: string; model_id: string | null; voice_id: string | null; text: string | null; date_unix: number;
  character_count_change_from: number; character_count_change_to: number; state?: string; source?: string;
  settings?: Record<string, unknown> | null; output_format?: string | null;
  dialogue?: { text: string; voice_id: string }[] | null;
}
interface ModelRates { character_cost_multiplier?: number; cost_discount_multiplier?: number }

export interface RecordResult { added: Measurement[]; skipped: string[]; warnings: string[]; problems: string[] }

// A share this far from the current period's average asks whether the price changed.
const DRIFT = 0.1;

export async function recordElevenLabs(options: { ledgerDir?: string; keyFile?: string; baseUrl?: string; now?: Date; dryRun?: boolean } = {}): Promise<RecordResult> {
  const dir = options.ledgerDir ?? LEDGER_DIR;
  const keyFile = options.keyFile ?? process.env.ELABORA_DEV_ELEVENLABS_KEY_FILE ?? path.join(os.homedir(), '.config/elabora-dev/elevenlabs-api-key');
  const base = (options.baseUrl ?? process.env.ELABORA_ELEVENLABS_URL ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const now = options.now ?? new Date();
  let key: string;
  try { key = fs.readFileSync(keyFile, 'utf8').trim(); } catch { throw new Error(`No ElevenLabs key in ${keyFile}.`); }
  const get = async <T>(route: string): Promise<T> => {
    const answer = await fetch(`${base}${route}`, { headers: { 'xi-api-key': key } });
    if (!answer.ok) throw new Error(`GET ${route.split('?')[0]}: HTTP ${answer.status}`);
    return await answer.json() as T;
  };

  const ledger = readLedger(path.join(dir, 'periods.json'));
  const measurementsFile = path.join(dir, 'measurements.jsonl');
  const measurements = readMeasurements(measurementsFile);
  const known = new Set(measurements.filter((m) => m.provider === 'elevenlabs').map((m) => m.source?.id));
  const plan = (await get<{ subscription: { tier: string } }>('/v1/user')).subscription.tier.toLowerCase();
  const models = Object.fromEntries((await get<{ model_id: string; model_rates?: ModelRates }[]>('/v1/models')).map((m) => [m.model_id, m.model_rates ?? {}])) as Record<string, ModelRates>;

  // The history, newest first, until a page holds nothing new.
  const items: HistoryItem[] = [];
  let after: string | null = null;
  for (;;) {
    const query = new URLSearchParams({ page_size: '100' });
    if (after) query.set('start_after_history_item_id', after);
    const page = await get<{ history: HistoryItem[]; has_more: boolean; last_history_item_id?: string | null }>(`/v1/history?${query}`);
    const fresh = page.history.filter((item) => !known.has(item.history_item_id));
    for (const item of fresh) known.add(item.history_item_id);
    items.push(...fresh);
    if (!page.has_more || !fresh.length || !page.last_history_item_id || page.last_history_item_id === after) break;
    after = page.last_history_item_id;
  }

  const voiceRates = new Map<string, number | null>();
  const voiceRate = async (voice: string): Promise<number | null> => {
    if (!voiceRates.has(voice)) {
      try { voiceRates.set(voice, (await get<{ sharing?: { rate?: number | null } | null }>(`/v1/voices/${encodeURIComponent(voice)}`)).sharing?.rate ?? 1); } catch { voiceRates.set(voice, null); }
    }
    return voiceRates.get(voice)!;
  };

  const added: Measurement[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  for (const item of items.sort((a, b) => a.date_unix - b.date_unix)) {
    const turns = item.dialogue?.length ? item.dialogue : item.text !== null && item.text !== undefined ? [{ text: item.text, voice_id: item.voice_id ?? '' }] : [];
    if ((item.source && item.source !== 'TTS') || !item.model_id) { skipped.push(`${item.history_item_id}: ${item.source ?? 'no source'}${item.model_id ? '' : ', no model'}, not text to speech`); continue; }
    if (!turns.length) { skipped.push(`${item.history_item_id}: the history keeps no text, so no characters to count`); continue; }
    const characters = turns.reduce((sum, turn) => sum + turn.text.length, 0);
    const voices = [...new Set(turns.map((turn) => turn.voice_id).filter(Boolean))].sort();
    // A library voice priced above 1 multiplies the list price: the characters-weighted rate.
    let weighted = 0;
    let rateKnown = true;
    for (const turn of turns) {
      const rate = turn.voice_id ? await voiceRate(turn.voice_id) : 1;
      if (rate === null) rateKnown = false;
      weighted += turn.text.length * (rate ?? 1);
    }
    const rate = characters ? Math.round((weighted / characters) * 1000) / 1000 : 1;
    if (!rateKnown) warnings.push(`${item.history_item_id}: a voice could not be read, its rate taken as 1`);
    const date = new Date(item.date_unix * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    const model = models[item.model_id] ?? {};
    const settings: Record<string, unknown> = { ...(item.settings ?? {}), ...(item.output_format ? { output_format: item.output_format } : {}), voices, turns: turns.length, ...(rate !== 1 ? { voice_rate: rate } : {}) };
    const [period] = periodsAt(ledger.periods, 'elevenlabs', item.model_id, plan, item.date_unix * 1000);
    added.push({
      provider: 'elevenlabs', model: item.model_id, kind: turns.length > 1 ? 'dialogue' : 'speech', plan, date, settings,
      sent: { characters }, billed: { credits: item.character_count_change_to - item.character_count_change_from },
      period: period?.id ?? null, source: { kind: 'GET /v1/history', id: item.history_item_id },
      observed: { at: now.toISOString().replace(/\.\d+Z$/, 'Z'), ...(model.character_cost_multiplier === undefined ? {} : { character_cost_multiplier: model.character_cost_multiplier }), ...(model.cost_discount_multiplier === undefined ? {} : { cost_discount_multiplier: model.cost_discount_multiplier }) },
      note: `plan read when recorded`
    });
  }

  // What the service says now against the current periods: a new list price, a discount.
  for (const [id, rates] of Object.entries(models)) {
    const [current] = periodsAt(ledger.periods, 'elevenlabs', id, plan, now.getTime());
    if (typeof rates.cost_discount_multiplier === 'number' && rates.cost_discount_multiplier !== 1 && !current?.discount) warnings.push(`${id}: GET /v1/models says cost_discount_multiplier ${rates.cost_discount_multiplier}: a discount the current period does not have; open a period with it`);
    const price = current && listPriceOf(current, {});
    if (price && typeof rates.character_cost_multiplier === 'number' && Math.abs((price.rates.characters ?? 0) / (price.per ?? 1) - rates.character_cost_multiplier) > 1e-9) warnings.push(`${id}: GET /v1/models says ${rates.character_cost_multiplier} credits a character, the period ${current.id} ${price.rates.characters}: a new list price; end that period and open another`);
  }
  const all = [...measurements, ...added];
  const averages = new Map<string, CostAverage>(costAverages(ledger, measurements).map((a) => [a.key, a]));
  for (const m of added) {
    if (!m.period) { warnings.push(`${m.source.id} (${m.model}, ${m.plan}, ${m.date}): no price period holds it; add one to ai-costs/periods.json, then npm run gen`); continue; }
    const period = ledger.periods.find((p) => p.id === m.period)!;
    const average = averages.get(costKey(period.id, priceSettings(ledger.providers.elevenlabs, m.kind, m.settings)));
    const list = listCost(ledger, period, m);
    if (average && list && list >= 20 && Math.abs(m.billed.credits / list - average.share) > DRIFT * average.share) warnings.push(`${m.source.id} (${m.model}, ${m.date}): billed ${m.billed.credits} credits for ${list} at list price (${(m.billed.credits / list).toFixed(3)}), the period's average is ${average.share}: a discount or a new price? If so, open a period`);
  }

  const problems = ledgerProblems(ledger, all);
  if (!options.dryRun && added.length) {
    fs.appendFileSync(measurementsFile, added.map((m) => `${measurementLine(m)}\n`).join(''));
  }
  return { added, skipped, warnings, problems };
}

function summary(result: RecordResult, dryRun: boolean): string {
  const lines = [`${dryRun ? 'Would add' : 'Added'} ${result.added.length} request(s) of ElevenLabs to ai-costs/measurements.jsonl.`];
  for (const m of result.added) lines.push(`  ${m.date} ${m.model} ${m.kind}: ${m.sent.characters} characters, ${m.billed.credits} credits (${m.period ?? 'no period'})`);
  if (result.skipped.length) lines.push(`Skipped:\n  ${result.skipped.join('\n  ')}`);
  if (result.warnings.length) lines.push(`To look at:\n  ${result.warnings.join('\n  ')}`);
  return lines.join('\n');
}

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const result = await recordElevenLabs({ dryRun });
    console.log(summary(result, dryRun));
    if (result.problems.length) {
      console.error(`The ledger has problems, the averages were not generated:\n  ${result.problems.join('\n  ')}`);
      process.exit(1);
    }
    if (!dryRun) {
      fs.writeFileSync(OUTPUT, aiCostsModule());
      console.log(`Wrote ${path.relative(path.dirname(LEDGER_DIR), OUTPUT)}`);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
