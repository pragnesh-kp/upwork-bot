import { readFileSync } from 'node:fs';
import type { Job } from './sources/types.ts';

export type ContractType = 'HOURLY' | 'FIXED';
export interface Range {
  min: number | null;
  max: number | null;
}

export interface Criteria {
  keyword: string | null;
  /** null = any contract type */
  contractTypes: ContractType[] | null;
  /** Fixed-price budget ranges (fixed-price jobs only). Upwork allows several, OR-ed. */
  fixedRanges: Range[] | null;
  /** Hourly rate range (hourly jobs only). */
  hourly: Range | null;
  sort: 'RECENCY' | 'RELEVANCE' | null;
  /** Upwork category / subcategory ontology ids (`category2_uid`, `subcategory2_uid`); all OR-ed, like the web UI. */
  categories: string[] | null;
  subcategories: string[] | null;
}

/** One server-side search of a filter: categories and subcategories are OR-ed, so each gets its own search. */
export interface SearchTarget {
  category?: string;
  subcategory?: string;
}

export function searchTargets(c: Criteria): SearchTarget[] {
  const targets: SearchTarget[] = [...(c.categories ?? []).map((category) => ({ category })), ...(c.subcategories ?? []).map((subcategory) => ({ subcategory }))];
  return targets.length ? targets : [{}];
}

export type ParamStatus = 'mapped' | 'ui_only' | 'unsupported' | 'invalid';

export interface ParamReport {
  key: string;
  value: string;
  status: ParamStatus;
  note: string;
}

export interface FilterDef {
  name: string;
  url: string;
  enabled: boolean;
  criteria: Criteria;
  params: ParamReport[];
}

const RANGE_RE = /^\s*(\d+(?:\.\d+)?)?\s*-\s*(\d+(?:\.\d+)?)?\s*$/;

export function parseRange(value: string): Range | null {
  const single = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
  if (single) return { min: Number(single[1]), max: Number(single[1]) };
  const m = RANGE_RE.exec(value);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const r = { min: m[1] !== undefined ? Number(m[1]) : null, max: m[2] !== undefined ? Number(m[2]) : null };
  return r.min !== null && r.max !== null && r.min > r.max ? null : r;
}

const UI_ONLY: Record<string, string> = {
  jobs_feed: 'Selects a web-UI feed tab; has no search meaning.',
  page: 'Web-UI page number; pagination is handled by the app.',
  per_page: 'Web-UI page size; the app sets its own page size.',
  nbs: 'Web-UI tracking parameter.',
};

/**
 * Parses an Upwork job-search URL. Only parameters whose meaning is clear are
 * applied; everything else is reported (never silently dropped).
 */
