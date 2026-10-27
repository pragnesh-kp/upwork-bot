// Job Alerts dashboard client. Every value from Upwork is inserted with
// textContent (never innerHTML), so job content cannot inject markup.
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

class LoginRequired extends Error {}

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { cache: 'no-store', credentials: 'same-origin' }
    // The custom header is required by the server for every change (other sites cannot send it).
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-requested-with': 'job-alerts' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.loginRequired) {
    showLogin();
    throw new LoginRequired('Login required');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
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

/** Time of day for today, otherwise also the day: "11:59 AM" or "Mon, 26 Oct, 6:26 PM". */
function when(iso) {
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return clock(iso);
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function duration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  return mins % 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins / 60} h`;
}

/** "in 12 min", or "overdue by 5 min" once the time has passed. */
function until(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms > 30000) return `in ${duration(ms)}`;
  return ms > -60000 ? 'due now' : `overdue by ${duration(-ms)}`;
}

/** The scheduler (GitHub Actions) should call every ~30 minutes, sometimes late; quieter than this means it is not working. */
const SCHEDULER_QUIET_MS = 60 * 60000;

function renderSchedule(s) {
  const box = $('schedule');
  box.replaceChildren();
  const line = (label, value, cls) => {
    const p = el('span', { class: `sched-item${cls ? ` ${cls}` : ''}` });
    p.append(el('span', { class: 'muted' }, `${label} `), el('strong', {}, value));
    box.append(p);
  };
  const sc = s.schedule;
  const r = s.running;
  if (r && r.tasksTotal) line('Scanning now:', `${r.tasksDone}/${r.tasksTotal} searches done, ${r.newJobs} new job(s) so far${r.retryAfter ? ` (Upwork asked to wait until ${clock(r.retryAfter)})` : ''}`, 'busy');
  else if (r) line('Scanning now:', 'starting…', 'busy');

  line('Last scan:', sc.lastSearchAt ? `${when(sc.lastSearchAt)} (${ago(sc.lastSearchAt)})` : 'not yet');
  const call = sc.lastSchedulerCall;
  const quiet = !call || Date.now() - Date.parse(call) > SCHEDULER_QUIET_MS;
  if (sc.nextDueAt && !r) {
    const overdue = Date.parse(sc.nextDueAt) <= Date.now();
    line('Next scan:', `${when(sc.nextDueAt)} (${until(sc.nextDueAt)})`, overdue && quiet ? 'warn' : '');
  }
  line('Every', `${sc.intervalMinutes} min, per filter`);
  // The external scheduler should call every 30 minutes; warn when it has gone quiet.
  if (!call) line('⚠ Scheduler:', 'has never called /api/cron. Scans only run while this page is open (see DEPLOY.md, step 6).', 'warn');
  else if (quiet) line('⚠ Scheduler:', `last called ${when(call)} (${ago(call)}). Check the Scheduler workflow on GitHub (Actions tab); scans only run while this page is open.`, 'warn');
  else line('Scheduler:', `last called ${ago(call)}`);
  const stopped = s.lastRun?.summary?.stoppedEarly;
  if (stopped) line('⚠', stopped, 'warn');
}

/** One line under each filter: when it was last searched and when it is searched next. */
function filterSchedule(f) {
  const box = el('div', { class: 'sched' });
  const ls = f.lastSearch;
  if (!ls) box.append(el('span', {}, 'Never scanned'));
  else if (ls.status === 'failed') box.append(el('span', { class: 'warn', title: ls.error || '' }, `Last scan failed ${when(ls.finishedAt)}`));
  else box.append(el('span', { title: `Started ${new Date(ls.startedAt).toLocaleString()}, finished ${new Date(ls.finishedAt).toLocaleString()}` }, `Last ${when(ls.finishedAt)} · ${ls.newJobs} new`));
  if (f.enabled && f.nextDueAt) box.append(el('span', {}, ` · Next ${when(f.nextDueAt)}`));
  return box;
}

function renderState(s) {
  lastState = s;
  $('subtitle').textContent = `Upwork MCP${s.account ? ` · ${s.account}` : ''} · ${s.totals.seen} jobs found · kept ${s.retentionDays} days`;
  renderSchedule(s);
  // Sign in to Upwork from here: shown until connected, and again when a search hit a sign-in problem.
  const connect = $('connect-upwork');
  const signInProblem = !!s.upworkProblem && /sign-in|authori[sz]|connect/i.test(s.upworkProblem);
  connect.hidden = !!s.account && !signInProblem;
  connect.textContent = s.account ? 'Reconnect Upwork' : 'Connect Upwork';

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
    if (f) li.append(filterSchedule(f));
    if (f) {
      const tools = el('div', { class: 'tools' });
      if (f.problems.length) tools.append(el('span', { class: 'warn', title: `Not applied: ${f.problems.join('; ')}` }, '⚠ some Upwork filters not applied'));
      const open = el('a', { href: safeUpworkUrl(f.url) || '#', target: '_blank', rel: 'noopener noreferrer', title: 'Open this search on Upwork' }, 'Open on Upwork ↗');
      const rm = el('button', { type: 'button', class: 'link danger', title: `Remove "${f.name}"` }, 'Remove');
      rm.addEventListener('click', async () => {
        if (!confirm(`Remove the filter "${f.name}"?\n\nIts jobs disappear from the dashboard and it is no longer searched.`)) return;
        rm.disabled = true;
        try {
          await api('/api/filters', { action: 'remove', name: f.name });
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

  const btn = $('run');
  btn.disabled = !!s.running;
  btn.textContent = s.running ? 'Searching…' : view.filter ? 'Search this filter now' : 'Search all now';
  btn.title = view.filter ? `Search Upwork for "${view.filter}" now` : 'Search Upwork for all filters now';
  // While a search is running or queued (e.g. the first search of a new filter), this page pushes it
  // forward itself instead of waiting for the scheduler, and refreshes so its jobs show up. It also
  // starts scans that are due, so they run on time while the page is open even without the scheduler.
  const due = s.schedule.nextDueAt && Date.parse(s.schedule.nextDueAt) <= Date.now();
  if (s.running) pushSearch();
  else if (due && Date.now() - lastDuePush > 60000) {
    lastDuePush = Date.now();
    pushSearch();
  }
}

let pushing = false;
let lastDuePush = 0;
async function pushSearch() {
  if (pushing) return;
  pushing = true;
  try {
    for (let i = 0; i < 40; i++) {
      const r = await api('/api/step', {});
      if (r.status === 'finished') showRunResult(r.summary);
      await refresh();
      if (r.status === 'idle' || r.status === 'finished') break;
      await new Promise((ok) => setTimeout(ok, r.status === 'continued' ? 500 : 5000));
    }
  } catch (err) {
    if (!(err instanceof LoginRequired)) showRunResult(null, err.message);
  } finally {
    pushing = false;
  }
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
          await api('/api/jobs', { source: j.source, jobId: j.jobId, state: act });
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
  box.hidden = false;
  const ul = el('ul');
  for (const f of summary.filters) {
    const li = el('li', {}, `${f.name}: ${f.error ? '' : `${f.returned} returned, ${f.accepted} matched, ${f.newJobs} new${f.firstRun ? ' (first search of this filter)' : ''}`}`);
    if (f.error) li.append(el('span', { class: 'err' }, f.error));
    if (f.ignoredFilters.length) li.append(el('span', { class: 'warn' }, ` · Upwork did not apply: ${f.ignoredFilters.join(', ')}`));
    if (f.moreResultsNotFetched) li.append(el('span', { class: 'muted' }, ' · older results not fetched (page limit)'));
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
    const r = await api('/api/search', { filter: view.filter || null });
    if (r.status === 'finished') showRunResult(r.summary);
    else if (r.status === 'busy') showRunResult(null, 'Another search is running; yours is queued and starts right after it.');
  } catch (err) {
    if (!(err instanceof LoginRequired)) showRunResult(null, err.message);
  }
  await refresh().catch(() => {});
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
    const { name } = await api('/api/filters', { action: 'add', url: $('add-url').value.trim(), name: $('add-name').value.trim() });
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

$('connect-upwork').addEventListener('click', async () => {
  const btn = $('connect-upwork');
  // Opened right away (inside the click) so the browser doesn't block it as a pop-up.
  const tab = window.open('about:blank', '_blank');
  btn.disabled = true;
  try {
    const r = await api('/api/upwork/connect', {});
    if (r.url) {
      if (tab) {
        tab.opener = null; // the Upwork tab can't reach back into this page
        tab.location.href = r.url;
      }
      $('connect-link').href = r.url;
      $('connect-msg').hidden = true;
      $('connect-url').value = '';
      $('connect-panel').hidden = false;
      $('connect-url').focus();
    } else {
      tab?.close();
      showNotice(`Upwork is already connected as ${r.connected}. Searching now…`);
      await refresh();
    }
  } catch (err) {
    tab?.close();
    if (!(err instanceof LoginRequired)) showRunResult(null, err.message);
  } finally {
    btn.disabled = false;
  }
});

$('connect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('connect-msg');
  const submit = e.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  msg.hidden = true;
  try {
    const r = await api('/api/upwork/finish', { url: $('connect-url').value.trim() });
    $('connect-panel').hidden = true;
    showNotice(`Upwork connected as ${r.connected}. The first search is running now; jobs appear as it finishes.`);
    await refresh();
  } catch (err) {
    if (!(err instanceof LoginRequired)) {
      msg.hidden = false;
      msg.textContent = err.message;
    }
  } finally {
    submit.disabled = false;
  }
});
$('connect-cancel').addEventListener('click', () => void ($('connect-panel').hidden = true));

function showNotice(text, isError = false) {
  const box = $('run-result');
  box.hidden = false;
  box.className = `run-result${isError ? ' error' : ''}`;
  box.replaceChildren(el('strong', {}, text));
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('login-msg');
  msg.hidden = true;
  try {
    await api('/api/login', { password: $('password').value });
    $('password').value = '';
    start();
  } catch (err) {
    msg.hidden = false;
    msg.textContent = err.message;
  }
});
$('logout').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  location.reload();
});

let started = false;
async function start() {
  try {
    await refresh();
  } catch (err) {
    if (!(err instanceof LoginRequired)) showRunResult(null, err.message);
    return;
  }
  $('login').hidden = true;
  $('app').hidden = false;
  $('logout').hidden = false;
  if (!started) {
    started = true;
    setInterval(() => refresh().catch(() => {}), 30000);
  }
}
start();
