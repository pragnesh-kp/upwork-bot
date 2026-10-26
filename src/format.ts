import type { Job } from './sources/types.ts';

/** Only https links on upwork.com are ever stored or rendered as links. */
export function safeUpworkUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)upwork\.com$/i.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

function money(n: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  } catch {
    return `${n} ${currency ?? ''}`.trim();
  }
}

/** Formats the budget from parsed numbers; the source's own text is used only when nothing was parsed. */
export function budgetText(job: Job): string {
  if (job.contractType === 'FIXED') {
    if (job.fixedBudget !== null) return `Fixed price · ${money(job.fixedBudget, job.currency)}`;
    return job.budgetLabel ? `Fixed price · ${job.budgetLabel}` : 'Fixed price · budget not provided';
  }
  if (job.contractType === 'HOURLY') {
    const lo = job.hourlyMin !== null ? money(job.hourlyMin, job.currency) : null;
    const hi = job.hourlyMax !== null ? money(job.hourlyMax, job.currency) : null;
    if (lo && hi) return `Hourly · ${lo === hi ? lo : `${lo}–${hi}`}/hr`;
    if (lo) return `Hourly · ${lo}+/hr`;
    if (hi) return `Hourly · up to ${hi}/hr`;
    return job.budgetLabel ? `Hourly · ${job.budgetLabel}` : 'Hourly · rate not provided';
  }
  return job.budgetLabel ?? 'Not provided';
}