export function parseUpworkSearchUrl(raw: string): { ok: true; criteria: Criteria; params: ParamReport[] } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'Not a valid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'URL must use https' };
  if (!['www.upwork.com', 'upwork.com'].includes(url.hostname.toLowerCase())) return { ok: false, error: 'URL must be on upwork.com' };
  if (!/^\/nx\/(search\/jobs|jobs\/search)\/?$/.test(url.pathname)) return { ok: false, error: 'URL must be an Upwork job search (/nx/search/jobs)' };

  // Always newest first: the bot pages until it reaches known jobs, which only works in recency order.
  const criteria: Criteria = { keyword: null, contractTypes: null, fixedRanges: null, hourly: null, sort: 'RECENCY', categories: null, subcategories: null };
  const params: ParamReport[] = [];
  const grouped = new Map<string, string[]>();
  for (const [k, v] of url.searchParams) grouped.set(k, [...(grouped.get(k) ?? []), v]);

  for (const [key, values] of grouped) {
    const value = values.join(',');
    const report = (status: ParamStatus, note: string) => params.push({ key, value, status, note });
    switch (key) {
      case 'q': {
        criteria.keyword = value.trim() || null;
        report('mapped', `Keyword: "${criteria.keyword ?? ''}"`);
        break;
      }
      case 'amount': {
        const ranges = value.split(',').map(parseRange);
        if (ranges.some((r) => r === null)) report('invalid', 'Fixed-price budget could not be parsed');
        else {
          criteria.fixedRanges = ranges as Range[];
          report('mapped', `Fixed-price budget ${ranges.map((r) => `$${r!.min ?? 0}–${r!.max === null ? 'any' : `$${r!.max}`}`).join(' or ')} (applies to fixed-price jobs only)`);
        }
        break;
      }
      case 'hourly_rate': {
        const r = parseRange(value);
        if (!r) report('invalid', 'Hourly rate could not be parsed');
        else {
          criteria.hourly = r;
          report('mapped', `Hourly rate $${r.min ?? 0}–${r.max === null ? 'any' : `$${r.max}`}/hr (applies to hourly jobs only)`);
        }
        break;
      }
      case 't': {
        const codes = value.split(',').map((s) => s.trim());
        const types = new Set<ContractType>();
        const unknown: string[] = [];
        for (const c of codes) {
          if (c === '0') types.add('HOURLY');
          else if (c === '1') types.add('FIXED');
          else unknown.push(c);
        }
        if (unknown.length) report('invalid', `Unknown contract type code(s): ${unknown.join(', ')}`);
        if (types.size) {
          criteria.contractTypes = types.size === 2 ? null : [...types];
          report('mapped', `Contract types: ${[...types].map((t) => (t === 'HOURLY' ? 'Hourly' : 'Fixed price')).join(' + ')} (0 = hourly, 1 = fixed, inferred from the Upwork web UI)`);
        }
        break;
      }
      case 'sort': {
        report('mapped', value === 'recency' ? 'Sort: newest first' : `Sort "${value}" replaced by newest first (needed to catch every new post)`);
        break;
      }
      case 'category2_uid':
      case 'subcategory2_uid': {
        const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
        const sub = key === 'subcategory2_uid';
        if (!ids.length || ids.some((id) => !/^\d{5,25}$/.test(id))) report('invalid', `${sub ? 'Subcategory' : 'Category'} ids must be numeric`);
        else {
          if (sub) criteria.subcategories = ids;
          else criteria.categories = ids;
          report('mapped', `${sub ? 'Subcategory' : 'Category'} id(s) ${ids.join(', ')} (each searched separately; results combined)`);
        }
        break;
      }
      default:
        if (key in UI_ONLY) report('ui_only', UI_ONLY[key]!);
        else report('unsupported', 'Not supported by this app; it is NOT applied. Remove it or add support after checking the live MCP schema.');
    }
  }
  return { ok: true, criteria, params };
}

/** URL parameters the app cannot send to Upwork; a filter with any of them would return jobs outside it. */
export function filterProblems(params: ParamReport[]): string[] {
  return params.filter((p) => p.status === 'unsupported' || p.status === 'invalid').map((p) => `${p.key}=${p.value}: ${p.note}`);
}

/** A readable default name: the keyword ("ai developer" → "Ai Developer"), else "Upwork filter N". */
export function defaultFilterName(c: Criteria, n: number): string {
  const k = c.keyword?.replace(/\s+/g, ' ').trim();
  return k ? k.replace(/\b\w/g, (ch) => ch.toUpperCase()).slice(0, 60) : `Upwork filter ${n}`;
}

export const MAX_FILTERS = 25;

