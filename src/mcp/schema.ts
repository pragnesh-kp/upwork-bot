/**
 * Schema-driven translation between this app's filter criteria and the live
 * Upwork MCP `find_jobs` tool, plus defensive parsing of its results.
 *
 * Upwork documents that the server is self-describing (`get_tool_help` returns
 * the live parameter schema) and that callers must not guess parameters. So a
 * parameter is sent ONLY when a property with that exact name exists in the
 * schema recorded by `npm run discover`; anything that cannot be expressed is
 * reported as not applied. The mapping is a reviewed proposal, not a guarantee.
 */
import type { Criteria, Range, SearchTarget } from '../filters.ts';
import type { Job, SearchPage } from '../sources/types.ts';

export interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  description?: string;
  [k: string]: unknown;
}

export interface ParamSchema {
  properties: Record<string, JsonSchema>;
  required?: string[];
}

const CANDIDATES = {
  keyword: ['query', 'keyword', 'keywords', 'q', 'search_query', 'search_term', 'search_expression', 'search_text', 'text'],
  contract: ['job_type', 'job_types', 'contract_type', 'contract_types', 'type', 'types'],
  fixedObject: ['budget', 'budget_range', 'fixed_budget', 'fixed_price', 'fixed_price_range', 'amount'],
  fixedMin: ['budget_min', 'min_budget', 'fixed_budget_min', 'min_fixed_budget', 'amount_min'],
  fixedMax: ['budget_max', 'max_budget', 'fixed_budget_max', 'max_fixed_budget', 'amount_max'],
  hourlyObject: ['hourly_rate', 'hourly_rate_range', 'hourly', 'hourly_range'],
  // Live Upwork MCP (26 Oct 2026): rate_min / rate_max, "hourly posted-range overlap".
  hourlyMin: ['rate_min', 'hourly_rate_min', 'min_hourly_rate', 'hourly_min', 'min_rate'],
  hourlyMax: ['rate_max', 'hourly_rate_max', 'max_hourly_rate', 'hourly_max', 'max_rate'],
  sort: ['sort', 'sort_by', 'order_by', 'sort_order'],
  pageSize: ['limit', 'page_size', 'per_page', 'first', 'count', 'size'],
  cursor: ['cursor', 'after', 'page_token', 'next_cursor', 'offset', 'page'],
};
const RANGE_KEYS: [string, string][] = [
  ['min', 'max'],
  ['from', 'to'],
  ['range_start', 'range_end'],
  ['rangeStart', 'rangeEnd'],
  ['gte', 'lte'],
  ['low', 'high'],
];

