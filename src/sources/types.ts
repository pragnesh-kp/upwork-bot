import type { FilterDef, SearchTarget } from '../filters.ts';

/** A job as the app understands it. Fields are null when the source did not provide them. */
export interface Job {
  id: string;
  title: string;
  url: string | null;
  description: string | null;
  postedAt: string | null;
  contractType: 'HOURLY' | 'FIXED' | null;
  fixedBudget: number | null;
  hourlyMin: number | null;
  hourlyMax: number | null;
  currency: string | null;
  /** Human-readable budget text supplied by the source (e.g. a *_label field), if any. */
  budgetLabel: string | null;
  skills: string[];
  /** Client details when the source provides them (Upwork MCP search does). */
  clientCountry?: string | null;
  clientPaymentVerified?: boolean | null;
  /** e.g. "Fewer than 5" (Basic plans see a tier, Freelancer Plus an exact count). */
  proposals?: string | null;
}

export interface SearchPage {
  jobs: Job[];
  nextCursor: string | null;
  /** Filter terms the server said it did not apply (Upwork's `filters_ignored`). */
  ignoredFilters: string[];
  /** Server explanation for an empty page (Upwork's `empty_reason`). */
  emptyReason: string | null;
  invalidRecords: number;
}

export type SourceErrorKind = 'auth' | 'rate_limited' | 'temporary' | 'permanent' | 'invalid_response';

export class SourceError extends Error {
  readonly kind: SourceErrorKind;
  readonly retryAfterSeconds: number | null;
  readonly traceId: string | null;
  constructor(kind: SourceErrorKind, message: string, opts: { retryAfterSeconds?: number | null; traceId?: string | null } = {}) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.traceId = opts.traceId ?? null;
  }
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'temporary' || this.kind === 'invalid_response';
  }
}

export interface JobSource {
  readonly name: 'upwork-mcp';
  /** Human-readable description of how each filter field is sent to the source. */
  describeMapping(filter: FilterDef): { applied: string[]; notApplied: string[] };
  /** One page of one search target (a category, a subcategory, or {} for a plain search). */
  search(filter: FilterDef, cursor: string | null, pageSize: number, target?: SearchTarget): Promise<SearchPage>;
  close(): Promise<void>;
}
