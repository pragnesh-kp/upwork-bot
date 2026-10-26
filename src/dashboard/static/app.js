// Job Alerts dashboard client. Every value from Upwork is inserted with
// textContent (never innerHTML), so job content cannot inject markup.
const TOKEN = document.querySelector('meta[name="dashboard-token"]').content;
const $ = (id) => document.getElementById(id);
const SAVED_FILTER = 'jobAlerts.filter';
const view = { filter: '', state: '', q: '', day: '' };
try { view.filter = localStorage.getItem(SAVED_FILTER) || ''; } catch { /* storage unavailable */ }
let loadedJobs = [];
let lastState = null;

function el(tag, props = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard-token': TOKEN }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function ago(iso) {
  if (!iso) return 'posting time not provided';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

function safeUpworkUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)upwork\.com$/i.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderSchedule(s) {
  const box = $('schedule');
  const parts = [];
  if (s.running) parts.push('Searching Upwork now…');
  else if (s.schedule?.nextRunAt) parts.push(`Automatic search every ~${s.schedule.intervalMinutes} min · next at ${clock(s.schedule.nextRunAt)}`);
  else if (s.schedule) parts.push(`Automatic search every ~${s.schedule.intervalMinutes} min · searching now…`);
  else parts.push('Automatic searching is off here (run "npm run watch" or install the background task)');
  if (s.lastRun) parts.push(`last search ${ago(s.lastRun.finishedAt || s.lastRun.startedAt)} (${s.lastRun.status})`);
  box.textContent = `${parts.join(' · ')}. Each job is listed once, even if a later search finds it again.`;
}

function renderState(s) {
  lastState = s;
  $('subtitle').textContent = `Upwork MCP${s.account ? ` · ${s.account}` : ''} · ${s.totals.seen} jobs found · kept ${s.retentionDays} days`;
  renderSchedule(s);
  const tg = $('telegram');
  const telegramOn = s.telegram.configured && !s.telegram.dryRun;
  tg.hidden = !telegramOn;
  tg.textContent = `Telegram on · ${s.telegram.recipients} chat(s)`;
  tg.className = 'pill ok';

  // A remembered filter that was removed meanwhile falls back to "All filters".
  if (view.filter && !s.filters.some((f) => f.name === view.filter)) selectFilter('');

  const list = $('filters');
  const all = s.totals.newJobs; // distinct jobs: one job can match several filters
  const item = (f) => {
    const name = f ? f.name : '';
    const li = el('li', { class: view.filter === name ? 'active' : '' });
    const b = el('button', { type: 'button', class: `pick${f && !f.enabled ? ' disabled' : ''}`, 'aria-pressed': String(view.filter === name) });
    b.append(el('span', { class: 'name' }, f ? f.name : 'All filters'));
    const c = el('span', { class: 'count' });
    const newCount = f ? f.newCount : all;
    if (newCount) c.append(el('b', {}, `${newCount} new`), document.createTextNode(f ? ` · ${f.total}` : ''));
    else if (f) c.textContent = String(f.total);
    b.append(c);
    b.addEventListener('click', () => {
      selectFilter(name);
      renderState(lastState);
      loadJobs();
    });
    li.append(b);
    if (f) {
      const tools = el('div', { class: 'tools' });
      if (f.problems.length) tools.append(el('span', { class: 'warn', title: `Not applied: ${f.problems.join('; ')}` }, '⚠ some Upwork filters not applied'));
      const open = el('a', { href: safeUpworkUrl(f.url) || '#', target: '_blank', rel: 'noopener noreferrer', title: 'Open this search on Upwork' }, 'Open on Upwork ↗');
      const rm = el('button', { type: 'button', class: 'link danger', title: `Remove "${f.name}"` }, 'Remove');
      rm.addEventListener('click', async () => {
        if (!confirm(`Remove the filter "${f.name}"?\n\nIts jobs disappear from the dashboard and it is no longer searched.`)) return;
        rm.disabled = true;
        try {
          await api('/api/filters/remove', { name: f.name });
          if (view.filter === f.name) selectFilter('');
          await refresh();
        } catch (err) {
          alert(err.message);
          rm.disabled = false;
        }
      });
      tools.append(open, rm);
      li.append(tools);
    }
    return li;
  };
  list.replaceChildren(item(null), ...s.filters.map((f) => item(f)));
  if (s.filtersError) list.append(el('li', { class: 'muted' }, s.filtersError));
  $('totals').textContent = telegramOn ? `Alerts sent ${s.totals.alertsSent} · pending ${s.totals.alertsPending} · failed ${s.totals.alertsFailed}` : '';

  const btn = $('run');
  btn.disabled = !!s.running;
  btn.textContent = s.running ? 'Searching…' : view.filter ? 'Search this filter now' : 'Search all now';
  btn.title = view.filter ? `Search Upwork for "${view.filter}" now` : 'Search Upwork for all filters now';
  // While a search runs (e.g. the first search of a new filter), refresh often so its jobs show up.
  clearTimeout(renderState.poll);
  if (s.running) renderState.poll = setTimeout(() => refresh().catch(() => {}), 5000);
}

