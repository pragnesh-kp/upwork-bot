// Insights page: daily job posting insights, the missed-scan reliability matrix and the
// scan schedule & history. Loaded after app.js and uses its helpers
// ($, el, api, LoginRequired, dayKey, clock, when, duration, until, safeUpworkUrl, lastState, renderSchedule).
(() => {
  const SAVED_VIEW = 'jobAlerts.view';
  const SAVED_INS = 'jobAlerts.insights';
  const ins = {
    day: '',
    filter: '',
    compareOn: false,
    compareDay: '',
    trend: '7', // 7 | 15 | 30 | custom | month
    trendFrom: '',
    trendTo: '',
    pill: 'all',
    inspect: new Set(),
    alertHiddenFor: '',
    data: null,
    timer: null,
    seq: 0,
  };
  try { Object.assign(ins, JSON.parse(localStorage.getItem(SAVED_INS) || '{}'), { inspect: new Set(), data: null, timer: null, seq: 0 }); } catch { /* storage unavailable */ }
  const save = () => {
    try { localStorage.setItem(SAVED_INS, JSON.stringify({ filter: ins.filter, trend: ins.trend, trendFrom: ins.trendFrom, trendTo: ins.trendTo, compareOn: ins.compareOn, compareDay: ins.compareDay })); } catch { /* storage unavailable */ }
  };
  const tz = () => -new Date().getTimezoneOffset();
  const today = () => dayKey(new Date().toISOString());
  const addDays = (key, n) => {
    const d = new Date(`${key}T12:00:00`);
    d.setDate(d.getDate() + n);
    return dayKey(d.toISOString());
  };
  const longDay = (key) => new Date(`${key}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const shortDate = (key) => new Date(`${key}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const hourLabel = (iso) => {
    const h = new Date(iso).getHours();
    return `${String(h % 12 || 12).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const secs = (ms) => {
    if (ms === null || ms === undefined) return '--';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    return duration(ms);
  };
  const mins = (ms) => `${Math.round(ms / 60000)}m`;
  const pct = (n) => `${(Math.round(n * 10) / 10).toFixed(1)}%`;
  /** A count for the filter shown: one filter, or all filters (distinct jobs). */
  const count = (o) => (!o ? 0 : ins.filter ? (o.byFilter?.[ins.filter] ?? 0) : o.total);

  const STATUS = {
    completed: { label: 'Completed', icon: '✓' },
    delayed: { label: 'Delayed', icon: '◷' },
    missed: { label: 'Missed', icon: '✕' },
    failed: { label: 'Failed', icon: '!' },
    pending: { label: 'Pending', icon: '…' },
    running: { label: 'Running', icon: '↻' },
  };
  /** Worst first: a row covering several filters shows its worst status. */
  const SEVERITY = ['failed', 'missed', 'delayed', 'running', 'pending', 'completed'];
  const TRIGGER = { scheduler: 'Scheduler', dashboard: 'Open dashboard', manual: 'Search now', 'new-filter': 'New filter', connect: 'Upwork connect', unknown: 'Unknown' };

  const badge = (status, text) => {
    const s = STATUS[status] || STATUS.pending;
    const b = el('span', { class: `st st-${status}` });
    b.append(el('span', { class: 'st-icon', 'aria-hidden': 'true' }, s.icon), document.createTextNode(text || s.label));
    return b;
  };
  /** A date field; by default bound to the selected day (each section has one, as in the design). */
  function dayField(label, value = ins.day, onChange = setDay) {
    const wrap = el('label', { class: 'ins-date' });
    const input = el('input', { type: 'date', max: today() });
    input.value = value;
    input.addEventListener('change', () => input.value && onChange(input.value));
    wrap.append(el('span', {}, label), input);
    return wrap;
  }
  function section(n, title, sub, right) {
    const c = el('section', { class: 'ins-card' });
    const h = el('div', { class: 'ins-head' });
    const t = el('div', { class: 'ins-title' });
    const h3 = el('h3');
    h3.append(el('span', { class: 'ins-num' }, String(n)), document.createTextNode(title));
    t.append(h3, el('p', { class: 'muted' }, sub));
    h.append(t);
    if (right) h.append(right);
    c.append(h);
    return c;
  }
  function kpi(label, value, sub, cls = '') {
    const t = el('div', { class: `kpi ${cls}` });
    const v = el('strong', { class: 'kpi-value' }, String(value));
    if (Number.isInteger(value)) v.dataset.count = String(value);
    t.append(el('span', { class: 'kpi-label' }, label), v);
    if (sub) t.append(sub instanceof Node ? sub : el('span', { class: 'kpi-sub' }, sub));
    return t;
  }
  const subLine = (text, cls) => el('span', { class: `kpi-sub ${cls || ''}` }, text);

  // --- Sidebar and toolbar -------------------------------------------------------------
  function renderSide(d) {
    const list = $('ins-filters');
    const state = typeof lastState !== 'undefined' && lastState ? lastState : null;
    const info = new Map((state?.filters || []).map((f) => [f.name, f]));
    $('ins-active').textContent = `${d.filters.length} Active`;
    const item = (name) => {
      const f = name ? info.get(name) : null;
      const li = el('li', { class: ins.filter === name ? 'active' : '' });
      const b = el('button', { type: 'button', class: 'pick', 'aria-pressed': String(ins.filter === name) });
      const n = name ? (d.jobs.inWindow.byFilter[name] ?? 0) : d.jobs.inWindow.total;
      b.append(el('span', { class: 'name' }, name || 'All filters'), el('span', { class: 'pill' }, `${n} jobs`));
      b.addEventListener('click', () => setFilter(name));
      li.append(b);
      const meta = el('div', { class: 'meta-line' });
      if (!name) {
        meta.append(el('span', {}, 'Combined system total'), el('strong', {}, '100%'));
      } else {
        const ls = f?.lastSearch;
        const parts = [ls ? `Last ${clock(ls.finishedAt || ls.startedAt)}` : 'Never scanned'];
        if (ls) parts.push(ls.status === 'failed' ? 'failed' : `${ls.newJobs} new`);
        if (f?.nextDueAt) parts.push(`Next ${clock(f.nextDueAt)}`);
        meta.append(el('span', {}, parts.join(' • ')));
        const share = d.jobs.inWindow.total ? Math.round((n / d.jobs.inWindow.total) * 100) : 0;
        meta.append(el('strong', {}, `${share}%`));
      }
      li.append(meta);
      const url = f && safeUpworkUrl(f.url);
      if (url) {
        const tools = el('div', { class: 'tools' });
        tools.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open on Upwork ↗'));
        li.append(tools);
      }
      return li;
    };
    list.replaceChildren(item(''), ...d.filters.map((f) => item(f)));

    const sel = $('ins-filter');
    sel.replaceChildren(el('option', { value: '' }, `All filters (${d.jobs.inWindow.total})`), ...d.filters.map((f) => el('option', { value: f }, `${f} (${d.jobs.inWindow.byFilter[f] ?? 0})`)));
    sel.value = ins.filter;
    $('ins-scope').textContent = `${ins.filter || 'All filters'} • ${count(d.jobs.inWindow)} jobs`;
  }

  function syncToolbar() {
    const t = today();
    $('ins-day').max = t;
    $('ins-day').value = ins.day;
    $('ins-today').classList.toggle('on', ins.day === t);
    $('ins-yesterday').classList.toggle('on', ins.day === addDays(t, -1));
    $('ins-week').classList.toggle('on', ins.trend === '7');
    $('ins-custom').classList.toggle('on', ins.trend === 'custom');
  }

  // --- Missed-scan banner ----------------------------------------------------------------
  function renderAlert(d) {
    const box = $('ins-alert');
    const l = d.timetable.last24h;
    const key = `${l.missed}|${l.failed}`;
    if (!(l.missed + l.failed) || ins.alertHiddenFor === key) {
      box.hidden = true;
      return;
    }
    const lastCall = typeof lastState !== 'undefined' ? lastState?.schedule?.lastSchedulerCall : null;
    const msg = el('p');
    msg.append(el('strong', {}, 'Scheduler status notice: '));
    msg.append(document.createTextNode(`${lastCall ? `Last called ${when(lastCall)}. ` : 'The scheduler has never called. '}${l.missed} scheduled scan${l.missed === 1 ? '' : 's'} did not run and ${l.failed} failed in the last 24 hours. Scans are missed when the scheduler does not call and this page is closed or asleep.`));
    const n = l.missed || l.failed;
    const review = el('button', { type: 'button', class: 'review' }, `Review ${n} ${l.missed ? 'missed' : 'failed'} scan${n === 1 ? '' : 's'}`);
    review.addEventListener('click', () => {
      ins.pill = l.missed ? 'missed' : 'failed';
      render(ins.data, 'rows');
      document.getElementById('ins-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const close = el('button', { type: 'button', class: 'close', 'aria-label': 'Hide this notice' });
    close.addEventListener('click', () => {
      ins.alertHiddenFor = key;
      box.hidden = true;
    });
    box.replaceChildren(el('span', { class: 'ins-alert-icon', 'aria-hidden': 'true' }), msg, review, close);
    box.hidden = false;
  }

  /** Scan health for the status row at the top of the page (last 24 hours, all filters). */
  function publishHealth(d) {
    const l = d.timetable.last24h;
    const ran = l.completed + l.delayed;
    const due = ran + l.missed + l.failed;
    const rate = due ? (ran / due) * 100 : 100;
    window.insHealth = { rate, missed: l.missed, failed: l.failed };
    if (typeof lastState !== 'undefined' && lastState) renderSchedule(lastState);
  }

  // --- 1. Daily job posting insights -----------------------------------------------------
  function postingsCard(d) {
    const right = el('div', { class: 'ins-head-tools' });
    right.append(dayField('Date'));
    const cmp = el('label', { class: 'ins-check' });
    const box = el('input', { type: 'checkbox' });
    box.checked = ins.compareOn;
    box.addEventListener('change', () => {
      ins.compareOn = box.checked;
      if (ins.compareOn && !ins.compareDay) ins.compareDay = addDays(ins.day, -1);
      save();
      load();
    });
    cmp.append(box, el('span', {}, 'Compare'));
    right.append(cmp);
    if (ins.compareOn) {
      right.append(dayField('With', ins.compareDay, (v) => {
        ins.compareDay = v;
        save();
        load();
      }));
    }
    const c = section(1, 'Daily Job Posting Insights', `New Upwork jobs matching ${ins.filter ? `"${ins.filter}"` : 'your filters'}, by the hour and day they were posted. A job that matches two filters counts once in "All filters". History is kept ${d.retentionDays} days.`, right);

    // KPI tiles.
    const vol = count(d.jobs.inWindow);
    const cmpDay = d.jobs.compare?.day;
    const cmpVol = count(d.jobs.compare?.counts);
    let change = null;
    if (cmpDay) {
      const diff = cmpVol ? ((vol - cmpVol) / cmpVol) * 100 : null;
      const label = ins.compareOn ? `vs ${shortDate(cmpDay)}` : 'vs day before';
      change = diff === null
        ? subLine(`${cmpVol} jobs ${label}`, 'muted')
        : subLine(`${diff >= 0 ? '▲ +' : '▼ '}${pct(diff)} ${label}`, diff >= 0 ? 'up' : 'down');
    }
    const hours = d.jobs.hours.map((h) => ({ ...h, n: count(h) }));
    const peak = hours.reduce((a, b) => (b.n > a.n ? b : a), hours[0]);
    const peakEnd = new Date(Date.parse(peak.start) + 3_600_000).toISOString();
    let lead;
    if (!d.filters.length) lead = kpi('Leading filter share', '—', 'No filters yet');
    else if (ins.filter) {
      const share = d.jobs.inWindow.total ? (vol / d.jobs.inWindow.total) * 100 : 0;
      lead = kpi('Filter share', `${ins.filter} (${pct(share)})`, `${vol} of ${d.jobs.inWindow.total} postings`);
    } else {
      const top = d.filters.reduce((a, b) => ((d.jobs.inWindow.byFilter[b] ?? 0) > (d.jobs.inWindow.byFilter[a] ?? 0) ? b : a));
      const n = d.jobs.inWindow.byFilter[top] ?? 0;
      lead = kpi('Leading filter share', vol ? `${top} (${pct((n / vol) * 100)})` : '—', `${n} postings captured`);
    }
    // New jobs per scan, for the filter shown.
    let scans = 0;
    let found = 0;
    for (const r of d.scans.runs) {
      for (const f of r.filters) {
        if (ins.filter && f.name !== ins.filter) continue;
        if (f.outcome !== 'ok') continue;
        scans++;
        found += f.newJobs;
      }
    }
    if (!ins.filter) scans = d.scans.runs.filter((r) => r.status === 'ok' || r.status === 'partial').length;
    const avg = scans ? found / scans : null;
    const tiles = el('div', { class: 'kpis' });
    tiles.append(
      kpi('24-hour job volume', vol, change || subLine(longDay(ins.day), 'muted'), 'hero'),
      kpi('Peak velocity window', peak.n ? `${hourLabel(peak.start)} – ${hourLabel(peakEnd)}` : '—', peak.n ? subLine(`● ${peak.n} job${peak.n === 1 ? '' : 's'} posted in 1 hour`, 'dot-amber') : 'No jobs posted yet'),
      lead,
      kpi('Avg intake / scan', avg === null ? '—' : `${avg.toFixed(1)} Jobs`, avg === null ? 'No scans this day' : subLine(avg >= 1 ? 'Healthy client activity' : 'Quiet period', avg >= 1 ? 'up' : 'muted')),
    );
    c.append(tiles);
    c.append(hourlyChart(d, hours));
    c.append(trendPanel(d));
    return c;
  }

  function hourlyChart(d, hours) {
    const box = el('div', { class: 'ins-panel' });
    const head = el('div', { class: 'panel-head' });
    const t = el('div');
    t.append(el('h4', {}, 'Hourly Job Posting Velocity (Full 24 Hours: 00:00 – 23:00)'), el('p', { class: 'muted' }, 'New jobs posted in each hour. Hover a bar to see each filter’s count.'));
    const legend = el('div', { class: 'legend-inline' });
    legend.append(el('span', { class: 'lg lg-main' }, `Selected day (${shortDate(ins.day)})`));
    const cmp = ins.compareOn && d.jobs.compare ? d.jobs.compare.hours.map((h) => count(h)) : null;
    if (cmp) legend.append(el('span', { class: 'lg lg-cmp' }, `Compare (${shortDate(d.jobs.compare.day)})`));
    head.append(t, legend);
    box.append(head);

    const readout = el('p', { class: 'readout' });
    const describe = (h, i) => {
      readout.replaceChildren(el('strong', {}, `${hourLabel(h.start)} – ${hourLabel(new Date(Date.parse(h.start) + 3_600_000).toISOString())}: ${h.n} job${h.n === 1 ? '' : 's'}`));
      const parts = (ins.filter ? [ins.filter] : d.filters).map((f) => `${f} ${h.byFilter[f] ?? 0}`).join(' · ');
      if (parts && !ins.filter) readout.append(document.createTextNode(` — ${parts}`));
      if (cmp) readout.append(el('span', { class: 'muted' }, ` · compare day ${cmp[i]}`));
    };
    const max = Math.max(1, ...hours.map((h) => h.n), ...(cmp || []));
    const peakN = Math.max(...hours.map((h) => h.n));
    const chart = el('div', { class: 'hbars', role: 'list', 'aria-label': 'Jobs posted per hour' });
    hours.forEach((h, i) => {
      const col = el('div', { class: `hbar-col${h.n && h.n === peakN ? ' peak' : ''}`, role: 'listitem', tabindex: '0', 'aria-label': `${hourLabel(h.start)}: ${h.n} jobs` });
      const track = el('div', { class: 'hbar-track' });
      if (cmp) {
        const cb = el('span', { class: 'hbar cmp' });
        cb.style.height = `${Math.max((cmp[i] / max) * 100, 2)}%`;
        track.append(cb);
      }
      const bar = el('span', { class: `hbar${h.n ? '' : ' zero'}` });
      bar.style.height = `${Math.max((h.n / max) * 100, 3)}%`;
      track.append(bar);
      col.append(track, el('span', { class: 'hbar-label' }, hourLabel(h.start).replace(' ', '')));
      col.addEventListener('mouseenter', () => describe(h, i));
      col.addEventListener('focus', () => describe(h, i));
      chart.append(col);
    });
    const peakIdx = hours.findIndex((h) => h.n === peakN);
    const reset = () => describe(hours[Math.max(peakIdx, 0)], Math.max(peakIdx, 0));
    chart.addEventListener('mouseleave', reset);
    reset();
    box.append(readout, chart);
    return box;
  }

  function trendPanel(d) {
    const box = el('div', { class: 'ins-panel', id: 'ins-trend' });
    const head = el('div', { class: 'panel-head' });
    const t = el('div');
    const h4 = el('h4', {}, 'Job Posting Volume Trends & History');
    const labels = { 7: '7 Days', 15: '15 Days', 30: '30 Days', custom: 'Custom Range', month: 'Month vs Month' };
    h4.append(el('span', { class: 'chip filter' }, ins.trend === 'month' ? 'Month vs Month' : `${d.jobs.posted.length} Days Velocity`));
    t.append(h4, el('p', { class: 'muted' }, 'Hiring cadence across the days you pick. Click a bar to open that day above.'));
    const seg = el('div', { class: 'segmented', role: 'tablist' });
    for (const k of ['7', '15', '30', 'custom', 'month']) {
      const b = el('button', { type: 'button', role: 'tab', class: ins.trend === k ? 'active' : '', 'aria-selected': String(ins.trend === k) }, labels[k]);
      b.addEventListener('click', () => setTrend(k));
      seg.append(b);
    }
    head.append(t, seg);
    box.append(head);

    const days = d.jobs.posted.map((x) => ({ ...x, n: count(x) }));
    const first = days[0]?.day;
    const last = days.at(-1)?.day;
    const total = days.reduce((s, x) => s + x.n, 0);
    const peak = days.reduce((a, b) => (b.n > a.n ? b : a), days[0]);

    const info = el('div', { class: 'trend-info' });
    const range = el('div', { class: 'trend-range' });
    const from = el('input', { type: 'date', max: today(), 'aria-label': 'From' });
    const to = el('input', { type: 'date', max: today(), 'aria-label': 'To' });
    from.value = first || '';
    to.value = last || '';
    const custom = () => {
      if (!from.value || !to.value) return;
      ins.trend = 'custom';
      ins.trendFrom = from.value < to.value ? from.value : to.value;
      ins.trendTo = from.value < to.value ? to.value : from.value;
      save();
      load();
    };
    from.addEventListener('change', custom);
    to.addEventListener('change', custom);
    const fl = el('label', { class: 'ins-date' });
    fl.append(el('span', {}, 'From'), from);
    const tl = el('label', { class: 'ins-date' });
    tl.append(el('span', {}, 'To'), to);
    range.append(fl, el('span', { class: 'muted' }, '–'), tl);
    const stats = el('div', { class: 'trend-stats' });
    const total1 = el('p');
    total1.append(document.createTextNode(`${days.length} Days Total: `), el('strong', { class: 'accent' }, `${total.toLocaleString()} jobs`));
    const avg = el('p');
    avg.append(document.createTextNode('Daily Avg: '), el('strong', {}, `${days.length ? Math.round(total / days.length) : 0} jobs/day`));
    stats.append(total1, avg);
    if (peak?.n) {
      const p = el('p', { class: 'up' });
      p.append(document.createTextNode(`● Peak: ${longDay(peak.day)} (${peak.n} jobs)`));
      stats.append(p);
    }
    info.append(range, stats, el('p', { class: 'muted hint' }, 'Pick dates to check any day-to-day range (up to 62 days).'));
    box.append(info);

    if (ins.trend === 'month') box.append(monthChart(days));
    else box.append(dayChart(days));
    return box;
  }

  function dayChart(days) {
    const max = Math.max(1, ...days.map((x) => x.n));
    const peakN = Math.max(...days.map((x) => x.n));
    const chart = el('div', { class: `dbars${days.length > 16 ? ' dense' : ''}`, role: 'list', 'aria-label': 'Jobs posted per day' });
    for (const x of days) {
      const b = el('button', { type: 'button', role: 'listitem', class: `dbar-col${x.day === ins.day ? ' sel' : ''}${x.n && x.n === peakN ? ' peak' : ''}`, 'aria-label': `${longDay(x.day)}: ${x.n} jobs` });
      const bar = el('span', { class: `dbar${x.n ? '' : ' zero'}` });
      bar.style.height = `${Math.max((x.n / max) * 100, 2)}%`;
      const track = el('span', { class: 'dbar-track' });
      track.append(bar);
      const dt = new Date(`${x.day}T12:00:00`);
      const lab = el('span', { class: 'dbar-day' });
      lab.append(el('strong', {}, String(dt.getDate())), el('span', {}, dt.toLocaleDateString([], { weekday: 'short' }).toUpperCase()));
      b.append(el('span', { class: 'dbar-val' }, String(x.n)), track, lab);
      b.title = `${longDay(x.day)}: ${x.n} jobs`;
      b.addEventListener('click', () => setDay(x.day));
      chart.append(b);
    }
    return chart;
  }

  /** This month's days next to the same dates last month. */
  function monthChart(days) {
    const t = today();
    const thisMonth = t.slice(0, 7);
    const cur = days.filter((x) => x.day.startsWith(thisMonth));
    const byDay = new Map(days.map((x) => [x.day, x.n]));
    const prevKey = (key) => {
      const d = new Date(`${key}T12:00:00`);
      const p = new Date(d.getFullYear(), d.getMonth() - 1, d.getDate(), 12);
      return p.getMonth() === (d.getMonth() + 11) % 12 ? dayKey(p.toISOString()) : null;
    };
    const pairs = cur.map((x) => ({ ...x, prev: byDay.get(prevKey(x.day)) ?? 0 }));
    const a = pairs.reduce((s, x) => s + x.n, 0);
    const b = pairs.reduce((s, x) => s + x.prev, 0);
    const wrap = el('div');
    const sum = el('p', { class: 'month-sum' });
    const name = (key) => new Date(`${key}T12:00:00`).toLocaleDateString([], { month: 'long' });
    sum.append(el('strong', {}, `${name(t)} so far: ${a} jobs`), document.createTextNode(` vs ${b} in the same days of ${name(addDays(`${thisMonth}-01`, -1))}`));
    if (b) sum.append(el('span', { class: a >= b ? 'up' : 'down' }, ` (${a >= b ? '+' : ''}${pct(((a - b) / b) * 100)})`));
    wrap.append(sum);
    const max = Math.max(1, ...pairs.map((x) => Math.max(x.n, x.prev)));
    const chart = el('div', { class: 'dbars dense', role: 'list', 'aria-label': 'Jobs per day, this month vs last month' });
    for (const x of pairs) {
      const col = el('button', { type: 'button', role: 'listitem', class: `dbar-col${x.day === ins.day ? ' sel' : ''}`, title: `${longDay(x.day)}: ${x.n} jobs · last month ${x.prev}` });
      const track = el('span', { class: 'dbar-track pair' });
      const pb = el('span', { class: 'dbar cmp' });
      pb.style.height = `${Math.max((x.prev / max) * 100, 2)}%`;
      const cb = el('span', { class: `dbar${x.n ? '' : ' zero'}` });
      cb.style.height = `${Math.max((x.n / max) * 100, 2)}%`;
      track.append(pb, cb);
      const lab = el('span', { class: 'dbar-day' });
      lab.append(el('strong', {}, String(new Date(`${x.day}T12:00:00`).getDate())));
      col.append(el('span', { class: 'dbar-val' }, String(x.n)), track, lab);
      col.addEventListener('click', () => setDay(x.day));
      chart.append(col);
    }
    const legend = el('div', { class: 'legend-inline' });
    legend.append(el('span', { class: 'lg lg-main' }, 'This month'), el('span', { class: 'lg lg-cmp' }, 'Last month (job history is kept 30 days)'));
    wrap.append(chart, legend);
    return wrap;
  }

  // --- Slots for the filter shown ----------------------------------------------------------
  /** Timetable slots, one row per time: filters scanned in the same run share a row. */
  function slotRows(d) {
    const runOf = new Map();
    for (const r of d.scans.runs) for (const f of r.filters) runOf.set(`${f.name}|${f.startedAt}`, { run: r, f });
    const groups = new Map();
    for (const tf of d.timetable.byFilter) {
      if (ins.filter && tf.name !== ins.filter) continue;
      for (const s of tf.slots) {
        const hit = s.scanAt ? runOf.get(`${tf.name}|${s.scanAt}`) : null;
        const key = hit ? `run:${hit.run.runId}` : `${s.status}:${s.dueAt.slice(0, 16)}`;
        if (!groups.has(key)) groups.set(key, { key, run: hit?.run || null, slots: [] });
        groups.get(key).slots.push({ filter: tf.name, slot: s, scan: hit?.f || null });
      }
    }
    return [...groups.values()]
      .map((g) => {
        const status = SEVERITY.find((st) => g.slots.some((x) => x.slot.status === st)) || 'pending';
        const dueAt = g.slots.map((x) => x.slot.dueAt).sort()[0];
        const scanAt = g.slots.map((x) => x.slot.scanAt).filter(Boolean).sort()[0] || null;
        const delayMs = Math.max(0, ...g.slots.map((x) => x.slot.delayMs || 0)) || null;
        const late = g.slots.some((x) => x.slot.late);
        const error = g.slots.map((x) => x.slot.error).find(Boolean) || null;
        return { ...g, status, dueAt, scanAt, delayMs, late, error };
      })
      .sort((a, b) => b.dueAt.localeCompare(a.dueAt));
  }

  // --- 2. Missed scans & reliability matrix ----------------------------------------------------
  function reliabilityCard(d, rows) {
    const one = ins.filter ? d.timetable.byFilter.find((f) => f.name === ins.filter) : null;
    const counts = one ? one.counts : d.timetable.counts;
    const ran = counts.completed + counts.delayed;
    const due = ran + counts.missed + counts.failed;
    const sla = due ? (ran / due) * 100 : 100;
    const right = el('div', { class: 'ins-head-tools' });
    right.append(dayField('Audit date'), el('span', { class: `sla ${sla >= 90 ? 'good' : sla >= 70 ? 'warn' : 'bad'}` }, `● ${pct(sla)} Execution SLA`));
    const c = section(2, 'Missed Scans & Reliability Matrix', `Each filter should be scanned every ${d.intervalMinutes} min. A scan more than ${d.graceMinutes} min late is Delayed; a ${d.intervalMinutes}-min slot with no scan is Missed; a scan that errored or stopped is Failed.`, right);

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const nextPending = rows.filter((r) => r.status === 'pending' || r.status === 'running').map((r) => r.dueAt).sort()[0];
    const lastError = rows.find((r) => r.status === 'failed')?.error;
    const tiles = el('div', { class: 'matrix' });
    const m = (st, label, value, sub, icon) => {
      const t = el('div', { class: `mx st-${st}${value && ['missed', 'failed', 'delayed'].includes(st) ? ' alert' : ''}` });
      const top = el('div', { class: 'mx-top' });
      top.append(el('span', { class: 'kpi-label' }, label), el('span', { class: `mx-dot${icon ? ' icon' : ''}`, 'aria-hidden': 'true' }));
      const v = el('strong', { class: 'kpi-value' }, String(value));
      if (Number.isInteger(value)) v.dataset.count = String(value);
      t.append(top, v, el('span', { class: 'kpi-sub' }, sub));
      return t;
    };
    tiles.append(
      m('total', 'Total scans', total, `Every ${d.intervalMinutes} min · ${ins.filter ? ins.filter : `${d.filters.length} filters`}`, true),
      m('completed', 'Completed', counts.completed, 'Scanned successfully'),
      m('missed', 'Missed', counts.missed, 'Unexecuted windows'),
      m('failed', 'Failed', counts.failed, lastError ? lastError.slice(0, 40) : 'Errors or cut off'),
      m('delayed', 'Delayed', counts.delayed, `> ${d.graceMinutes} min after schedule`),
      m('pending', 'Pending', counts.pending + counts.running, nextPending ? `Due at ${clock(nextPending)}` : 'Nothing queued'),
    );
    c.append(tiles);

    // Root causes: runs of missed slots become one window; failed and delayed scans stand alone.
    const issues = [...rows].filter((r) => ['missed', 'failed', 'delayed'].includes(r.status)).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    const causes = [];
    for (const r of issues) {
      const prev = causes.at(-1);
      if (r.status === 'missed' && prev?.status === 'missed' && Date.parse(r.dueAt) - Date.parse(prev.end) <= (d.intervalMinutes + 2) * 60000) {
        prev.end = r.dueAt;
        prev.n++;
      } else causes.push({ status: r.status, start: r.dueAt, end: r.dueAt, n: 1, row: r });
    }
    const diag = el('div', { class: 'diag' });
    const dh = el('div', { class: 'diag-head' });
    dh.append(el('strong', {}, 'Diagnostic root cause:'), el('span', { class: 'muted' }, `Audit for ${ins.day}`));
    diag.append(dh);
    const grid = el('div', { class: 'diag-grid' });
    const shown = causes.reverse().slice(0, 6);
    if (!shown.length) {
      const ok = el('div', { class: 'cause st-completed' });
      ok.append(el('strong', {}, '✓ Every scheduled scan ran'), el('p', {}, `No missed, failed or late scans on ${longDay(ins.day)}.`));
      grid.append(ok);
    }
    for (const cs of shown) {
      const card = el('div', { class: `cause st-${cs.status}` });
      const span = cs.n > 1 ? `${clock(cs.start)} – ${clock(cs.end)}` : clock(cs.start);
      const title = cs.status === 'missed' ? `Scheduler gap (${span})` : cs.status === 'failed' ? `Scan failed (${span})` : `Late start (${span})`;
      const text = cs.status === 'missed'
        ? `${cs.n} scheduled scan${cs.n === 1 ? '' : 's'} did not run: the scheduler did not call and the dashboard was closed or asleep.`
        : cs.status === 'failed'
          ? cs.row.error || 'The scan started but stopped before finishing.'
          : `Ran at ${clock(cs.row.scanAt)}, ${mins(cs.row.delayMs || 0)} after schedule.`;
      card.append(el('strong', {}, `${STATUS[cs.status].icon} ${title}`), el('p', {}, text));
      grid.append(card);
    }
    if (causes.length > shown.length) grid.append(el('p', { class: 'muted more-causes' }, `+ ${causes.length - shown.length} earlier — see the schedule below.`));
    diag.append(grid);
    c.append(diag);
    return c;
  }

  // --- 3. Scan schedule & history ---------------------------------------------------------
  function historyCard(d, rows) {
    const right = el('div', { class: 'ins-head-tools col' });
    right.append(dayField('Date'));
    const pills = el('div', { class: 'pills', role: 'group', 'aria-label': 'Show scans' });
    const n = (st) => rows.filter((r) => r.status === st).length;
    for (const [k, label] of [['all', `All (${rows.length})`], ['missed', `Missed (${n('missed')})`], ['failed', `Failed (${n('failed')})`], ['delayed', `Delayed (${n('delayed')})`], ['completed', `Completed (${n('completed')})`]]) {
      const b = el('button', { type: 'button', class: `pill-btn p-${k}${ins.pill === k ? ' on' : ''}`, 'aria-pressed': String(ins.pill === k) }, label);
      b.addEventListener('click', () => {
        ins.pill = k;
        render(ins.data, 'rows');
      });
      pills.append(b);
    }
    right.append(pills);
    const c = section(3, 'Scan Schedule & History', 'Every scheduled scan in time order, newest first: when it was due, when it ran, how long it took, which filters it checked and the jobs it found.', right);
    c.id = 'ins-history';

    const shown = rows.filter((r) => ins.pill === 'all' || r.status === ins.pill);
    const wrap = el('div', { class: 'table-wrap' });
    const t = el('table', { class: 'ins-table sched-table' });
    const tr = el('tr');
    for (const h of ['Execution status', 'Scheduled time', 'Actual executed', 'Duration', 'Filters checked', 'Jobs discovered', 'Time gap / variance', 'Diagnostic']) tr.append(el('th', { scope: 'col' }, h));
    t.append(el('thead'));
    t.tHead.append(tr);
    const body = el('tbody');
    if (!shown.length) {
      const empty = el('tr');
      const cell = el('td', { colspan: '8', class: 'empty-row' }, ins.pill === 'all' ? 'No scans scheduled on this day.' : `No ${ins.pill} scans on this day.`);
      empty.append(cell);
      body.append(empty);
    }
    for (const r of shown) {
      const row = el('tr', { class: `r-${r.status}` });
      const cell = (content, cls) => {
        const td = el('td', cls ? { class: cls } : {});
        if (content instanceof Node) td.append(content);
        else td.textContent = content;
        return td;
      };
      const label = r.status === 'pending' && r.late ? 'Overdue' : undefined;
      row.append(cell(badge(r.status, label)), cell(clock(r.dueAt), 'strong'));
      row.append(cell(r.scanAt ? new Date(r.scanAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : r.status === 'missed' ? 'NOT RUN' : '--:--', 'mono'));
      row.append(cell(r.status === 'missed' ? '0s' : r.status === 'running' ? 'running…' : r.run ? secs(r.run.durationMs) : '--', 'mono'));
      const chips = el('div', { class: 'chips' });
      for (const x of r.slots) {
        const ok = !x.scan || x.scan.outcome === 'ok';
        chips.append(el('span', { class: `chip${ok ? '' : ' bad'}`, title: x.scan?.error || '' }, x.filter));
      }
      row.append(cell(chips));
      const found = r.slots.reduce((s, x) => s + (x.scan?.newJobs || 0), 0);
      row.append(cell(found ? el('span', { class: 'new-pill' }, `+${found} new`) : '0', 'num-l'));
      row.append(cell(variance(r, d), 'mono'));
      const inspect = el('button', { type: 'button', class: 'link inspect', 'aria-expanded': String(ins.inspect.has(r.key)) }, ins.inspect.has(r.key) ? 'Close' : 'Inspect');
      inspect.addEventListener('click', () => {
        if (ins.inspect.has(r.key)) ins.inspect.delete(r.key);
        else {
          ins.inspect.add(r.key);
          ins.justOpened = r.key;
        }
        render(ins.data);
      });
      row.append(cell(inspect));
      body.append(row);
      if (ins.inspect.has(r.key)) body.append(detailRow(r));
    }
    t.append(body);
    wrap.append(t);
    c.append(wrap);

    const foot = el('div', { class: 'table-foot' });
    const left = el('span', { class: 'muted' });
    left.append(document.createTextNode('Showing '), el('strong', {}, String(shown.length)), document.createTextNode(` scan${shown.length === 1 ? '' : 's'} on ${longDay(ins.day)}`));
    const rightFoot = el('div', { class: 'foot-right' });
    rightFoot.append(el('span', { class: 'muted' }, 'Refreshes every 60 seconds'));
    const csv = el('button', { type: 'button', class: 'link csv' }, 'Export CSV');
    csv.addEventListener('click', () => exportCsv(shown, d));
    rightFoot.append(csv);
    foot.append(left, rightFoot);
    c.append(foot);
    return c;
  }

  function variance(r, d) {
    if (r.status === 'missed') return 'Skipped';
    if (r.status === 'pending') {
      const ms = Date.parse(r.dueAt) - Date.now();
      return ms > 30000 ? `Scheduled in ${mins(ms)}` : ms > -60000 ? 'Due now' : `Overdue ${mins(-ms)}`;
    }
    if (r.status === 'running') return 'Scanning now';
    const gap = r.run?.gapMs;
    const base = gap === null || gap === undefined ? 'First scan' : `+${mins(gap)}`;
    if (r.status === 'delayed') return `${base} (+${mins(r.delayMs || 0)} late)`;
    if (r.status === 'failed') return `${base} (halted)`;
    if (!gap) return base;
    const interval = d.intervalMinutes * 60000;
    // Early scans come from "Search now" or the open dashboard; longer gaps follow missed slots.
    return `${base} (${Math.abs(gap - interval) < 60000 ? 'exact' : gap < interval ? 'early' : 'on schedule'})`;
  }

  function detailRow(r) {
    const tr = el('tr', { class: `detail-row${r.key === ins.justOpened ? ' opening' : ''}` });
    const td = el('td', { colspan: '8' });
    const box = el('div', { class: 'inspect-box' });
    const facts = el('p');
    const bits = [`Scheduled ${new Date(r.dueAt).toLocaleString()}`];
    if (r.run) {
      bits.push(`Started by ${TRIGGER[r.run.trigger] || r.run.trigger}`);
      bits.push(`Started ${new Date(r.run.startedAt).toLocaleTimeString()}`);
      if (r.run.finishedAt) bits.push(`Finished ${new Date(r.run.finishedAt).toLocaleTimeString()}`);
    }
    facts.textContent = bits.join(' · ');
    box.append(facts);
    const list = el('ul');
    for (const x of r.slots) {
      const li = el('li');
      li.append(el('strong', {}, `${x.filter}: `));
      let text;
      if (x.slot.status === 'missed') text = 'No scan ran in this slot (the scheduler did not call and the dashboard was closed).';
      else if (x.slot.status === 'pending') text = x.slot.late ? `Due ${until(x.slot.dueAt)}; waiting for the scheduler.` : `Due ${until(x.slot.dueAt)}.`;
      else if (x.scan) {
        text = `${STATUS[x.slot.status].label} · ${x.scan.returned} returned, ${x.scan.pages} page(s), ${x.scan.newJobs} new`;
        if (x.scan.moreNotFetched) text += ', more results not fetched';
        if (x.slot.delayMs) text += ` · started ${mins(x.slot.delayMs)} late`;
        if (x.scan.error) text += ` · ${x.scan.error}`;
      } else text = STATUS[x.slot.status].label + (x.slot.error ? ` · ${x.slot.error}` : '');
      li.append(document.createTextNode(text));
      list.append(li);
    }
    box.append(list);
    td.append(box);
    tr.append(td);
    return tr;
  }

  function exportCsv(rows, d) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Status', 'Scheduled', 'Executed', 'Duration (s)', 'Filters', 'New jobs', 'Gap / variance', 'Error'].map(q).join(',')];
    for (const r of rows) {
      lines.push([
        STATUS[r.status].label,
        new Date(r.dueAt).toLocaleString(),
        r.scanAt ? new Date(r.scanAt).toLocaleString() : '',
        r.run?.durationMs ? Math.round(r.run.durationMs / 1000) : '',
        r.slots.map((x) => x.filter).join('; '),
        r.slots.reduce((s, x) => s + (x.scan?.newJobs || 0), 0),
        variance(r, d),
        r.error || '',
      ].map(q).join(','));
    }
    const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
    const a = el('a', { href: url, download: `scan-schedule-${ins.day}${ins.filter ? `-${ins.filter}` : ''}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- Motion -------------------------------------------------------------------------------
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Numbers each item in a group, for staggered entrance delays (capped so long lists stay quick). */
  function stagger(nodes, cap = 14) {
    [...nodes].forEach((n, i) => n.style.setProperty('--i', String(Math.min(i, cap))));
  }
  /** Whole-number tiles count up from zero. */
  function countUp(root) {
    if (reduced() || document.hidden) return;
    for (const n of root.querySelectorAll('[data-count]')) {
      const to = Number(n.dataset.count);
      if (!to) continue;
      const start = performance.now();
      let done = false;
      const step = (t) => {
        if (done) return;
        const p = Math.min((t - start) / 700, 1);
        n.textContent = String(Math.round(to * (1 - (1 - p) ** 3)));
        if (p < 1) requestAnimationFrame(step);
      };
      n.textContent = '0';
      requestAnimationFrame(step);
      // Frames pause in background tabs: always land on the real number.
      setTimeout(() => {
        done = true;
        n.textContent = String(to);
      }, 760);
    }
  }

  // --- Page ---------------------------------------------------------------------------------
  /**
   * anim: "full" when the view changes (cards, tiles and bars animate in), "rows" when only
   * the schedule table changes, "none" for the quiet background refresh.
   */
  function render(d, anim = 'none') {
    if (!d) return;
    syncToolbar();
    renderSide(d);
    const side = $('ins-filters');
    side.classList.toggle('enter', anim === 'full');
    stagger(side.children);
    renderAlert(d);
    const body = $('ins-body');
    body.dataset.anim = anim;
    if (!d.filters.length) {
      body.replaceChildren(el('div', { class: 'empty' }, 'Add a filter to start collecting insights.'));
      return;
    }
    const rows = slotRows(d);
    body.replaceChildren(postingsCard(d), reliabilityCard(d, rows), historyCard(d, rows));
    stagger(body.children);
    for (const group of body.querySelectorAll('.kpis, .matrix, .diag-grid, .hbars, .dbars')) stagger(group.children, 30);
    for (const panel of body.querySelectorAll('.ins-panel')) panel.style.setProperty('--i', '2');
    stagger(body.querySelectorAll('.sched-table tbody tr:not(.detail-row)'), 20);
    for (const chart of body.querySelectorAll('.hbars, .dbars')) {
      [...chart.children].forEach((col, i) => col.querySelectorAll('.hbar, .dbar').forEach((b) => b.style.setProperty('--i', String(i))));
    }
    if (anim === 'full') countUp(body);
    ins.justOpened = '';
  }

  async function load(anim = 'full') {
    const seq = ++ins.seq;
    if (!ins.day) ins.day = today();
    const p = new URLSearchParams({ tz: String(tz()), day: ins.day, compare: ins.compareOn && ins.compareDay ? ins.compareDay : addDays(ins.day, -1) });
    if (ins.trend === 'custom' && ins.trendFrom && ins.trendTo) {
      p.set('from', ins.trendFrom);
      p.set('to', ins.trendTo);
    } else if (ins.trend === 'month') {
      const t = today();
      p.set('from', addDays(`${t.slice(0, 7)}-01`, -1).slice(0, 7) + '-01');
      p.set('to', t);
    } else p.set('days', ['7', '15', '30'].includes(ins.trend) ? ins.trend : '7');
    syncToolbar();
    try {
      const d = await api(`/api/insights?${p}`);
      if (seq !== ins.seq) return;
      // A remembered filter that was removed meanwhile falls back to "All filters".
      if (ins.filter && !d.filters.includes(ins.filter)) ins.filter = '';
      ins.data = d;
      render(d, anim);
      publishHealth(d);
    } catch (err) {
      if (!(err instanceof LoginRequired)) $('ins-body').replaceChildren(el('div', { class: 'empty' }, `Could not load insights: ${err.message}`));
    }
  }

  function setDay(day) {
    if (!day) return;
    ins.day = day > today() ? today() : day;
    ins.inspect.clear();
    load();
  }
  function setFilter(name) {
    ins.filter = name;
    save();
    render(ins.data, 'full');
  }
  function setTrend(k) {
    ins.trend = k;
    if (k === 'custom' && !(ins.trendFrom && ins.trendTo)) {
      ins.trendTo = today();
      ins.trendFrom = addDays(ins.trendTo, -13);
    }
    save();
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
      ins.timer = setInterval(() => load('none'), 60000);
    }
  }

  for (const b of document.querySelectorAll('.view-tabs button')) b.addEventListener('click', () => showView(b.dataset.view));
  $('ins-day').addEventListener('change', (e) => setDay(e.target.value));
  $('ins-filter').addEventListener('change', (e) => setFilter(e.target.value));
  $('ins-today').addEventListener('click', () => setDay(today()));
  $('ins-yesterday').addEventListener('click', () => setDay(addDays(today(), -1)));
  $('ins-week').addEventListener('click', () => {
    ins.trend = '7';
    save();
    setDay(today());
  });
  $('ins-custom').addEventListener('click', () => {
    setTrend('custom');
    setTimeout(() => document.getElementById('ins-trend')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
  });
  let saved = 'jobs';
  try { saved = localStorage.getItem(SAVED_VIEW) || 'jobs'; } catch { /* storage unavailable */ }
  showView(saved === 'insights' ? 'insights' : 'jobs');
})();
