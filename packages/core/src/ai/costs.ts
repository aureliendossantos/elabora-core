// What paid AI services charge, as measured (docs/decisions.md D36): a ledger of requests and of
// price periods, the averages generated from it, and the share of its list price a request is
// expected to be charged. The same for every service: characters (a voice), tokens (a language
// model), images or seconds (a transcription) are units sent; credits or dollars are units billed.
//
//   ai-costs/measurements.jsonl   one measured request a line (provider, model, plan, date, units sent
//                                 and billed, the settings, the period, the source)
//   ai-costs/periods.json         the providers, and each model and plan's price periods: a new model
//                                 id, a new list price, a discount starting or ending opens a period
//   cost-ledger.generated.ts      the periods and the averages, generated (npm run gen), shipped
//
// An average is only ever used in its own period, the current one, and never counts on a discount:
// one running is taken off the figures (a discount ends without notice, D30). A period with too few
// measurements is told the list price; an older period's figures are never used, so a new model or
// a new price starts from the list price until it is measured.

export interface CostProvider {
  billed: string;                  // the unit it bills: 'credits', 'usd'
  priceSettings?: string[];        // the settings (or 'kind') that change what a request is charged
  listMultipliers?: string[];      // numeric settings the list price is multiplied by (a voice's rate)
  source?: string;
  note?: string;
}

// A list price: so much of the billed unit for `per` units sent (1 by default; 1,000,000 for tokens).
// `when`: the settings it is for (an image's size and quality); none, every request.
export interface ListPrice {
  when?: Record<string, unknown>;
  rates: Record<string, number>;
  per?: number;
}

// A discount on the list price while it runs: rate 0.725 bills 27.5 % of it; null, not known.
export interface Discount {
  rate: number | null;
  announcedEnd: string | null;     // ISO date, as announced (null: none announced)
  source: string;
}

export interface PricePeriod {
  id: string;                      // provider/model/plan/start, by convention
  provider: string;
  model: string;                   // the exact model id the service names
  plan: string;                    // the plan or tier it is for
  start: string | null;            // ISO date (null: before the first measurement, not known)
  end: string | null;              // ISO date, excluded (null: still running)
  list: ListPrice[];
  discount: Discount | null;
  source: string;
  note?: string;
}

export interface Measurement {
  provider: string;
  model: string;
  kind: string;                    // 'speech', 'dialogue', 'chat', 'image', 'transcription'…
  plan: string;
  date: string;                    // ISO date, UTC
  settings: Record<string, unknown>;
  sent: Record<string, number>;    // { characters: 78 }, { input_tokens: 1200, output_tokens: 300 }
  billed: Record<string, number>;  // { credits: 9 }, { usd: 0.0081 }
  period: string | null;           // the price period it belongs to
  source: { kind: string; id?: string; [more: string]: unknown };
  observed?: Record<string, unknown>; // what the service said of its prices at the time
  note?: string;
}

export interface CostLedger {
  providers: Record<string, CostProvider>;
  periods: PricePeriod[];
}

export interface CostAverage {
  key: string;
  provider: string;
  model: string;
  plan: string;
  settings: Record<string, unknown>;
  period: string;
  measurements: number;
  sent: Record<string, number>;
  list: number;                    // what the list price would have billed
  billed: number;                  // what was billed
  share: number;                   // billed / list, rounded up
  undiscounted: number | null;     // the share without the period's discount (null: its rate not known)
}

// What the estimate is shipped with: the periods and the averages (cost-ledger.generated.ts).
export interface CostBook extends CostLedger {
  averages: CostAverage[];
}

// A period's average is used from this many measurements.
export const MIN_MEASURED = 3;
// The author's own last requests of a key, kept apart (a rise is followed at once).
export const OWN_RECENT = 12;
// The author's own requests are believed from this many.
export const OWN_BELIEVED = 3;
// What the estimate adds to what the author's own requests say where the ledger has nothing (a quarter).
export const OWN_MARGIN = 1.25;
// An own request billed fewer list units than this is rounded too much to say a share (8 credits for 74 characters).
export const OWN_SMALLEST = 40;

const time = (iso: string | null, open: number): number => (iso === null ? open : Date.parse(iso));
const within = (period: PricePeriod, at: number): boolean => time(period.start, -Infinity) <= at && at < time(period.end, Infinity);
const up = (value: number): number => Math.ceil(value * 1e4 - 1e-9) / 1e4;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

// The settings of a request that change its price, as its key holds them.
export function priceSettings(provider: CostProvider | undefined, kind: string | undefined, settings: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const all: Record<string, unknown> = { kind, ...settings };
  return Object.fromEntries((provider?.priceSettings ?? []).filter((name) => all[name] !== undefined).sort().map((name) => [name, all[name]]));
}

// An average's key: its period, and its price settings when it has any.
export const costKey = (period: string, settings: Readonly<Record<string, unknown>>): string =>
  Object.keys(settings).length ? `${period} ${canonical(settings)}` : period;

// The periods of a model and plan that hold a date.
export const periodsAt = (periods: readonly PricePeriod[], provider: string, model: string, plan: string | null, at: number): PricePeriod[] =>
  periods.filter((p) => p.provider === provider && p.model === model && p.plan === plan && within(p, at));