function selectFilter(name) {
  view.filter = name;
  try { localStorage.setItem(SAVED_FILTER, name); } catch { /* storage unavailable */ }
}

/** Lowercase words without accents or punctuation, so "Node.js" and "node js" compare equal. */
function words(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9+#]+/g, ' ').trim();
}

/** Every typed word must appear in the title, description or skills; "nodejs" also matches "Node.js". */
function matchesQuery(j, q) {
  const terms = words(q).split(' ').filter(Boolean);
  if (!terms.length) return true;
  const text = ` ${words([j.title, j.snippet, ...j.skills].join(' '))} `;
  const compact = text.replace(/ /g, '');
  return terms.every((t) => text.includes(t) || compact.includes(t));
}

/** Local calendar day (YYYY-MM-DD) a job was posted on. */
function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function applyView() {
  const shown = loadedJobs.filter((j) => matchesQuery(j, view.q) && (!view.day || dayKey(j.postedAt || j.firstSeenAt) === view.day));
  $('day-clear').hidden = !view.day;
  $('day').value = view.day;
  renderJobs(shown);
}

function setDay(key) {
  view.day = key;
  applyView();
}

/** "Today", "Yesterday" or e.g. "Saturday, 24 Oct" for the job's posting day (local time). */
function dayLabel(iso) {
  const d = new Date(iso);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

/** Interleaves a date heading before each day's jobs (jobs arrive newest first). */
function withDayHeaders(jobs, cards) {
  const out = [];
  let current = null;
  jobs.forEach((j, i) => {
    const label = dayLabel(j.postedAt || j.firstSeenAt);
    if (label !== current) {
      current = label;
      const count = jobs.filter((x) => dayLabel(x.postedAt || x.firstSeenAt) === label).length;
      const h = el('h3', { class: 'day' }, label);
      h.append(el('span', { class: 'muted' }, ` · ${count} job${count === 1 ? '' : 's'}`));
      out.push(h);
    }
    out.push(cards[i]);
  });
  return out;
}

function renderJobs(jobs) {
  const shown = jobs;
  const stateLabel = { new: 'New jobs', saved: 'Saved jobs', reviewed: 'Reviewed jobs', dismissed: 'Dismissed jobs', '': 'All jobs' }[view.state];
  const extra = [view.filter, view.day ? `posted ${dayLabel(`${view.day}T12:00:00`)}` : null, view.q ? `"${view.q}"` : null].filter(Boolean);
  $('list-title').textContent = `${stateLabel}${extra.map((x) => ` · ${x}`).join('')} (${shown.length})`;
  const box = $('jobs');
  if (!shown.length) {
    box.replaceChildren(el('div', { class: 'empty' }, view.q || view.day ? 'No jobs match this search or date. Clear the search box or pick "All dates".' : 'No jobs here yet. They appear after the next search.'));
    return;
  }
  const tpl = $('job-tpl');
  const cards = shown.map((j) => {
    const n = tpl.content.firstElementChild.cloneNode(true);
    const url = j.url ? safeUpworkUrl(j.url) : null;
    const a = n.querySelector('.title');
    a.textContent = j.title;
    if (url) a.href = url; else a.removeAttribute('href');

    const badges = n.querySelector('.badges');
    const lastStart = lastState?.lastRun?.startedAt;
    if (lastStart && j.firstSeenAt >= lastStart && !j.baseline && lastState.lastRun.finishedAt) {
      badges.append(el('span', { class: 'badge ok' }, 'Just found'));
      n.classList.add('fresh');
    }
    if (j.alertStatus === 'sent') badges.append(el('span', { class: 'badge ok' }, 'Sent to Telegram'));
    else if (j.alertStatus === 'pending') badges.append(el('span', { class: 'badge' }, 'Alert pending'));
    else if (j.alertStatus === 'failed') badges.append(el('span', { class: 'badge err' }, 'Alert failed'));
    if (j.reviewState !== 'new') badges.append(el('span', { class: 'badge muted' }, j.reviewState));

    const meta = n.querySelector('.meta');
    const add = (label, value) => {
      const s = el('span');
      s.append(document.createTextNode(`${label} `), el('strong', {}, value));
      meta.append(s);
    };
    add('Budget', j.budget || 'Not provided');
    add('Posted', ago(j.postedAt));
    add('Found', ago(j.firstSeenAt));
    if (j.clientCountry !== null) add('Client', j.clientCountry);
    if (j.clientPaymentVerified !== null) add('Payment', j.clientPaymentVerified ? 'verified' : 'not verified');
    if (j.proposals) add('Proposals', j.proposals);

    n.querySelector('.snippet').textContent = j.snippet || '';
    const chips = n.querySelector('.chips');
    for (const f of j.filters) chips.append(el('span', { class: 'chip filter' }, f));
    for (const s of j.skills.slice(0, 8)) chips.append(el('span', { class: 'chip' }, s));

    const open = n.querySelector('.open');
    if (url) open.href = url; else open.remove();
    for (const b of n.querySelectorAll('[data-act]')) {
      const act = b.dataset.act;
      if (act === j.reviewState || (act === 'new' && j.reviewState === 'new')) b.hidden = true;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await api('/api/jobs/state', { source: j.source, jobId: j.jobId, state: act });
          await refresh();
        } catch (err) {
          alert(err.message);
          b.disabled = false;
        }
      });
    }
    return n;
  });
  box.replaceChildren(...withDayHeaders(shown, cards));
}

