import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keywordMatches, matchJob, parseUpworkSearchUrl, searchTargets, type Criteria } from '../src/filters.ts';
import type { Job } from '../src/sources/types.ts';

const MY_URL =
  'https://www.upwork.com/nx/search/jobs?amount=1500-500000&hourly_rate=10-100&jobs_feed=all-jobs&q=Full%20stack%20developer&sort=recency&t=0,1';

const job = (over: Partial<Job>): Job => ({
  id: 'j',
  title: 'Full stack developer',
  url: null,
  description: null,
  postedAt: null,
  contractType: 'FIXED',
  fixedBudget: 5000,
  hourlyMin: null,
  hourlyMax: null,
  currency: 'USD',
  budgetLabel: null,
  skills: [],
  ...over,
});

test('parses the exact saved-search URL', () => {
  const r = parseUpworkSearchUrl(MY_URL);
  assert.ok(r.ok);
  assert.deepEqual(r.criteria, {
    keyword: 'Full stack developer',
    contractTypes: null, // hourly + fixed = any
    fixedRanges: [{ min: 1500, max: 500000 }],
    hourly: { min: 10, max: 100 },
    sort: 'RECENCY',
    categories: null,
    subcategories: null,
  });
  const status = Object.fromEntries(r.params.map((p) => [p.key, p.status]));
  assert.deepEqual(status, { amount: 'mapped', hourly_rate: 'mapped', jobs_feed: 'ui_only', q: 'mapped', sort: 'mapped', t: 'mapped' });
});

test('is independent of parameter order and decodes values', () => {
  const r = parseUpworkSearchUrl('https://www.upwork.com/nx/search/jobs?t=1&q=node%2Ejs%20%22rest%20api%22&amount=-999');
  assert.ok(r.ok);
  assert.equal(r.criteria.keyword, 'node.js "rest api"');
  assert.deepEqual(r.criteria.contractTypes, ['FIXED']);
  assert.deepEqual(r.criteria.fixedRanges, [{ min: null, max: 999 }]);
});

test('reports unsupported and invalid parameters instead of ignoring them', () => {
  const r = parseUpworkSearchUrl('https://www.upwork.com/nx/search/jobs?q=x&client_hires=1-9&amount=abc&t=7');
  assert.ok(r.ok);
  const byKey = Object.fromEntries(r.params.map((p) => [p.key, p.status]));
  assert.equal(byKey.client_hires, 'unsupported');
  assert.equal(byKey.amount, 'invalid');
  assert.equal(byKey.t, 'invalid');
});

test('rejects non-Upwork and unsafe URLs', () => {
  for (const u of ['http://www.upwork.com/nx/search/jobs?q=x', 'https://evil.example/nx/search/jobs?q=x', 'javascript:alert(1)', 'https://www.upwork.com/freelancers/x']) {
    assert.equal(parseUpworkSearchUrl(u).ok, false, u);
  }
});

const c = (parseUpworkSearchUrl(MY_URL) as { criteria: Criteria }).criteria;

test('fixed-price boundaries are inclusive and apply to fixed jobs only', () => {
  assert.ok(matchJob(job({ fixedBudget: 1500 }), c, { trustKeyword: true }).matched);
  assert.ok(matchJob(job({ fixedBudget: 500000 }), c, { trustKeyword: true }).matched);
  assert.deepEqual(matchJob(job({ fixedBudget: 1499 }), c, { trustKeyword: true }).failed, ['fixed-price budget']);
  // An hourly job is not judged by the fixed-price range.
  assert.ok(matchJob(job({ contractType: 'HOURLY', fixedBudget: null, hourlyMin: 20, hourlyMax: 40 }), c, { trustKeyword: true }).matched);
});

test('hourly ranges use inclusive overlap', () => {
  const h = (min: number | null, max: number | null) => matchJob(job({ contractType: 'HOURLY', fixedBudget: null, hourlyMin: min, hourlyMax: max }), c, { trustKeyword: true });
  assert.ok(h(100, 150).matched); // touches the max
  assert.ok(h(5, 10).matched); // touches the min
  assert.ok(h(null, 30).matched);
  assert.equal(h(101, 150).matched, false);
  assert.equal(h(3, 9).matched, false);
});

test('missing data is unknown, never zero', () => {
  const r = matchJob(job({ contractType: null, fixedBudget: null }), c, { trustKeyword: true });
  assert.ok(r.matched);
  assert.deepEqual(r.unknown.sort(), ['fixed-price budget', 'hourly rate']);
  const strict = matchJob(job({ fixedBudget: null }), { ...c, contractTypes: ['FIXED'] }, { trustKeyword: true });
  assert.ok(strict.matched);
  assert.deepEqual(strict.unknown, ['fixed-price budget']);
});

test('contract type restriction', () => {
  const fixedOnly: Criteria = { ...c, contractTypes: ['FIXED'] };
  assert.deepEqual(matchJob(job({ contractType: 'HOURLY', fixedBudget: null, hourlyMin: 20, hourlyMax: 30 }), fixedOnly, { trustKeyword: true }).failed, ['contract type']);
});

test('local keyword check: all terms, phrases, OR groups, exclusions', () => {
  assert.ok(keywordMatches('Full stack developer', 'Senior FULL STACK Developer needed'));
  assert.equal(keywordMatches('Full stack developer', 'Stack overflow expert'), false);
  assert.ok(keywordMatches('"rest api" node.js', 'Build a REST API with Node.js'));
  assert.ok(keywordMatches('shopify OR wordpress', 'WordPress fixes'));
  assert.equal(keywordMatches('react -native', 'React Native app'), false);
  // Only used for OTHER filters; the fetching filter trusts the server's keyword search.
  assert.ok(matchJob(job({ title: 'Unrelated title' }), c, { trustKeyword: true }).matched);
  assert.equal(matchJob(job({ title: 'Unrelated title' }), c, { trustKeyword: false }).matched, false);
});

test('category and subcategory ids are parsed and each becomes its own search', () => {
  const r = parseUpworkSearchUrl('https://www.upwork.com/nx/search/jobs?category2_uid=531770282580668421,531770282580668418&subcategory2_uid=531770282589057034&t=1');
  assert.ok(r.ok);
  assert.deepEqual(r.criteria.categories, ['531770282580668421', '531770282580668418']);
  assert.deepEqual(r.criteria.subcategories, ['531770282589057034']);
  assert.deepEqual(searchTargets(r.criteria), [{ category: '531770282580668421' }, { category: '531770282580668418' }, { subcategory: '531770282589057034' }]);
  assert.deepEqual(searchTargets({ ...r.criteria, categories: null, subcategories: null }), [{}]);
  // Only Upwork knows a job's category: a category filter never matches a job its own search did not return.
  const j = { id: '1', title: 'x', url: null, description: null, postedAt: null, contractType: 'FIXED' as const, fixedBudget: 100, hourlyMin: null, hourlyMax: null, currency: null, budgetLabel: null, skills: [] };
  assert.equal(matchJob(j, r.criteria, { trustKeyword: false }).matched, false);
  assert.equal(matchJob(j, r.criteria, { trustKeyword: true }).matched, true);
  const bad = parseUpworkSearchUrl('https://www.upwork.com/nx/search/jobs?category2_uid=abc');
  assert.ok(bad.ok);
  assert.equal(bad.params[0]!.status, 'invalid');
});