// The list price of a period for these settings: its entry whose `when` they all match, the most precise.
export function listPriceOf(period: PricePeriod, settings: Readonly<Record<string, unknown>>): ListPrice | null {
  const matching = period.list.filter((price) => Object.entries(price.when ?? {}).every(([name, value]) => canonical(settings[name]) === canonical(value)));
  return matching.sort((a, b) => Object.keys(b.when ?? {}).length - Object.keys(a.when ?? {}).length)[0] ?? null;
}

const perUnit = (price: ListPrice): Record<string, number> => Object.fromEntries(Object.entries(price.rates).map(([unit, rate]) => [unit, rate / (price.per ?? 1)]));

const sameRates = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const units = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...units].every((unit) => Math.abs((a[unit] ?? 0) - (b[unit] ?? 0)) <= 1e-9 * Math.max(1, Math.abs(a[unit] ?? 0)));
};

// What the list price bills a measured request, null when a unit it sent has no price.
export function listCost(ledger: CostLedger, period: PricePeriod, m: Measurement): number | null {
  const provider = ledger.providers[m.provider];
  const price = listPriceOf(period, { kind: m.kind, ...m.settings });
  if (!price) return null;
  const rates = perUnit(price);
  let cost = 0;
  for (const [unit, count] of Object.entries(m.sent)) {
    if (rates[unit] === undefined) return null;
    cost += count * rates[unit];
  }
  for (const name of provider?.listMultipliers ?? []) {
    const factor = m.settings[name];
    if (typeof factor === 'number' && factor > 0) cost *= factor;
  }
  return cost;
}

// What is wrong with a ledger: periods that overlap or price nothing, measurements with no period
// or two, or whose period is not the one their date falls in, units with no price, a request twice.
export function ledgerProblems(ledger: CostLedger, measurements: readonly Measurement[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const p of ledger.periods) {
    const provider = ledger.providers[p.provider];
    if (ids.has(p.id)) problems.push(`period ${p.id}: its id is used twice`);
    ids.add(p.id);
    if (!provider) problems.push(`period ${p.id}: provider ${p.provider} is not in providers`);
    if (!p.list.length) problems.push(`period ${p.id}: no list price`);
    for (const [name, value] of [['start', p.start], ['end', p.end]] as const) {
      if (value !== null && (Number.isNaN(Date.parse(value)) || !/(Z|[+-]\d\d:\d\d)$/.test(value))) problems.push(`period ${p.id}: ${name} is not a UTC date`);
    }
    if (time(p.start, -Infinity) >= time(p.end, Infinity)) problems.push(`period ${p.id}: it ends before it starts`);
    if (p.discount && p.discount.rate !== null && !(p.discount.rate >= 0 && p.discount.rate < 1)) problems.push(`period ${p.id}: a discount rate is from 0 to 1 (0.725 bills 27.5 %)`);
    for (const q of ledger.periods) {
      if (q === p || q.provider !== p.provider || q.model !== p.model || q.plan !== p.plan || ledger.periods.indexOf(q) < ledger.periods.indexOf(p)) continue;
      if (time(p.start, -Infinity) < time(q.end, Infinity) && time(q.start, -Infinity) < time(p.end, Infinity)) problems.push(`periods ${p.id} and ${q.id} overlap`);
    }
  }
  const seen = new Set<string>();
  measurements.forEach((m, index) => {
    const at = Date.parse(m.date);
    const name = `measurement ${index + 1} (${m.provider} ${m.model} ${m.date}${m.source?.id ? `, ${m.source.id}` : ''})`;
    const provider = ledger.providers[m.provider];
    if (!provider) return void problems.push(`${name}: provider ${m.provider} is not in providers`);
    if (Number.isNaN(at) || !/(Z|[+-]\d\d:\d\d)$/.test(m.date)) return void problems.push(`${name}: its date is not a UTC date (2026-10-13T09:29:50Z)`);
    if (m.source?.id) {
      const id = `${m.provider} ${m.source.id}`;
      if (seen.has(id)) problems.push(`${name}: recorded twice`);
      seen.add(id);
    }
    if (typeof m.billed?.[provider.billed] !== 'number') problems.push(`${name}: billed has no ${provider.billed}`);
    if (!m.sent || !Object.keys(m.sent).length) problems.push(`${name}: nothing sent`);
    const periods = periodsAt(ledger.periods, m.provider, m.model, m.plan, at);
    if (!periods.length) return void problems.push(`${name}: no price period of ${m.provider} ${m.model} for the ${m.plan} plan holds its date: add one to ai-costs/periods.json`);
    if (periods.length > 1) return void problems.push(`${name}: in ${periods.length} periods (${periods.map((p) => p.id).join(', ')})`);
    if (m.period !== periods[0].id) problems.push(`${name}: its period is ${periods[0].id}, not ${m.period}`);
    if (listCost(ledger, periods[0], m) === null) problems.push(`${name}: period ${periods[0].id} has no list price for what it sent (${Object.keys(m.sent).join(', ')})`);
  });
  return problems;
}