function findProp(schema: ParamSchema, names: string[]): string | null {
  const keys = Object.keys(schema.properties);
  for (const n of names) {
    const hit = keys.find((k) => k.toLowerCase() === n.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function typeOf(s: JsonSchema | undefined): string {
  return Array.isArray(s?.type) ? (s!.type.find((t) => t !== 'null') ?? '') : (s?.type ?? '');
}

function coerce(n: number, s: JsonSchema | undefined): number | string {
  return typeOf(s) === 'string' ? String(n) : n;
}

function rangeKeys(s: JsonSchema | undefined): [string, string] | null {
  const props = s?.properties ? Object.keys(s.properties) : [];
  return RANGE_KEYS.find(([a, b]) => props.includes(a) && props.includes(b)) ?? null;
}

function envelope(ranges: Range[]): Range {
  const mins = ranges.map((r) => r.min);
  const maxs = ranges.map((r) => r.max);
  return { min: mins.includes(null) ? null : Math.min(...(mins as number[])), max: maxs.includes(null) ? null : Math.max(...(maxs as number[])) };
}

/** Puts a numeric range into the schema, as an object property or a min/max pair. */
function applyRange(
  out: Record<string, unknown>,
  schema: ParamSchema,
  r: Range,
  objectNames: string[],
  minNames: string[],
  maxNames: string[],
): string | null {
  const obj = findProp(schema, objectNames);
  const keys = obj ? rangeKeys(schema.properties[obj]) : null;
  if (obj && keys) {
    const sub = schema.properties[obj]!.properties!;
    const v: Record<string, unknown> = {};
    if (r.min !== null) v[keys[0]] = coerce(r.min, sub[keys[0]]);
    if (r.max !== null) v[keys[1]] = coerce(r.max, sub[keys[1]]);
    out[obj] = v;
    return `${obj}.{${keys.join(',')}}`;
  }
  if (obj && typeOf(schema.properties[obj]) === 'string') {
    // Some APIs accept the web-UI style "min-max" string.
    out[obj] = `${r.min ?? ''}-${r.max ?? ''}`;
    return `${obj} ("min-max" string)`;
  }
  const lo = findProp(schema, minNames);
  const hi = findProp(schema, maxNames);
  if (lo || hi) {
    // A lower bound the schema cannot accept (e.g. 0 when exclusiveMinimum is 0) means "open": omit it.
    const min = r.min !== null && lo && acceptsValue(r.min, schema.properties[lo]) ? r.min : null;
    if (lo && min !== null) out[lo] = coerce(min, schema.properties[lo]);
    if (hi && r.max !== null) out[hi] = coerce(r.max, schema.properties[hi]);
    if ((r.min !== null && r.min > 0 && !lo) || (r.max !== null && !hi)) return null;
    return [min !== null ? lo : null, r.max !== null ? hi : null].filter(Boolean).join(' + ') || 'open range (nothing sent)';
  }
  return null;
}

function acceptsValue(n: number, s: JsonSchema | undefined): boolean {
  const exMin = typeof s?.exclusiveMinimum === 'number' ? s.exclusiveMinimum : null;
  const min = typeof s?.minimum === 'number' ? s.minimum : null;
  return (exMin === null || n > exMin) && (min === null || n >= min);
}

/** Clamps a number into the schema's [minimum, maximum]. */
function clamp(n: number, s: JsonSchema | undefined): number {
  const max = typeof s?.maximum === 'number' ? s.maximum : Infinity;
  const min = typeof s?.minimum === 'number' ? s.minimum : -Infinity;
  return Math.min(max, Math.max(min, n));
}

function enumValues(s: JsonSchema | undefined): string[] {
  const e = s?.enum ?? s?.items?.enum;
  return Array.isArray(e) ? e.map(String) : [];
}

export interface MappingResult {
  params: Record<string, unknown>;
  applied: string[];
  notApplied: string[];
}

export function buildSearchParams(c: Criteria, schema: ParamSchema, opts: { pageSize: number; cursor: string | null; target?: SearchTarget }): MappingResult {
  const params: Record<string, unknown> = {};
  const applied: string[] = [];
  const notApplied: string[] = [];
  const target = opts.target ?? {};

  for (const key of ['category', 'subcategory'] as const) {
    const id = target[key];
    if (!id) continue;
    if (schema.properties[key]) {
      params[key] = id;
      applied.push(`${key} id ${id} → ${key}`);
    } else notApplied.push(`${key} (no ${key} parameter in the live schema)`);
  }
  const categorySearch = 'category' in params || 'subcategory' in params;

  if (c.keyword) {
    const p = findProp(schema, CANDIDATES.keyword);
    if (p) {
      params[p] = c.keyword;
      applied.push(`keyword → ${p}`);
    } else notApplied.push('keyword (no keyword parameter in the live schema)');
  }

  if (c.contractTypes) {
    const p = findProp(schema, CANDIDATES.contract);
    const values = enumValues(p ? schema.properties[p] : undefined);
    const pick = (t: 'HOURLY' | 'FIXED') => values.find((v) => (t === 'HOURLY' ? /hour/i : /fix/i).test(v)) ?? (values.length ? null : t);
    const mapped = c.contractTypes.map(pick);
    if (p && mapped.every((v) => v !== null)) {
      params[p] = typeOf(schema.properties[p]) === 'array' ? mapped : mapped[0];
      applied.push(`contract type → ${p}=${JSON.stringify(params[p])}${values.length ? '' : ' (no enum in schema: value not verified)'}`);
    } else notApplied.push('contract type (no matching parameter or enum value; checked locally instead)');
  } else {
    applied.push('contract types: both hourly and fixed = no restriction sent');
  }

  if (c.fixedRanges) {
    const r = envelope(c.fixedRanges);
    const where = applyRange(params, schema, r, CANDIDATES.fixedObject, CANDIDATES.fixedMin, CANDIDATES.fixedMax);
    if (where) applied.push(`fixed-price budget ${r.min ?? 0}–${r.max ?? 'any'} → ${where}`);
    else notApplied.push('fixed-price budget (no budget parameter in the live schema; checked locally)');
    if (c.fixedRanges.length > 1) notApplied.push('multiple budget ranges (sent as one envelope; exact ranges checked locally)');
  }

  if (c.hourly) {
    const where = applyRange(params, schema, c.hourly, CANDIDATES.hourlyObject, CANDIDATES.hourlyMin, CANDIDATES.hourlyMax);
    if (where) applied.push(`hourly rate ${c.hourly.min ?? 0}–${c.hourly.max ?? 'any'} → ${where}`);
    else notApplied.push('hourly rate (no hourly-rate parameter in the live schema; checked locally)');
  }

  if (c.sort === 'RECENCY' && categorySearch) {
    // find_jobs refuses sort together with category/subcategory; omitting it already means newest first.
    applied.push('newest first (server default for category searches; sort not sent)');
  } else if (c.sort === 'RECENCY') {
    const p = findProp(schema, CANDIDATES.sort);
    const values = enumValues(p ? schema.properties[p] : undefined);
    const v = values.find((x) => /recen|newest|date|posted|created/i.test(x));
    if (p && v) {
      params[p] = v;
      applied.push(`newest first → ${p}=${v}`);
    } else notApplied.push('newest-first sort (no sort parameter or recency value in the live schema; results are ordered locally)');
  }

  const size = findProp(schema, CANDIDATES.pageSize);
  // The live find_jobs accepts limit 1-10; never send more than the schema allows.
  if (size) params[size] = coerce(clamp(opts.pageSize, schema.properties[size]), schema.properties[size]);
  if (opts.cursor) {
    const cur = findProp(schema, CANDIDATES.cursor);
    if (cur) params[cur] = typeOf(schema.properties[cur]) === 'integer' || typeOf(schema.properties[cur]) === 'number' ? Number(opts.cursor) : opts.cursor;
  }
  return { params, applied, notApplied };
}

/** Finds the parameter schema of the `search` action inside get_tool_help output or a tool inputSchema. */
export function extractSearchParamSchema(help: unknown): ParamSchema | null {
  const seen = new Set<unknown>();
  let best: ParamSchema | null = null;
  let bestScore = -1;
  const visit = (node: unknown, path: string[]): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const obj = node as Record<string, unknown>;
    if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
      const props = obj.properties as Record<string, JsonSchema>;
      const names = Object.keys(props).map((k) => k.toLowerCase());
      const signal = Object.values(CANDIDATES).flat().filter((n) => names.includes(n.toLowerCase())).length;
      const searchContext = path.some((p) => /search/i.test(p)) ? 5 : 0;
      const score = signal * 10 + searchContext - (names.includes('tool_name') ? 50 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { properties: props, required: Array.isArray(obj.required) ? (obj.required as string[]) : [] };
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      const label = typeof (v as { name?: unknown })?.name === 'string' ? `${k}:${(v as { name: string }).name}` : k;
      visit(v, [...path, label]);
    }
  };
  visit(help, []);
  return bestScore > 0 ? best : null;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ToolCallResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Returns the structured payload of a tool result (structuredContent or JSON text). */
export function toolPayload(r: ToolCallResult): unknown {
  if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent;
  const text = (r.content ?? []).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface ToolErrorInfo {
  message: string;
  code: string | null;
  retryAfterSeconds: number | null;
  traceId: string | null;
}

/** Upwork tools report failure via isError, then status / error_code; never by prose. */
export function toolError(r: ToolCallResult, payload: unknown): ToolErrorInfo | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const status = typeof p.status === 'string' ? p.status : null;
  const failed = r.isError === true || p.isError === true || status === 'error' || (typeof p.error_code === 'string' && status !== 'ok');
  if (!failed) return null;
  const retry = Number(p.retry_after_seconds ?? NaN);
  return {
    message: typeof p.reason === 'string' ? p.reason : typeof p.message === 'string' ? p.message : typeof payload === 'string' ? payload.slice(0, 300) : 'Upwork tool returned an error',
    code: typeof p.error_code === 'string' ? p.error_code : status,
    retryAfterSeconds: Number.isFinite(retry) ? retry : null,
    traceId: typeof p.trace_id === 'string' ? p.trace_id : null,
  };
}

const pickKey = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    // First number only: "$1,500" → 1500, never "$1,500-$3,000" → 15003000.
    const m = /\d[\d,]*(?:\.\d+)?/.exec(v);
    return m ? Number(m[0].replace(/,/g, '')) : null;
  }
  if (v && typeof v === 'object') return num(pickKey(v as Record<string, unknown>, ['amount', 'value', 'rawValue', 'raw_value']));
  return null;
}

function findJobArray(node: unknown, depth = 0): Record<string, unknown>[] | null {
  if (depth > 4 || !node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    return node.length > 0 && node.every((x) => x && typeof x === 'object' && ('title' in x || 'job_title' in x)) ? (node as Record<string, unknown>[]) : null;
  }
  const obj = node as Record<string, unknown>;
  for (const k of ['jobs', 'results', 'items', 'data', 'edges', 'nodes']) {
    const hit = findJobArray(obj[k], depth + 1);
    if (hit) return hit;
  }
  for (const v of Object.values(obj)) {
    const hit = findJobArray(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function normalizeJob(raw: Record<string, unknown>): Job | null {
  const o = (raw.node && typeof raw.node === 'object' ? raw.node : raw) as Record<string, unknown>;
  const ciphertext = pickKey(o, ['ciphertext', 'job_ciphertext']);
  const id = pickKey(o, ['ciphertext', 'job_ciphertext', 'id', 'job_id', 'uid', 'job_uid']);
  const title = pickKey(o, ['title', 'job_title']);
  if ((typeof id !== 'string' && typeof id !== 'number') || typeof title !== 'string') return null;
  const typeRaw = String(pickKey(o, ['job_type', 'contract_type', 'type', 'contractType']) ?? '');
  const contractType = /hour/i.test(typeRaw) ? 'HOURLY' : /fix/i.test(typeRaw) ? 'FIXED' : null;
  const hourlyObj = pickKey(o, ['hourly_rate', 'hourly_budget', 'hourly_range']);
  const hourly = hourlyObj && typeof hourlyObj === 'object' ? (hourlyObj as Record<string, unknown>) : {};
  const skillsRaw = pickKey(o, ['skills', 'skill_labels', 'required_skills']);
  const skills = Array.isArray(skillsRaw)
    ? skillsRaw.map((s) => (typeof s === 'string' ? s : String((s as Record<string, unknown>)?.prettyName ?? (s as Record<string, unknown>)?.label ?? (s as Record<string, unknown>)?.name ?? ''))).filter(Boolean)
    : [];
  const urlRaw = pickKey(o, ['url', 'job_url', 'link', 'web_url']);
  const rawBudget = pickKey(o, ['budget', 'amount', 'fixed_price', 'budget_amount', 'fixed_budget']);
  // Live find_jobs describes hourly budgets as text: "A–B/hr", "A+/hr" or "up to B/hr".
  const textHourly = typeof rawBudget === 'string' && /\/\s*h(ou)?r|hourly/i.test(rawBudget) ? parseHourlyText(rawBudget) : null;
  const budgetObj = rawBudget && typeof rawBudget === 'object' ? (rawBudget as Record<string, unknown>) : {};
  const budgetLabel =
    pickKey(o, ['budget_label', 'amount_label', 'price_label', 'hourly_rate_label']) ?? (typeof rawBudget === 'string' && rawBudget.trim() ? rawBudget.trim() : undefined);
  const isHourly = contractType === 'HOURLY' || (contractType === null && textHourly !== null);
  return {
    id: String(id),
    title: stripUntrustedMarkers(title),
    url: typeof urlRaw === 'string' ? urlRaw : typeof ciphertext === 'string' && /^~0/.test(ciphertext) ? `https://www.upwork.com/jobs/${ciphertext}` : null,
    description: (() => {
      const d = pickKey(o, ['description', 'description_snippet', 'snippet', 'summary', 'job_description']);
      return typeof d === 'string' ? stripUntrustedMarkers(d) || null : null;
    })(),
    postedAt: (() => {
      const d = pickKey(o, ['published_date', 'published_at', 'publishedDateTime', 'posted_at', 'posted_on', 'created_date', 'created_at', 'createdDateTime', 'date_posted', 'publish_time']);
      return typeof d === 'string' && !Number.isNaN(Date.parse(d)) ? new Date(d).toISOString() : null;
    })(),
    contractType: contractType ?? (textHourly ? 'HOURLY' : null),
    fixedBudget: isHourly ? null : num(rawBudget),
    hourlyMin: textHourly
      ? textHourly.min
      : num(pickKey(o, ['hourly_min', 'hourly_rate_min', 'hourlyBudgetMin', 'min_rate']) ?? pickKey(hourly, ['min', 'from', 'rangeStart']) ?? (isHourly ? pickKey(budgetObj, ['min', 'from']) : undefined)),
    hourlyMax: textHourly
      ? textHourly.max
      : num(pickKey(o, ['hourly_max', 'hourly_rate_max', 'hourlyBudgetMax', 'max_rate']) ?? pickKey(hourly, ['max', 'to', 'rangeEnd']) ?? (isHourly ? pickKey(budgetObj, ['max', 'to']) : undefined)),
    currency: (() => {
      const c = pickKey(o, ['currency', 'currency_code']);
      return typeof c === 'string' ? c : null;
    })(),
    budgetLabel: typeof budgetLabel === 'string' ? budgetLabel : null,
    skills,
    ...clientFields(o),
  };
}

/**
 * Upwork wraps client-written text in <untrusted_participant_content> markers
 * (a signal for AI agents). This app never interprets the text and always
 * displays it as plain text, so the markers are removed for readability only.
 */
export function stripUntrustedMarkers(s: string): string {
  return s.replace(/<\/?\s*untrusted_participant_content\s*>/gi, '').replace(/\s+/g, ' ').trim();
}

/** Live search rows carry client { country, verification_status } and proposals_tier. */
function clientFields(o: Record<string, unknown>): Pick<Job, 'clientCountry' | 'clientPaymentVerified' | 'proposals'> {
  const c = (o.client && typeof o.client === 'object' ? o.client : {}) as Record<string, unknown>;
  const country = pickKey(c, ['country', 'location']) ?? pickKey(o, ['client_country']);
  const status = String(pickKey(c, ['verification_status', 'payment_verification_status']) ?? '');
  const proposals = pickKey(o, ['proposal_count', 'proposals_tier', 'proposals']);
  return {
    clientCountry: typeof country === 'string' ? country : null,
    // Only an explicit status counts; anything else stays unknown.
    clientPaymentVerified: /^verified$/i.test(status) ? true : /unverified|not_verified/i.test(status) ? false : null,
    proposals: typeof proposals === 'string' || typeof proposals === 'number' ? String(proposals) : null,
  };
}

/** Parses "$10–$30/hr", "$25+/hr", "up to $40/hr" (en dash, hyphen or "to"). Unknown parts stay null. */
export function parseHourlyText(s: string): { min: number | null; max: number | null } | null {
  const n = (x: string | undefined) => (x === undefined ? null : Number(x.replace(/,/g, '')));
  const t = s.replace(/\s+/g, ' ');
  const range = /\$?\s*([\d,]+(?:\.\d+)?)\s*(?:-|–|—|to)\s*\$?\s*([\d,]+(?:\.\d+)?)/i.exec(t);
  if (range) return { min: n(range[1]), max: n(range[2]) };
  const upTo = /up to\s*\$?\s*([\d,]+(?:\.\d+)?)/i.exec(t);
  if (upTo) return { min: null, max: n(upTo[1]) };
  const plus = /\$?\s*([\d,]+(?:\.\d+)?)\s*\+/.exec(t);
  if (plus) return { min: n(plus[1]), max: null };
  const single = /\$?\s*([\d,]+(?:\.\d+)?)/.exec(t);
  return single ? { min: n(single[1]), max: n(single[1]) } : null;
}

function findCursor(p: Record<string, unknown>): string | null {
  const containers = [p, p.pagination, p.page_info, p.pageInfo, p.paging].filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  for (const c of containers) {
    const more = pickKey(c, ['has_more', 'has_next_page', 'hasNextPage', 'more']);
    const cur = pickKey(c, ['next_cursor', 'nextCursor', 'next_page_token', 'end_cursor', 'endCursor', 'next_offset', 'next_page', 'cursor']);
    if (more === false) return null;
    if (typeof cur === 'string' || typeof cur === 'number') return String(cur);
  }
  return null;
}

export function normalizeSearchPayload(payload: unknown): SearchPage {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const rows = findJobArray(payload) ?? [];
  const jobs: Job[] = [];
  let invalid = 0;
  for (const r of rows) {
    const j = normalizeJob(r);
    if (j) jobs.push(j);
    else invalid++;
  }
  const label = (x: unknown) => (typeof x === 'string' ? x : String((x as Record<string, unknown>)?.name ?? (x as Record<string, unknown>)?.field ?? JSON.stringify(x)));
  const list = (v: unknown) => (Array.isArray(v) ? v.map(label) : v && typeof v === 'object' ? Object.keys(v) : []);
  // filters_ignored: terms not applied; filters_rejected: values outside a fixed vocabulary (location, timezone).
  const ignored = [...list(p.filters_ignored ?? p.ignored_filters), ...list(p.filters_rejected).map((x) => `${x} (rejected)`)];
  return {
    jobs,
    nextCursor: findCursor(p),
    ignoredFilters: ignored,
    emptyReason: typeof p.empty_reason === 'string' ? p.empty_reason : null,
    invalidRecords: invalid,
  };
}