/** Reads a filters.json file (used by `npm run import` to move filters into the database). */
export function loadFilters(path: string): FilterDef[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read filters file ${path}: ${(err as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { filters?: unknown }).filters;
  if (!Array.isArray(list)) throw new Error('filters.json must be an array of { "name", "url", "enabled" }');
  return toFilterDefs(list);
}

/** Validates stored filters (name, url, enabled) and parses each URL. */
export function toFilterDefs(list: unknown[]): FilterDef[] {
  if (list.length > MAX_FILTERS) throw new Error(`At most ${MAX_FILTERS} filters are supported`);
  const names = new Set<string>();
  return list.map((f, i) => {
    const item = f as { name?: unknown; url?: unknown; enabled?: unknown };
    if (typeof item.name !== 'string' || !item.name.trim()) throw new Error(`Filter #${i + 1} needs a "name"`);
    if (typeof item.url !== 'string') throw new Error(`Filter "${item.name}" needs a "url"`);
    if (names.has(item.name)) throw new Error(`Duplicate filter name "${item.name}"`);
    names.add(item.name);
    const parsed = parseUpworkSearchUrl(item.url);
    if (!parsed.ok) throw new Error(`Filter "${item.name}": ${parsed.error}`);
    return { name: item.name.trim(), url: item.url, enabled: item.enabled !== false, criteria: parsed.criteria, params: parsed.params };
  });
}

// ---------------------------------------------------------------------------
// Local verification
// ---------------------------------------------------------------------------

export interface MatchResult {
  matched: boolean;
  failed: string[];
  unknown: string[];
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/**
 * Simple keyword evaluation: groups separated by " OR " match if every term in
 * the group appears; "quoted phrases" must appear verbatim; -term excludes.
 * This cannot reproduce Upwork's search ranking; it is used only to check a job
 * against filters OTHER than the one whose search returned it.
 */
export function keywordMatches(keyword: string, text: string): boolean {
  const hay = ` ${normalize(text).replace(/[^a-z0-9+#.]+/g, ' ')} `;
  const groups = keyword.split(/\s+OR\s+/);
  return groups.some((g) => {
    const terms = [...g.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)].map((m) => ({
      neg: (m[1] ?? m[3]) === '-',
      text: normalize(m[2] ?? m[4] ?? '').replace(/[^a-z0-9+#.]+/g, ' ').trim(),
    }));
    return terms.filter((t) => t.text && t.text !== 'and').every((t) => hay.includes(` ${t.text} `) !== t.neg);
  });
}

const inRange = (v: number, r: Range) => (r.min === null || v >= r.min) && (r.max === null || v <= r.max);

/**
 * Checks a job against a filter. Missing job data is UNKNOWN, never zero, and
 * does not fail the match. `trustKeyword` is set for the filter whose own
 * server-side search returned the job (its keyword and categories were applied
 * by Upwork). Categories cannot be checked locally, so a category filter never
 * matches a job that its own search did not return.
 */
export function matchJob(job: Job, c: Criteria, opts: { trustKeyword: boolean }): MatchResult {
  const failed: string[] = [];
  const unknown: string[] = [];
  if (c.keyword && !opts.trustKeyword) {
    if (!keywordMatches(c.keyword, `${job.title} ${job.description ?? ''} ${job.skills.join(' ')}`)) failed.push('keyword');
  }
  if ((c.categories || c.subcategories) && !opts.trustKeyword) failed.push('category (only Upwork can check it)');
  if (c.contractTypes) {
    if (!job.contractType) unknown.push('contract type');
    else if (!c.contractTypes.includes(job.contractType)) failed.push('contract type');
  }
  if (c.fixedRanges && job.contractType !== 'HOURLY') {
    if (job.contractType === null || job.fixedBudget === null) unknown.push('fixed-price budget');
    else if (!c.fixedRanges.some((r) => inRange(job.fixedBudget!, r))) failed.push('fixed-price budget');
  }
  if (c.hourly && job.contractType !== 'FIXED') {
    if (job.contractType === null || (job.hourlyMin === null && job.hourlyMax === null)) unknown.push('hourly rate');
    else {
      // Overlap: the job's posted range intersects the filter range (inclusive).
      const lo = job.hourlyMin ?? job.hourlyMax!;
      const hi = job.hourlyMax ?? job.hourlyMin!;
      if (!((c.hourly.max === null || lo <= c.hourly.max) && (c.hourly.min === null || hi >= c.hourly.min))) failed.push('hourly rate');
    }
  }
  return { matched: failed.length === 0, failed, unknown };
}