// The averages of a ledger, by provider, model, plan, price settings and period.
export function costAverages(ledger: CostLedger, measurements: readonly Measurement[]): CostAverage[] {
  const groups = new Map<string, CostAverage>();
  for (const m of measurements) {
    const [period] = periodsAt(ledger.periods, m.provider, m.model, m.plan, Date.parse(m.date));
    const provider = ledger.providers[m.provider];
    const list = period && listCost(ledger, period, m);
    const billed = provider && m.billed?.[provider.billed];
    if (!period || !list || typeof billed !== 'number') continue;
    const settings = priceSettings(provider, m.kind, m.settings);
    const key = costKey(period.id, settings);
    const group = groups.get(key) ?? { key, provider: m.provider, model: m.model, plan: m.plan, settings, period: period.id, measurements: 0, sent: {}, list: 0, billed: 0, share: 0, undiscounted: null };
    group.measurements += 1;
    for (const [unit, count] of Object.entries(m.sent)) group.sent[unit] = (group.sent[unit] ?? 0) + count;
    group.list += list;
    group.billed += billed;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((group) => {
    const period = ledger.periods.find((p) => p.id === group.period)!;
    const share = up(group.billed / group.list);
    const rate = period.discount ? period.discount.rate : 0;
    return { ...group, list: Math.round(group.list * 1e6) / 1e6, billed: Math.round(group.billed * 1e6) / 1e6, share, undiscounted: rate === null ? null : up(group.billed / group.list / (1 - rate)) };
  });
}

// A request the author's computer made, as the service charged it.
export interface OwnCharge {
  provider: string;
  model: string;
  plan: string | null;
  date: string;
  settings?: Record<string, unknown>;
  kind?: string;
  list: number;                    // what its list price was
  billed: number;                  // what was billed
  rates?: Record<string, number>;  // the list price per unit then
}

export interface ShareQuestion {
  provider: string;
  model: string;
  plan: string | null;
  kind?: string;
  settings?: Readonly<Record<string, unknown>>;
  rates?: Record<string, number>;  // the list price per unit the service says now, when it says one
  now?: number;
  own?: readonly OwnCharge[];
}

export interface ShareAnswer {
  share: number;                   // of the list price, at most 1
  from: 'ledger' | 'own' | 'list';
  period: string | null;           // the current period, when the book knows it and it still holds
}

// The share of its list price a request is expected to be charged (D36): the current period's average
// without its discount, or the author's own recent requests in that period where they say more (a rise
// is followed at once, from the first); where the ledger has too few measurements, the author's own
// from three, and a quarter more;
// with neither, the list price. Never past the list price. A period whose list price is no longer the
// one the service says is over: neither its average nor the requests made in it are used.
export function expectedShare(book: CostBook, question: ShareQuestion): ShareAnswer {
  const now = question.now ?? Date.now();
  const provider = book.providers[question.provider];
  const all = { kind: question.kind, ...(question.settings ?? {}) };
  const settings = priceSettings(provider, question.kind, question.settings);
  const [found] = periodsAt(book.periods, question.provider, question.model, question.plan, now);
  // Where the plan has no period now, the model's last change of price on any plan bounds the author's
  // own requests: a discount that ended for one plan is not counted on for another.
  const since = book.periods.filter((p) => p.provider === question.provider && p.model === question.model)
    .flatMap((p) => [time(p.start, -Infinity), time(p.end, Infinity)]).filter((t) => t <= now).reduce((a, b) => Math.max(a, b), -Infinity);
  const price = found ? listPriceOf(found, all) : null;
  const period = found && price && (!question.rates || sameRates(perUnit(price), question.rates)) ? found : null;
  const rate = period?.discount ? period.discount.rate : 0;
  const average = period && book.averages.find((a) => a.key === costKey(period.id, settings));
  const ledger = rate !== null && average && average.measurements >= MIN_MEASURED ? average.undiscounted : null;
  const own = (question.own ?? [])
    .filter((c) => c.provider === question.provider && c.model === question.model && c.plan === question.plan && c.list >= OWN_SMALLEST && c.billed >= 0)
    .filter((c) => canonical(priceSettings(provider, c.kind, c.settings)) === canonical(settings))
    .filter((c) => (period ? within(period, Date.parse(c.date)) : Date.parse(c.date) >= since))
    .filter((c) => !question.rates || !c.rates || sameRates(c.rates, question.rates))
    .slice(-OWN_RECENT);
  const total = own.reduce((sum, c) => ({ list: sum.list + c.list, billed: sum.billed + c.billed }), { list: 0, billed: 0 });
  const mine = rate !== null && own.length && total.list > 0 ? total.billed / total.list / (1 - rate) : null;
  const answer = (share: number, from: ShareAnswer['from']): ShareAnswer => ({ share: Math.min(1, share), from, period: period?.id ?? null });
  if (ledger !== null) return mine !== null && mine > ledger ? answer(mine, 'own') : answer(ledger, 'ledger');
  if (mine !== null && own.length >= OWN_BELIEVED) return answer(mine * OWN_MARGIN, 'own');
  return answer(1, 'list');
}
