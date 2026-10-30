// Insights page: jobs posted per day, the scan timetable check and the scan history.
// Loaded after app.js and uses its helpers ($, el, api, LoginRequired, showError, dayKey).
(() => {
  const SAVED_VIEW = 'jobAlerts.view';
  const ins = { day: '', data: null, timer: null, seq: 0 };
  const tz = () => -new Date().getTimezoneOffset();

  const STATUS = {
    completed: { label: 'Completed', icon: '✓' },
    delayed: { label: 'Delayed', icon: '◷' },
    missed: { label: 'Missed', icon: '✕' },
    failed: { label: 'Failed', icon: '!' },
    pending: { label: 'Pending', icon: '…' },
    running: { label: 'Running', icon: '↻' },
  };
  const RUN_STATUS = { ok: 'completed', partial: 'failed', failed: 'failed', interrupted: 'failed', running: 'running' };
  const RUN_LABEL = { ok: 'Completed', partial: 'Partly failed', failed: 'Failed', interrupted: 'Stopped before finishing', running: 'Running' };
  const TRIGGER = { scheduler: 'Scheduler', dashboard: 'Open dashboard', manual: 'Search now', 'new-filter': 'New filter', connect: 'Upwork connect', unknown: '—' };

  const badge = (status, text) => {
    const s = STATUS[status] || STATUS.pending;
    const b = el('span', { class: `st st-${status}` });
    b.append(el('span', { class: 'st-icon', 'aria-hidden': 'true' }, s.icon), document.createTextNode(text || s.label));
    return b;
  };
  const fullTime = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const timeOnly = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dur = (ms) => {
    if (ms === null || ms === undefined) return '—';
    if (ms < 60000) return `${Math.max(0, Math.round(ms / 1000))} s`;
    return duration(ms);
  };
  const shortDay = (key) => new Date(`${key}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
  const longDay = (key) => new Date(`${key}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  const periodLabel = () => (ins.day ? longDay(ins.day) : 'last 24 hours');

  function card(title, sub) {
    const c = el('section', { class: 'ins-card' });
    const h = el('div', { class: 'ins-head' });
    h.append(el('h3', {}, title));
    if (sub) h.append(el('p', { class: 'muted' }, sub));
    c.append(h);
    return c;
  }
  function tile(label, value, sub, cls = '') {
    const t = el('div', { class: `tile ${cls}` });
    t.append(el('span', { class: 'tile-label' }, label), el('strong', { class: 'tile-value' }, String(value)));
    if (sub) t.append(el('span', { class: 'tile-sub muted' }, sub));
    return t;
  }
  function table(head, rows) {
    const wrap = el('div', { class: 'table-wrap' });
    const t = el('table', { class: 'ins-table' });
    const tr = el('tr');
    for (const h of head) tr.append(el('th', { scope: 'col' }, h));
    t.append(el('thead'));
    t.tHead.append(tr);
    const body = el('tbody');
    for (const r of rows) body.append(r);
    t.append(body);
    wrap.append(t);
    return wrap;
  }
  const td = (content, cls) => {
    const c = el('td', cls ? { class: cls } : {});
    if (content instanceof Node) c.append(content);
    else c.textContent = content === null || content === undefined ? '' : String(content);
    return c;
  };

  // --- 1. Job postings -------------------------------------------------------------
  function jobsCard(d) {
    const c = card('Job postings', `New Upwork jobs matching your filters, by the day they were posted. A job that matches two filters counts once in "All filters". History is kept ${d.retentionDays} days.`);
    const tiles = el('div', { class: 'tiles' });
    tiles.append(tile('Posted in the last 24 hours', d.jobs.last24h.total, 'all filters combined', 'hero'));
    if (ins.day) tiles.append(tile(`Posted on ${longDay(ins.day)}`, d.jobs.inWindow.total, 'all filters combined', 'hero'));
    for (const f of d.filters) {
      tiles.append(tile(f, d.jobs.inWindow.byFilter[f] ?? 0, ins.day ? `${d.jobs.last24h.byFilter[f] ?? 0} in last 24 h` : 'last 24 hours'));
    }
    c.append(tiles);

    // Daily bars: all filters combined; click a bar to open that day.
    // Days before the first counted job are left out (keeping at least a week).
    const first = d.jobs.posted.findIndex((x) => x.total > 0 || d.jobs.found.some((f) => f.day === x.day && f.total > 0));
    const days = d.jobs.posted.slice(first < 0 ? -7 : Math.min(first, d.jobs.posted.length - 7));
    const found = new Map(d.jobs.found.map((x) => [x.day, x.total]));
    const max = Math.max(1, ...days.map((x) => x.total));
    const today = dayKey(new Date().toISOString());
    // Most / fewest compare whole days only: today is still filling up.
    const whole = days.filter((x) => x.total > 0 && x.day !== today);
    const hi = whole.length > 1 ? whole.reduce((a, b) => (b.total > a.total ? b : a)) : null;
    const lo = whole.length > 1 ? whole.reduce((a, b) => (b.total < a.total ? b : a)) : null;
    const readout = el('p', { class: 'readout' });
    const describe = (x) => {
      readout.replaceChildren(el('strong', {}, `${longDay(x.day)}: ${x.total} job${x.total === 1 ? '' : 's'} posted`));
      const parts = d.filters.map((f) => `${f} ${x.byFilter[f] ?? 0}`).join(' · ');
      if (parts) readout.append(document.createTextNode(` — ${parts}`));
      readout.append(el('span', { class: 'muted' }, ` · ${found.get(x.day) ?? 0} found by the bot that day`));
    };
    const chart = el('div', { class: 'bars', role: 'list', 'aria-label': 'Jobs posted per day, all filters' });
    for (const x of days) {
      const b = el('button', { type: 'button', class: `bar-col${x.day === ins.day ? ' sel' : ''}`, role: 'listitem', 'aria-label': `${longDay(x.day)}: ${x.total} jobs` });
      const label = x === hi || x === lo || x.day === ins.day || (!ins.day && x.day === today) ? String(x.total) : '';
      const v = el('span', { class: 'bar-val' }, label);
      const track = el('span', { class: 'bar-track' });
      const bar = el('span', { class: `bar${x.total ? '' : ' zero'}` });
      bar.style.height = `${(x.total / max) * 100}%`;
      track.append(bar);
      b.append(v, track, el('span', { class: 'bar-day' }, shortDay(x.day)));
      if (x === hi) b.append(el('span', { class: 'bar-tag up' }, 'Most'));
      else if (x === lo) b.append(el('span', { class: 'bar-tag down' }, 'Fewest'));
      b.addEventListener('mouseenter', () => describe(x));
      b.addEventListener('focus', () => describe(x));
      b.addEventListener('click', () => setDay(x.day === ins.day ? '' : x.day));
      chart.append(b);
    }
    chart.addEventListener('mouseleave', () => describe(days.find((x) => x.day === (ins.day || today)) || days.at(-1)));
    describe(days.find((x) => x.day === (ins.day || today)) || days.at(-1));
    const chartBox = el('div', { class: 'chart' });
    chartBox.append(el('h4', {}, `Jobs posted per day · last ${days.length} days · all filters`), readout, chart, el('p', { class: 'hint muted' }, 'Tap a bar to see that day.'));
    c.append(chartBox);

    // Per-day table, newest first, with each filter and the change from the day before.
    const rows = [...days].reverse().map((x, i, arr) => {
      const prev = arr[i + 1];
      const tr = el('tr', { class: x.day === ins.day ? 'sel' : '' });
      const dayCell = el('button', { type: 'button', class: 'link' }, longDay(x.day));
      dayCell.addEventListener('click', () => setDay(x.day));
      tr.append(td(dayCell));
      for (const f of d.filters) tr.append(td(x.byFilter[f] ?? 0, 'num'));
      const total = el('span');
      total.append(el('strong', {}, String(x.total)));
      if (x === hi) total.append(el('span', { class: 'tag up' }, 'most'));
      if (x === lo) total.append(el('span', { class: 'tag down' }, 'fewest'));
      tr.append(td(total, 'num'));
      const delta = prev ? x.total - prev.total : null;
      tr.append(td(delta === null ? '—' : delta === 0 ? '0' : `${delta > 0 ? '▲ +' : '▼ '}${delta}`, `num ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`));
      tr.append(td(found.get(x.day) ?? 0, 'num muted'));
      return tr;
    });
    c.append(table(['Day', ...d.filters, 'All filters', 'vs day before', 'Found that day'], rows));
    return c;
  }

  // --- 2. Timetable check ------------------------------------------------------------
  function timetableCard(d) {
    const t = d.timetable;
    const c = card('Scan schedule check', `Each filter should be scanned every ${d.intervalMinutes} min. A scan more than ${d.graceMinutes} min late is Delayed; a ${d.intervalMinutes}-min slot with no scan is Missed; a scan that errored or stopped before finishing is Failed.`);
    const tiles = el('div', { class: 'tiles status-tiles' });
    for (const st of ['completed', 'delayed', 'missed', 'failed', 'pending']) {
      const n = t.counts[st] + (st === 'pending' ? t.counts.running : 0);
      const tl = tile(STATUS[st].label, n, ins.day ? `${t.last24h[st]} in last 24 h` : periodLabel(), `st-tile st-${st}${n && ['missed', 'failed', 'delayed'].includes(st) ? ' alert' : ''}`);
      tl.prepend(el('span', { class: 'st-icon', 'aria-hidden': 'true' }, STATUS[st].icon));
      tiles.append(tl);
    }
    c.append(tiles);
    const problems = t.counts.missed + t.counts.failed;
    c.append(el('p', { class: `summary-line ${problems ? 'bad' : 'good'}` }, problems
      ? `${t.counts.missed} missed and ${t.counts.failed} failed scan${problems === 1 ? '' : 's'} (${periodLabel()}).${ins.day ? ` Last 24 hours: ${t.last24h.missed} missed, ${t.last24h.failed} failed.` : ''}`
      : `Every scheduled scan ran (${periodLabel()}).`));

    // One timeline per filter across the window.
    const from = Date.parse(d.window.from);
    const end = Math.max(Date.parse(d.window.to), ...t.byFilter.flatMap((f) => f.slots.map((s) => Date.parse(s.dueAt))));
    const span = Math.max(end - from, 60000);
    const lines = el('div', { class: 'timelines' });
    const axis = el('div', { class: 'tl-axis' });
    for (let i = 0; i <= 4; i++) {
      const tick = el('span', {}, new Date(from + (span * i) / 4).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      tick.style.left = `${i * 25}%`;
      axis.append(tick);
    }
    for (const f of t.byFilter) {
      const row = el('div', { class: 'tl-row' });
      const name = el('div', { class: 'tl-name' });
      name.append(el('strong', {}, f.name), el('span', { class: 'muted' }, ` ${f.counts.completed + f.counts.delayed} ok · ${f.counts.missed} missed · ${f.counts.failed} failed`));
      const track = el('div', { class: 'tl-track' });
      for (const s of f.slots) {
        const at = Date.parse(s.scanAt || s.dueAt);
        const dot = el('span', { class: `tl-dot st-${s.status}${s.late ? ' late' : ''}`, title: slotText(f.name, s), role: 'img', 'aria-label': slotText(f.name, s) });
        dot.style.left = `${Math.min(100, Math.max(0, ((at - from) / span) * 100))}%`;
        track.append(dot);
      }
      row.append(name, track);
      lines.append(row);
    }
    lines.append(axis);
    const legend = el('div', { class: 'legend' });
    for (const st of ['completed', 'delayed', 'missed', 'failed', 'pending']) legend.append(badge(st));
    c.append(lines, legend);

    // Every slot that needs attention, newest first; filters scanned together share one row.
    const groups = new Map();
    for (const f of t.byFilter) {
      for (const s of f.slots) {
        if (!['missed', 'failed', 'delayed'].includes(s.status) && !(s.status === 'pending' && s.late)) continue;
        const key = `${s.status}|${s.dueAt.slice(0, 16)}|${slotDetail(s)}`;
        if (!groups.has(key)) groups.set(key, { ...s, filters: [] });
        groups.get(key).filters.push(f.name);
      }
    }
    const issues = [...groups.values()].sort((a, b) => b.dueAt.localeCompare(a.dueAt));
    if (issues.length) {
      const rows = issues.slice(0, 200).map((s) => {
        const tr = el('tr');
        const names = s.filters.length === d.filters.length && d.filters.length > 1 ? `All filters (${s.filters.join(', ')})` : s.filters.join(', ');
        tr.append(td(fullTime(s.dueAt)), td(names, 'names'), td(badge(s.status, s.status === 'pending' ? 'Pending · overdue' : undefined)), td(slotDetail(s), 'detail'));
        return tr;
      });
      c.append(el('h4', {}, `Needs attention (${issues.length} time slot${issues.length === 1 ? '' : 's'})`), table(['Scheduled for', 'Filters', 'Status', 'What happened'], rows));
    }
    return c;
  }
  function slotDetail(s) {
    if (s.status === 'missed') return 'No scan ran in this slot (the scheduler did not call and the dashboard was closed).';
    if (s.status === 'failed') return s.error ? `Failed: ${s.error}` : 'Started but stopped before finishing.';
    if (s.status === 'delayed') return `Ran at ${timeOnly(s.scanAt)}, ${dur(s.delayMs)} late.`;
    if (s.status === 'pending') return s.late ? `Due ${until(s.dueAt)}; waiting for the scheduler.` : `Due ${until(s.dueAt)}.`;
    if (s.status === 'running') return 'Scanning now.';
    return s.scanAt ? `Ran at ${timeOnly(s.scanAt)}.` : '';
  }
  const slotText = (filter, s) => `${filter} · ${STATUS[s.status].label} · scheduled ${fullTime(s.dueAt)} · ${slotDetail(s)}`;

  // --- 3. Scan history ---------------------------------------------------------------
  function historyCard(d) {
    const s = d.scans.stats;
    const c = card('Scan history', `Every search the bot ran (${periodLabel()}), newest first. "Gap" is the time since the scan before; it should be about ${d.intervalMinutes} min.`);
    const tiles = el('div', { class: 'tiles' });
    tiles.append(
      tile('Scans run', s.runs, `${s.filterScans} filter scans`),
      tile('Scans per hour', s.perHour.toFixed(1), `target ${(60 / d.intervalMinutes).toFixed(1)}`),
      tile('Average gap', dur(s.avgGapMs), `target ${d.intervalMinutes} min`, s.avgGapMs > 1.5 * d.intervalMinutes * 60000 ? 'warn' : ''),
      tile('Longest gap', dur(s.maxGapMs), s.minGapMs !== null ? `shortest ${dur(s.minGapMs)}` : '', s.maxGapMs > 2 * d.intervalMinutes * 60000 ? 'warn' : ''),
      tile('New jobs found', s.newJobs, periodLabel()),
    );
    c.append(tiles);
    if (!d.scans.runs.length) {
      c.append(el('div', { class: 'empty' }, 'No scans ran in this period.'));
      return c;
    }
    const rows = d.scans.runs.map((r) => {
      const tr = el('tr');
      const filters = el('div', { class: 'chips' });
      for (const f of r.filters) {
        const ok = f.outcome === 'ok';
        const chip = el('span', { class: `chip ${ok ? 'ok' : f.outcome === 'running' ? 'run' : 'bad'}`, title: f.error || `${f.returned} returned, ${f.pages} page(s)${f.moreNotFetched ? ', more results not fetched' : ''}` }, `${ok ? '✓' : f.outcome === 'running' ? '↻' : '✕'} ${f.name} · ${f.newJobs} new`);
        filters.append(chip);
      }
      const gapLong = r.gapMs !== null && r.gapMs > 2 * d.intervalMinutes * 60000;
      tr.append(
        td(fullTime(r.startedAt)),
        td(r.finishedAt ? timeOnly(r.finishedAt) : '—'),
        td(dur(r.durationMs), 'num'),
        td(dur(r.gapMs), `num${gapLong ? ' warn' : ''}`),
        td(TRIGGER[r.trigger] || r.trigger),
        td(filters),
        td(`${r.newJobs} new / ${r.returned}`, 'num'),
        td(badge(RUN_STATUS[r.status] || 'pending', RUN_LABEL[r.status] || r.status)),
      );
      return tr;
    });
    c.append(table(['Started', 'Finished', 'Took', 'Gap', 'Started by', 'Filters checked', 'Jobs (new / returned)', 'Status'], rows));
    return c;
  }

  function render(d) {
    $('ins-range').textContent = `${new Date(d.window.from).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} – ${new Date(d.window.to).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    if (!d.filters.length) {
      $('ins-body').replaceChildren(el('div', { class: 'empty' }, 'Add a filter to start collecting insights.'));
      return;
    }
    $('ins-body').replaceChildren(jobsCard(d), timetableCard(d), historyCard(d));
  }

  async function load() {
    const seq = ++ins.seq;
    const p = new URLSearchParams({ tz: String(tz()), days: '14' });
    if (ins.day) p.set('day', ins.day);
    try {
      const d = await api(`/api/insights?${p}`);
      if (seq !== ins.seq) return;
      ins.data = d;
      render(d);
    } catch (err) {
      if (!(err instanceof LoginRequired)) $('ins-body').replaceChildren(el('div', { class: 'empty' }, `Could not load insights: ${err.message}`));
    }
  }

  function setDay(day) {
    ins.day = day;
    $('ins-day').value = day;
    const today = dayKey(new Date().toISOString());
    const yesterday = dayKey(new Date(Date.now() - 86400000).toISOString());
    $('ins-24h').classList.toggle('on', !day);
    $('ins-today').classList.toggle('on', day === today);
    $('ins-yesterday').classList.toggle('on', day === yesterday);
    load();
  }

  function showView(v) {
    const insights = v === 'insights';
    $('insights').hidden = !insights;
    $('jobs-view').hidden = insights;
    for (const b of document.querySelectorAll('.view-tabs button')) {
      const on = b.dataset.view === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    try { localStorage.setItem(SAVED_VIEW, v); } catch { /* storage unavailable */ }
    clearInterval(ins.timer);
    if (insights) {
      load();
      ins.timer = setInterval(load, 60000);
    }
  }

  for (const b of document.querySelectorAll('.view-tabs button')) b.addEventListener('click', () => showView(b.dataset.view));
  $('ins-day').max = dayKey(new Date().toISOString());
  $('ins-day').addEventListener('change', (e) => setDay(e.target.value));
  $('ins-24h').addEventListener('click', () => setDay(''));
  $('ins-today').addEventListener('click', () => setDay(dayKey(new Date().toISOString())));
  $('ins-yesterday').addEventListener('click', () => setDay(dayKey(new Date(Date.now() - 86400000).toISOString())));
  let saved = 'jobs';
  try { saved = localStorage.getItem(SAVED_VIEW) || 'jobs'; } catch { /* storage unavailable */ }
  showView(saved === 'insights' ? 'insights' : 'jobs');
})();