let loadSeq = 0;
async function loadJobs() {
  const p = new URLSearchParams();
  if (view.filter) p.set('filter', view.filter);
  if (view.state) p.set('state', view.state);
  const seq = ++loadSeq;
  const { jobs } = await api(`/api/jobs?${p}`);
  if (seq !== loadSeq) return; // a newer request superseded this one
  loadedJobs = jobs;
  applyView();
}

async function refresh() {
  renderState(await api('/api/state'));
  await loadJobs();
}

function showRunResult(summary, error) {
  const box = $('run-result');
  box.hidden = false;
  box.className = `run-result${error ? ' error' : ''}`;
  if (error) {
    box.replaceChildren(el('strong', {}, 'Search failed: '), document.createTextNode(error));
    return;
  }
  const head = el('div');
  head.append(el('strong', {}, `Search finished (${summary.status}). `),
    document.createTextNode(`${summary.newJobs} new job(s) found.`));
  const ul = el('ul');
  for (const f of summary.filters) {
    const li = el('li', {}, `${f.name}: ${f.error ? '' : `${f.returned} returned, ${f.accepted} matched${f.baselineRun ? ' (first search of this filter)' : ''}`}`);
    if (f.error) li.append(el('span', { class: 'err' }, f.error));
    if (f.ignoredFilters.length) li.append(el('span', { class: 'warn' }, ` · Upwork did not apply: ${f.ignoredFilters.join(', ')}`));
    if (f.moreResultsNotFetched) li.append(el('span', { class: 'muted' }, ' · more results exist (first page only)'));
    ul.append(li);
  }
  box.replaceChildren(head, ul);
  if (summary.stoppedEarly) box.append(el('p', { class: 'err' }, `Stopped early: ${summary.stoppedEarly}`));
}

$('run').addEventListener('click', async () => {
  const btn = $('run');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  try {
    const summary = await api('/api/search', { filter: view.filter || null });
    showRunResult(summary);
  } catch (err) {
    showRunResult(null, err.message);
  }
  await refresh();
});

for (const b of document.querySelectorAll('.segmented button')) {
  b.addEventListener('click', () => {
    view.state = b.dataset.state;
    for (const x of document.querySelectorAll('.segmented button')) x.classList.toggle('active', x === b);
    loadJobs();
  });
}
let typing;
$('q').addEventListener('input', (e) => {
  clearTimeout(typing);
  typing = setTimeout(() => { view.q = e.target.value.trim(); applyView(); }, 120);
});
$('day').max = dayKey(new Date().toISOString());
$('day').addEventListener('change', (e) => setDay(e.target.value));
$('day-today').addEventListener('click', () => setDay(dayKey(new Date().toISOString())));
$('day-yesterday').addEventListener('click', () => setDay(dayKey(new Date(Date.now() - 86400000).toISOString())));
$('day-clear').addEventListener('click', () => setDay(''));

$('add-filter').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('add-msg');
  const submit = e.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  msg.hidden = false;
  msg.className = 'add-msg';
  msg.textContent = 'Adding…';
  try {
    const { name } = await api('/api/filters/add', { url: $('add-url').value.trim(), name: $('add-name').value.trim() });
    $('add-url').value = '';
    $('add-name').value = '';
    msg.textContent = `Added "${name}". Its first search is running now (up to a few minutes); jobs appear as soon as it finishes.`;
    selectFilter(name);
    await refresh();
  } catch (err) {
    msg.className = 'add-msg err';
    msg.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

refresh().catch((err) => showRunResult(null, err.message));
setInterval(() => refresh().catch(() => {}), 30000);
