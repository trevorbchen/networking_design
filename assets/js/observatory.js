/* =============================================================================
 * observatory.js — the incident-debugging console.
 *
 * Tabs: Brief · Service Map · Metrics · Heatmap · Timeline · Traces · Logs · Report
 * State per scenario (notes, pins, custom charts, hints) persists in localStorage.
 * ========================================================================== */
(function () {
  'use strict';
  const { el, fmt } = OBS;
  const TABS = [
    ['brief', 'Brief'], ['map', 'Service Map'], ['metrics', 'Metrics'], ['heatmap', 'Heatmap'],
    ['timeline', 'Timeline'], ['traces', 'Traces'], ['logs', 'Logs'], ['report', 'Report'],
  ];
  const S = { c: null, id: null, range: [0, 1], cursor: null, tab: 'brief', charts: [], st: null, selTrace: null, failed: [] };
  const ctx = {
    get c() { return S.c; },
    range: () => S.range,
    setRange: (a, b) => setRange(a, b),
    cursor: () => S.cursor,
    setCursor: (t) => setCursor(t),
    pin: (p) => addPin(p),
    onChange: () => save(),
  };

  // ------------------------------------------------------------ storage ----
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  function save() {
    if (!S.id) return;
    S.st.tab = S.tab;
    LS.set('obs:' + S.id, S.st);
  }
  function freshState() { return { notes: {}, pins: [], custom: [], hints: 0, opened: Date.now(), tab: 'brief' }; }

  // ------------------------------------------------------------ loading ----
  function loadAll(cb) {
    const files = OBS.manifest || [];
    if (!files.length) return cb();
    let pending = files.length;
    for (const f of files) {
      const sc = document.createElement('script');
      sc.src = 'scenarios/' + f;
      sc.onload = () => { if (--pending === 0) cb(); };
      sc.onerror = () => { S.failed.push(f); if (--pending === 0) cb(); };
      document.head.append(sc);
    }
  }

  // ------------------------------------------------------------- shell -----
  const $ = {};
  function shell() {
    const app = document.getElementById('app'); app.innerHTML = '';
    $.sel = el('select', { title: 'Switch scenario', onchange: () => { location.hash = $.sel.value ? 's=' + $.sel.value : ''; } });
    const ids = Object.keys(OBS.scenarios).sort();
    $.sel.append(el('option', { value: '' }, '— choose a scenario —'));
    for (const id of ids) {
      const s = OBS.scenarios[id];
      $.sel.append(el('option', { value: id }, id.slice(0, 3) + ' · ' + s.title));
    }
    $.range = el('div', { class: 'timepill', title: 'Current time window. Drag across any chart to zoom in.' });
    $.cursor = el('div', { class: 'cursor-box' });
    app.append(el('div', { class: 'topbar' },
      el('a', { class: 'brand', href: 'index.html', title: 'Home' }, 'Obs', el('span', {}, 'ervatory')),
      $.sel,
      $.title = el('div', { class: 'scen-title' }),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn-icon', title: 'Keyboard shortcuts & how to use the tools (?)', onclick: help }, '? help'),
    ));
    $.tabs = el('div', { class: 'tabs', role: 'tablist' });
    TABS.forEach(([id, label], k) => $.tabs.append(el('button', { class: 'tab', role: 'tab', 'data-tab': id, title: TAB_HELP[id] + '  (key ' + (k + 1) + ')', onclick: () => showTab(id) }, label)));
    $.timectl = el('div', { class: 'timectl' }, $.cursor, $.range,
      el('button', { class: 'btn-icon', title: 'Zoom out 2× (z)', onclick: () => S.c && zoomOut() }, '− zoom'),
      el('button', { class: 'btn-icon', title: 'Show the whole incident window (or double-click any chart)', onclick: () => S.c && setRange(0, S.c.duration) }, 'reset'));
    $.tabs.append($.timectl);
    app.append($.tabs);
    $.main = el('div', { class: 'main' });
    app.append($.main);
    $.toast = el('div', { class: 'toast' }); document.body.append($.toast);
  }
  const TAB_HELP = {
    brief: 'The page you received: alert, context, architecture notes, change log, hints',
    map: 'Service topology colored by health over time (like a Datadog service map)',
    metrics: 'Time-series dashboards (like Grafana). Drag to zoom · p to pin · double-click to reset',
    heatmap: 'One row per instance. Find the one bad host (hot row) vs a fleet-wide event (hot column)',
    timeline: 'Everything on one time axis: events, log volume per service, every trace (like nsys)',
    traces: 'Individual requests (like Jaeger): where did the time go? Breakdown = profiler summary',
    logs: 'Search, filter and group log lines into patterns (like Kibana / Loki)',
    report: 'Write up root cause + evidence, then copy it to Claude for grading',
  };
  const INTRO = {
    brief: '<b>Start here.</b> Read the alert and the architecture notes, then check the change log: most incidents are caused by a change. Then press <b>Start investigating</b>.',
    map: '<b>Service map:</b> follow the request path. Scrub or play the timeline: which node turns red <i>first</i>? Click a node to see its metrics.',
    metrics: '<b>Metrics:</b> the on-call dashboard is preloaded, but the decisive metric is rarely on it. Browse the tree on the left. <b>Drag</b> to zoom, <kbd>p</kbd> to pin, <b>corr</b> for related metrics.',
    heatmap: '<b>Heatmap:</b> one row per instance. A single bright row = one bad host. A bright column = something fleet-wide at that moment.',
    timeline: '<b>Timeline:</b> like a profiler timeline. Line up changes, log bursts and slow requests. Click a trace dot to open it.',
    traces: '<b>Traces:</b> pick a slow request and read the waterfall. The <b>Breakdown</b> table below aggregates self-time and calls/trace: compare before vs during the incident.',
    logs: '<b>Logs:</b> search text or <code>/regex/</code>, and tick <b>group into patterns</b> to collapse noise. Hover a line and click <b>pin</b> to keep it as evidence.',
    report: '<b>Report:</b> mechanism, not symptoms. Cite numbers and timestamps, and say what you ruled out. Then <b>Copy as Markdown</b> and paste it to Claude.',
  };
  function help() {
    modal('How to use the Observatory', el('div', { class: 'brief-text' },
      el('h3', {}, 'Keyboard'), el('ul', {}, el('li', {}, el('kbd', {}, '1'), '–', el('kbd', {}, '8'), ' switch tabs · ', el('kbd', {}, 'p'), ' pin value under cursor · ', el('kbd', {}, 'z'), ' zoom out · ', el('kbd', {}, '?'), ' this help · ', el('kbd', {}, 'Esc'), ' close')),
      el('h3', {}, 'Tabs'), el('ul', {}, TABS.map(([id, l]) => el('li', {}, el('b', {}, l + ': '), TAB_HELP[id]))),
      el('h3', {}, 'Tips'), el('ul', {},
        el('li', {}, 'Drag across any chart to zoom every view to that window. Double-click to reset.'),
        el('li', {}, 'Type a number in a chart\'s threshold box to shade where it\'s exceeded and see when it first crossed.'),
        el('li', {}, '"corr" ranks metrics that moved with this one. "Top movers" diffs two windows. Correlation is not causation, and the earliest mover is usually closer to the cause than the biggest one.'),
        el('li', {}, 'Dashed vertical lines are events (deploys, config, alerts). Hover near one on a chart for details.'),
        el('li', {}, 'Round numbers are clues: a gauge stuck at 20 is a pool size, and latency capped at 3.00 s is a timeout.'))));
  }
  function toast(msg) { $.toast.textContent = msg; $.toast.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(() => ($.toast.style.display = 'none'), 1800); }

  function openScenario(id) {
    const s = OBS.scenarios[id];
    if (!s) { return landing(); }
    S.id = id; $.sel.value = id;
    try { S.c = OBS.compile(s); } catch (e) { $.main.innerHTML = ''; $.main.append(el('div', { class: 'view' }, el('div', { class: 'panel err' }, 'Scenario failed to compile: ' + e.message))); console.error(e); return; }
    if (S.c.errors.length) console.warn('Scenario warnings:', S.c.errors);
    S.st = Object.assign(freshState(), LS.get('obs:' + id, {}));
    S.range = [0, S.c.duration]; S.cursor = null; S.selTrace = null; $.cursor.innerHTML = '';
    $.tabs.style.display = ''; $.title.innerHTML = '';
    $.title.append(s.difficulty ? el('span', { class: 'pill ' + s.difficulty }, s.difficulty) : '', ' ', el('span', { class: 'muted' }, (s.tags || []).slice(0, 3).join(' · ')));
    document.title = s.title + ' — Observatory';
    showTab(S.st.tab || 'brief');
  }
  function landing() {
    S.c = null;
    $.main.innerHTML = '';
    const v = el('div', { class: 'view' });
    v.append(el('div', { class: 'panel' }, el('h2', {}, 'Pick a scenario'), el('p', { class: 'muted' }, 'Each scenario is a simulated production incident. You get the same tools an on-call engineer gets (dashboards, a service map, traces, logs) and your job is to find the root cause and write it up.')));
    const cards = el('div', { class: 'cards' });
    for (const id of Object.keys(OBS.scenarios).sort()) {
      const s = OBS.scenarios[id];
      const st = LS.get('obs:' + id, null);
      cards.append(OBS.scenarioCard(s, st, '#s=' + id));
    }
    v.append(cards);
    if (S.failed.length) v.append(el('div', { class: 'panel err' }, 'Failed to load: ' + S.failed.join(', ')));
    $.main.append(v);
    $.range.textContent = ''; $.title.innerHTML = ''; $.tabs.style.display = 'none'; $.sel.value = ''; document.title = 'Observatory';
  }

  // ------------------------------------------------------ range/cursor -----
  function setRange(a, b) {
    if (!S.c) return;
    a = Math.max(0, a); b = Math.min(S.c.duration, b);
    if (b - a < S.c.step * 4) { const m = (a + b) / 2; a = Math.max(0, m - S.c.step * 2); b = Math.min(S.c.duration, m + S.c.step * 2); }
    S.range = [a, b];
    updateRangeBox();
    refresh();
  }
  function zoomOut() { const [a, b] = S.range, w = b - a; setRange(a - w / 2, b + w / 2); }
  function updateRangeBox() {
    const [a, b] = S.range;
    $.range.innerHTML = '🕑 <b>' + fmt.clock(S.c.start, a) + '</b> → <b>' + fmt.clock(S.c.start, b) + '</b> UTC · ' + fmt.dur(b - a);
    $.range.classList.toggle('zoomed', b - a < S.c.duration - 1);
  }
  let curRaf = null;
  function setCursor(t) {
    S.cursor = t;
    if (curRaf) return;
    curRaf = requestAnimationFrame(() => {
      curRaf = null;
      for (const ch of S.charts) ch.drawCursor(S.cursor);
      $.cursor.innerHTML = S.cursor == null ? '' : 'cursor <b>' + fmt.clock(S.c.start, S.cursor) + '</b>';
      if (S.onCursor) S.onCursor(S.cursor);
    });
  }
  function refresh() {
    if (S.tab === 'metrics') { for (const ch of S.charts) ch.render(); }
    else showTab(S.tab);
  }

  function showTab(id) {
    if (!S.c) return landing();
    S.tab = id; save();
    for (const t of $.tabs.children) t.classList.toggle('active', t.dataset.tab === id);
    const rep = $.tabs.querySelector('[data-tab=report]');
    rep.innerHTML = 'Report' + (S.st.pins.length ? ' <span class="badge">' + S.st.pins.length + '</span>' : '');
    S.charts = []; S.onCursor = null;
    $.main.innerHTML = '';
    updateRangeBox();
    VIEWS[id]();
    const seen = LS.get('obs:seenIntro', {});
    const v = $.main.querySelector('.view');
    if (v && INTRO[id] && !seen[id]) {
      const strip = el('div', { class: 'tab-intro' }, el('span', { html: INTRO[id] }), el('span', { class: 'x', title: 'Got it, hide this', onclick: () => { seen[id] = 1; LS.set('obs:seenIntro', seen); strip.remove(); } }, '✕'));
      v.prepend(strip);
    }
  }

  const valAt = (key, t) => { const s = S.c.series[key]; if (!s) return null; const i = Math.max(0, Math.min(S.c.n - 1, Math.round(t / S.c.step))); return s[i]; };
  const idxRange = () => [Math.max(0, Math.floor(S.range[0] / S.c.step)), Math.min(S.c.n - 1, Math.ceil(S.range[1] / S.c.step))];
  const inRange = (t) => t >= S.range[0] && t <= S.range[1];

  // ---------------------------------------------------------------- pins ---
  function addPin(p) {
    S.st.pins.push(p); save();
    toast('📌 pinned to report (' + S.st.pins.length + ')');
    const rep = $.tabs.querySelector('[data-tab=report]');
    rep.innerHTML = 'Report <span class="badge">' + S.st.pins.length + '</span>';
  }
  function pinText(p) {
    const time = fmt.clock(S.c.start, p.t);
    if (p.log) return time + ' — log [' + p.log.level + '] ' + p.log.entity + ': ' + p.log.msg;
    if (p.trace) return time + ' — trace ' + p.trace;
    if (p.text) return time + ' — ' + p.text;
    return time + ' — ' + p.chart + ': ' + p.values.map((v) => v.label + '=' + v.v).join(', ');
  }

  // =============================================================== VIEWS ===
  const VIEWS = {};

  // -------------------------------------------------------------- brief ----
  VIEWS.brief = function () {
    const s = S.c.scenario, b = s.brief || {};
    const v = el('div', { class: 'view' });
    v.append(el('div', { class: 'panel alert-card' },
      el('div', { class: 'row' }, el('span', { class: 'sev' }, b.severity || 'SEV-2'), el('span', { class: 'firing', title: 'firing' }), el('b', { style: { fontSize: '16px' } }, b.alert || s.title)),
      el('div', { class: 'muted mono', style: { marginTop: '6px' } }, (b.firedAt != null ? 'fired ' + fmt.clock(S.c.start, b.firedAt) + ' UTC · ' : '') + 'window ' + fmt.clock(S.c.start, 0).slice(0, 5) + '–' + fmt.clock(S.c.start, S.c.duration).slice(0, 5) + ' UTC on ' + fmt.clock(S.c.start, 0, true).slice(0, 10)),
      el('h2', { style: { margin: '10px 0 0', fontSize: '15px', color: '#fff' } }, s.title)));
    const grid = el('div', { class: 'grid2' });
    grid.append(el('div', { class: 'panel brief-text' }, el('h3', {}, 'Situation'), el('div', { html: b.summary || '' })));
    grid.append(el('div', { class: 'panel brief-text' }, el('h3', {}, 'Your task'), el('div', { html: b.task || 'Find the root cause, explain the evidence, and propose mitigation + prevention.' }),
      b.questions ? el('div', {}, el('h3', { style: { marginTop: '10px' } }, 'Questions to answer in your report'), el('ol', {}, b.questions.map((q) => el('li', {}, q)))) : '',
      el('div', { class: 'cta-row' }, el('button', { class: 'primary', onclick: () => showTab('metrics') }, 'Start investigating →'), el('span', { class: 'muted' }, 'Suggested path: Change log → Metrics → Heatmap → Logs → Traces → Report'))));
    v.append(grid);
    if (s.architecture) v.append(el('div', { class: 'panel brief-text' }, el('h3', {}, 'Architecture notes (from the team wiki)'), el('div', { html: s.architecture })));
    const changes = S.c.events.filter((e) => ['deploy', 'config', 'scale', 'cron', 'traffic', 'failover'].includes(e.kind));
    if (changes.length) {
      const tb = el('table', { class: 'tbl' }, el('tr', {}, el('th', {}, 'time'), el('th', {}, 'kind'), el('th', {}, 'entity'), el('th', {}, 'description')));
      for (const e of changes) tb.append(el('tr', {}, el('td', {}, fmt.clock(S.c.start, e.t)), el('td', { style: { color: OBS.EVENT_COLORS[e.kind] } }, e.kind), el('td', {}, e.entity), el('td', { style: { fontFamily: 'var(--sans)' } }, e.msg)));
      v.append(el('div', { class: 'panel' }, el('h3', {}, 'Change log (deploys / config / scaling during the window)'), tb));
    }
    // hints
    const hints = s.hints || [];
    const hp = el('div', { class: 'panel' }, el('h3', {}, 'Hints (' + S.st.hints + '/' + hints.length + ' used — hints are noted in your report)'));
    for (let i = 0; i < S.st.hints && i < hints.length; i++) hp.append(el('div', { class: 'hint' }, el('b', {}, 'Hint ' + (i + 1) + ': '), el('span', { html: hints[i] })));
    if (S.st.hints < hints.length) hp.append(el('button', { style: { marginTop: '8px' }, onclick: () => { S.st.hints++; save(); showTab('brief'); } }, 'Reveal hint ' + (S.st.hints + 1)));
    v.append(hp);
    v.append(el('div', { class: 'panel brief-text' }, el('h3', {}, 'Tool tips (press ? any time)'), el('ul', {},
      el('li', {}, 'Drag across any chart to zoom every view to that window. Double-click (or press Reset) to zoom out.'),
      el('li', {}, 'Hover a chart and press p (or the 📌 button) to pin the values as evidence. Double-click a log line or use "pin" on a trace to pin it.'),
      el('li', {}, 'Type a number in a chart\'s threshold box to shade where it\'s exceeded and see when it first crossed.'),
      el('li', {}, '≈ on a chart ranks every other metric by correlation in the current window, which is useful for "what moved together?". Correlation is not causation.'),
      el('li', {}, 'Heatmap: one row per instance, for spotting the one bad host. Traces → Breakdown: where time is actually spent, like a profiler\'s kernel summary.'),
      el('li', {}, 'Vertical dashed lines on charts are events (deploys, config changes, alerts). Hover the triangle for details.'))));
    $.main.append(v);
  };

  // ---------------------------------------------------------------- map ----
  function healthColor(v, th, invert) {
    if (v == null || !th) return { fill: '#1b2638', stroke: '#3a4a63' };
    const [w, c] = th; const bad = invert ? v <= c : v >= c, warn = invert ? v <= w : v >= w;
    if (bad) return { fill: '#3a1520', stroke: '#f2617a' };
    if (warn) return { fill: '#3a2a10', stroke: '#f5a524' };
    return { fill: '#10291f', stroke: '#3fcf8e' };
  }
  const KIND_ICON = { lb: '⇄', service: '◆', db: '⛁', cache: '⚡', queue: '☰', external: '☁', client: '◎', storage: '▤', worker: '⚙' };
  VIEWS.map = function () {
    const topo = S.c.scenario.topology || { nodes: [], edges: [] };
    const v = el('div', { class: 'view' });
    const fired = (S.c.scenario.brief || {}).firedAt;
    let tSel = S.cursor != null ? S.cursor : fired != null && inRange(fired) ? fired : S.range[1];
    tSel = Math.round(tSel / S.c.step) * S.c.step;
    let follow = true;
    const timeLbl = el('span', { class: 'mono' });
    const slider = el('input', { type: 'range', class: 'scrubber', min: S.range[0], max: S.range[1], step: S.c.step, value: tSel });
    const side = el('div', {});
    let playing = null;
    const playBtn = el('button', { onclick: () => {
      if (playing) { clearInterval(playing); playing = null; playBtn.textContent = '▶ play'; return; }
      follow = false; playBtn.textContent = '❚❚ pause';
      if (tSel >= S.range[1]) tSel = S.range[0];
      playing = setInterval(() => { tSel += S.c.step * Math.max(1, Math.round((S.range[1] - S.range[0]) / S.c.step / 120)); if (tSel > S.range[1]) { tSel = S.range[1]; clearInterval(playing); playing = null; playBtn.textContent = '▶ play'; } slider.value = tSel; draw(); }, 80);
    } }, '▶ play');
    v.append(el('div', { class: 'toolbar' }, el('b', {}, 'Health at'), timeLbl, playBtn,
      el('span', { class: 'map-legend' }, el('span', {}, el('i', { style: { background: '#3fcf8e' } }), 'ok'), el('span', {}, el('i', { style: { background: '#f5a524' } }), 'warn'), el('span', {}, el('i', { style: { background: '#f2617a' } }), 'critical'), el('span', {}, el('i', { style: { background: '#3a4a63' } }), 'no health metric')),
      el('span', { class: 'muted' }, 'Hover a node for its thresholds. Click it for its metrics.')));
    const scrub = el('div', { class: 'scrub-wrap' });
    for (const e of S.c.events) if (inRange(e.t)) scrub.append(el('div', { class: 'scrub-tick', title: fmt.clock(S.c.start, e.t) + ' ' + e.kind + ': ' + e.msg, style: { left: ((e.t - S.range[0]) / (S.range[1] - S.range[0])) * 100 + '%', background: OBS.EVENT_COLORS[e.kind] || '#999' } }));
    scrub.append(slider);
    v.append(scrub);
    const layout = el('div', { class: 'map-layout' });
    const wrap = el('div', { class: 'map-wrap' });
    side.className = 'map-drawer';
    layout.append(wrap, side);
    v.append(layout);
    $.main.append(v);
    slider.addEventListener('input', () => { follow = false; tSel = +slider.value; draw(); });
    const ys = topo.nodes.map((n) => n.y);
    const H = Math.max(240, Math.min(470, (Math.max(...ys, 0) - Math.min(...ys, 100)) * 3.6 + 150));
    function draw() {
      timeLbl.textContent = fmt.clock(S.c.start, tSel);
      wrap.innerHTML = '';
      const W = Math.max(600, wrap.clientWidth || 900);
      const svgE = OBS.svg('svg', { width: W, height: H, class: 'map-svg' });
      const defs = OBS.svg('defs'); const mk = OBS.svg('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      mk.append(OBS.svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#4a5d7a' })); defs.append(mk); svgE.append(defs);
      const perRow = {}; for (const n of topo.nodes) perRow[Math.round(n.y / 8)] = (perRow[Math.round(n.y / 8)] || 0) + 1;
      const maxRow = Math.max(1, ...Object.values(perRow));
      const pos = {}; const NW = Math.max(118, Math.min(172, (W - 60) / maxRow - 34)), NH = 56;
      const minY = Math.min(...ys), spanY = Math.max(1, Math.max(...ys) - minY);
      for (const n of topo.nodes) pos[n.id] = { x: NW / 2 + 12 + (n.x / 100) * (W - NW - 24), y: spanY < 2 ? H / 2 : 40 + ((n.y - minY) / spanY) * (H - 80) };
      const labels = [];
      for (const e of topo.edges) {
        const a = pos[e.from], b = pos[e.to]; if (!a || !b) continue;
        // clip line to node box edges
        const dx = b.x - a.x, dy = b.y - a.y;
        const clip = (p, sgn) => { const sx = Math.abs(dx) < 1e-6 ? Infinity : (NW / 2) / Math.abs(dx), sy = Math.abs(dy) < 1e-6 ? Infinity : (NH / 2) / Math.abs(dy); const s = Math.min(sx, sy); return { x: p.x + sgn * dx * s, y: p.y + sgn * dy * s }; };
        const p1 = clip(a, 1), p2 = clip(b, -1);
        let col = '#3a4a63', wid = 1.5;
        let label = e.label || '';
        if (e.metric) { const val = valAt(e.metric, tSel); const m = S.c.meta[e.metric]; label = (e.label ? e.label + ' ' : '') + fmt.val(val, m.unit); if (e.thresholds) { const hc = healthColor(val, e.thresholds, e.invert); col = hc.stroke; wid = 2.2; } }
        svgE.append(OBS.svg('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'map-edge', stroke: col, 'stroke-width': wid, 'marker-end': 'url(#arr)', 'stroke-dasharray': e.async ? '5 4' : null }));
        if (label) { const cramped = Math.hypot(p2.x - p1.x, p2.y - p1.y) < label.length * 6.4 + 8; const tx = OBS.svg('text', { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - (cramped ? NH / 2 + 8 : 5), class: 'map-edge-label', 'text-anchor': 'middle' }); tx.textContent = label; labels.push(tx); }
      }
      for (const n of topo.nodes) {
        const p = pos[n.id]; const val = n.health ? valAt(n.health, tSel) : null;
        const hc = healthColor(val, n.thresholds, n.invert);
        const g = OBS.svg('g', { class: 'map-node', transform: `translate(${p.x - NW / 2},${p.y - NH / 2})` });
        g.append(OBS.svg('rect', { width: NW, height: NH, rx: 7, fill: hc.fill, stroke: hc.stroke }));
        const t1 = OBS.svg('text', { x: 11, y: 22, fill: '#e6edf7', 'font-size': 13.5, 'font-weight': 600 }); t1.textContent = (KIND_ICON[n.kind] || '◆') + ' ' + (n.label || n.id); g.append(t1);
        const inst = Object.values(S.c.meta).filter((m) => m.service === n.id && m.instance).map((m) => m.instance);
        const ninst = new Set(inst).size;
        const t2 = OBS.svg('text', { x: 11, y: 42, fill: '#9fb0c6', 'font-size': 11.5, 'font-family': 'var(--mono)' });
        t2.textContent = (n.health ? S.c.meta[n.health].name + ' ' + fmt.val(val, S.c.meta[n.health].unit) : n.kind || '') + (ninst ? '  ×' + ninst : '');
        g.append(t2);
        const ti = OBS.svg('title'); ti.textContent = (n.desc || n.id) + (n.health ? '\nhealth metric: ' + n.health + (n.thresholds ? ' (warn ' + n.thresholds[0] + ', crit ' + n.thresholds[1] + ')' : '') : ''); g.append(ti);
        g.addEventListener('click', () => nodeDetail(n));
        svgE.append(g);
      }
      for (const l of labels) svgE.append(l);
      wrap.append(svgE);
    }
    function nodeDetail(n) {
      side.innerHTML = ''; S.charts = []; layout.classList.add('open');
      const keys = Object.values(S.c.meta).filter((m) => m.service === n.id).map((m) => m.key);
      const byName = {};
      for (const k of keys) { const m = S.c.meta[k]; (byName[m.name] = byName[m.name] || []).push(k); }
      const p = el('div', { class: 'panel' }, el('div', { class: 'row' }, el('div', { class: 'section-title' }, (n.label || n.id)), el('div', { style: { flex: 1 } }),
        el('button', { class: 'btn-icon', title: 'Add these charts to your Metrics tab', onclick: () => { const ks = Object.values(S.c.meta).filter((m) => m.service === n.id); const byN = {}; for (const m of ks) (byN[m.name] = byN[m.name] || []).push(m.key); for (const [nm, kk] of Object.entries(byN).reverse()) S.st.custom.unshift({ title: n.id + ' · ' + nm, keys: kk }); save(); showTab('metrics'); } }, 'open in Metrics'),
        el('button', { class: 'btn-icon', onclick: () => { layout.classList.remove('open'); side.innerHTML = ''; S.charts = []; draw(); } }, '✕')), n.desc ? el('p', { class: 'muted' }, n.desc) : '');
      const g = el('div', {});
      p.append(g);
      if (!keys.length) p.append(el('div', { class: 'muted' }, 'No metrics are collected for this component.'));
      for (const [name, ks] of Object.entries(byName)) { const ch = new OBS.LineChart(g, ctx, { title: name, keys: ks, height: 105 }); ch.root.style.marginBottom = '8px'; S.charts.push(ch); }
      side.append(p);
      draw();
      for (const ch of S.charts) ch.render();
    }
    S.onCursor = (t) => { if (follow && t != null) { tSel = Math.round(t / S.c.step) * S.c.step; slider.value = tSel; draw(); } };
    requestAnimationFrame(draw);
  };

  // ------------------------------------------------------------ metrics ----
  function metricTree(onPick) {
    const box = el('div', { class: 'sidebar' });
    const search = el('input', { class: 'tree-search', placeholder: 'Filter metrics…' });
    box.append(search, el('div', { class: 'dim', style: { fontSize: '11px', margin: '-4px 2px 8px' } }, 'click = new chart · shift-click = overlay on newest'));
    const list = el('div', {}); box.append(list);
    const services = {};
    for (const m of Object.values(S.c.meta)) { (services[m.service] = services[m.service] || {}); (services[m.service][m.name] = services[m.service][m.name] || []).push(m.key); }
    const topoNodes = ((S.c.scenario.topology || {}).nodes || []);
    const order = Object.keys(services).sort((a, b) => { const ia = topoNodes.findIndex((n) => n.id === a), ib = topoNodes.findIndex((n) => n.id === b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });
    function draw() {
      const q = search.value.toLowerCase();
      list.innerHTML = '';
      for (const svc of order) {
        const names = Object.keys(services[svc]).filter((nm) => !q || (svc + ':' + nm).toLowerCase().includes(q) || services[svc][nm].some((k) => k.toLowerCase().includes(q)));
        if (!names.length) continue;
        const node = topoNodes.find((n) => n.id === svc);
        const sec = el('div', { class: 'tree-svc' }, el('div', { class: 'tree-head' }, el('span', {}, KIND_ICON[node && node.kind] || '◆'), svc));
        for (const nm of names) {
          const ks = services[svc][nm];
          const sub = el('div', { class: 'tree-sub', style: { display: 'none' } });
          const item = el('div', { class: 'tree-item', title: (S.c.meta[ks[0]].desc || '') + '\n' + ks.join('\n'), onclick: (ev) => onPick(ks, svc + ' · ' + nm + (ks.length > 1 ? ' (all ' + ks.length + ')' : ''), ev.shiftKey) },
            nm, el('span', { class: 'dim', style: { marginLeft: '4px' } }, S.c.meta[ks[0]].unit), ks.length > 1 ? el('span', { class: 'n', title: 'show individual instances', onclick: (ev) => { ev.stopPropagation(); sub.style.display = sub.style.display === 'none' ? 'block' : 'none'; } }, '×' + ks.length + ' ▸') : '');
          sec.append(item);
          if (ks.length > 1) { for (const k of ks) sub.append(el('div', { class: 'tree-item', onclick: (ev) => onPick([k], S.c.meta[k].entity + ' · ' + nm, ev.shiftKey) }, S.c.meta[k].entity)); sec.append(sub); }
        }
        list.append(sec);
      }
    }
    search.addEventListener('input', draw); draw();
    return box;
  }
  VIEWS.metrics = function () {
    const s = S.c.scenario;
    const dashes = s.dashboards || [];
    let flashNext = false;
    S.st.dash = S.st.dash != null ? S.st.dash : 0;
    const view = el('div', { class: 'view' });
    const tree = metricTree((keys, title, add) => {
      const newest = S.st.custom[0];
      if (add && newest) { newest.keys = Array.from(new Set(newest.keys.concat(keys))); newest.title = newest.title + ' + ' + title; }
      else S.st.custom.unshift({ title, keys });
      flashNext = true; save(); rebuild(); view.scrollTop = 0;
    });
    $.main.append(tree, view);
    const dsel = el('select', { onchange: () => { S.st.dash = +dsel.value; save(); rebuild(); } });
    dashes.forEach((d, i) => dsel.append(el('option', { value: i }, d.title)));
    dsel.append(el('option', { value: -1 }, '(none: only my charts)'));
    dsel.value = S.st.dash;
    const toolbar = el('div', { class: 'toolbar' }, el('label', {}, 'Dashboard', dsel),
      el('button', { title: 'Compare every metric in the current window with the window just before it (or first half vs second half)', onclick: topMovers }, 'Top movers'),
      el('button', { onclick: () => { if (confirm('Remove all your custom charts?')) { S.st.custom = []; save(); rebuild(); } } }, 'Clear my charts'),
      OBS.eventLegend(S.c.events.filter((e) => inRange(e.t))));
    view.append(toolbar);
    const grid = el('div', { class: 'grid2' });
    view.append(grid);
    function rebuild() {
      grid.innerHTML = '';
      // keep custom state from storage
      const charts = [];
      // custom chart configs live in S.st.custom (persisted); the chart mutates cc directly (threshold, logY)
      for (const cc of S.st.custom) {
        cc.onRemove = (ch) => { S.st.custom = S.st.custom.filter((x) => x !== cc); S.charts = S.charts.filter((x) => x !== ch); ch.root.remove(); save(); };
        cc.onCorrelate = correlate;
        const ch = new OBS.LineChart(grid, ctx, cc); ch.custom = true; charts.push(ch);
      }
      const d = dashes[S.st.dash];
      if (d) for (const cd of d.charts) {
        const keys = cd.series.flatMap((k) => OBS.expandKeys(S.c, k));
        charts.push(new OBS.LineChart(grid, ctx, { title: cd.title, keys: keys.length ? keys : cd.series, threshold: cd.threshold, onCorrelate: correlate }));
      }
      S.charts = charts;
      for (const ch of charts) ch.render();
      if (flashNext && charts[0]) { charts[0].root.classList.add('flash'); flashNext = false; }
      save();
    }
    rebuild();
  };
  function pearson(a, b, i0, i1) {
    let n = 0, sa = 0, sb = 0; for (let i = i0; i <= i1; i++) { sa += a[i]; sb += b[i]; n++; }
    const ma = sa / n, mb = sb / n; let num = 0, da = 0, db = 0;
    for (let i = i0; i <= i1; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }
  function modal(title, body) {
    const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } });
    bg.append(el('div', { class: 'modal' }, el('div', { class: 'row', style: { marginBottom: '8px' } }, el('div', { class: 'section-title', style: { margin: 0 } }, title), el('div', { class: 'grow', style: { flex: 1 } }), el('button', { class: 'btn-icon', title: 'Close (Esc)', onclick: () => bg.remove() }, '✕')), body));
    document.body.append(bg);
    return bg;
  }
  function addCustom(keys, title) { S.st.custom.unshift({ title, keys }); save(); if (S.tab === 'metrics') showTab('metrics'); else toast('Added to your charts on the Metrics tab'); }
  function correlate(ch) {
    const k0 = ch.keys[0]; const [i0, i1] = idxRange();
    const rows = Object.keys(S.c.series).filter((k) => !ch.keys.includes(k)).map((k) => ({ k, r: pearson(S.c.series[k0], S.c.series[k], i0, i1) })).filter((x) => isFinite(x.r)).sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 20);
    const tb = el('table', { class: 'tbl' }, el('tr', {}, el('th', {}, 'metric'), el('th', { class: 'num' }, 'r'), el('th', {}, '')));
    let bg;
    for (const r of rows) tb.append(el('tr', {}, el('td', {}, r.k), el('td', { class: 'num ' + (Math.abs(r.r) > 0.8 ? 'warnc' : '') }, r.r.toFixed(3)), el('td', {}, el('button', { class: 'btn-icon', onclick: () => { bg.remove(); addCustom([k0, r.k], S.c.meta[k0].entity + ' ' + S.c.meta[k0].name + ' vs ' + r.k); } }, 'chart together'))));
    bg = modal('Correlated with ' + k0 + ' (Pearson r, current window)', el('div', {}, el('p', { class: 'muted' }, 'Metrics driven by the same traffic correlate with everything. Use this to generate hypotheses, then verify them with mechanism (traces, logs, config).'), tb));
  }
  function topMovers() {
    let [a, b] = S.range; const w = b - a;
    let A = [a - w, a], B = [a, b], label = 'current window vs the ' + fmt.dur(w) + ' before it';
    if (a - w < 0) { A = [a, a + w / 2]; B = [a + w / 2, b]; label = 'first half vs second half of current window'; }
    const mean = (k, r) => { const s = S.c.series[k]; let i0 = Math.max(0, Math.floor(r[0] / S.c.step)), i1 = Math.min(S.c.n - 1, Math.floor(r[1] / S.c.step)); let x = 0, n = 0; for (let i = i0; i <= i1; i++) { x += s[i]; n++; } return n ? x / n : 0; };
    const rows = Object.keys(S.c.series).map((k) => { const ma = mean(k, A), mb = mean(k, B); const rel = (mb - ma) / (Math.abs(ma) + 1e-9); return { k, ma, mb, rel }; }).filter((r) => Math.abs(r.mb - r.ma) > 1e-9).sort((x, y) => Math.abs(y.rel) - Math.abs(x.rel)).slice(0, 30);
    const tb = el('table', { class: 'tbl' }, el('tr', {}, el('th', {}, 'metric'), el('th', { class: 'num' }, 'before'), el('th', { class: 'num' }, 'after'), el('th', { class: 'num' }, 'change'), el('th', {}, '')));
    let bg;
    for (const r of rows) { const u = S.c.meta[r.k].unit; tb.append(el('tr', {}, el('td', {}, r.k), el('td', { class: 'num' }, fmt.val(r.ma, u)), el('td', { class: 'num' }, fmt.val(r.mb, u)), el('td', { class: 'num ' + (r.rel > 0 ? 'warnc' : 'okc') }, (r.rel > 0 ? '+' : '') + (Math.abs(r.rel) > 100 ? '≫' : (r.rel * 100).toFixed(0) + '%')), el('td', {}, el('button', { class: 'btn-icon', onclick: () => { bg.remove(); addCustom([r.k], r.k); } }, 'chart')))); }
    bg = modal('Top movers: ' + label, el('div', {}, el('p', { class: 'muted' }, 'Mean of each metric in two windows, ranked by relative change. Symptoms move too: the root cause is usually the earliest mover, not the biggest.'), tb));
  }

  // ------------------------------------------------------------ heatmap ----
  VIEWS.heatmap = function () {
    const v = el('div', { class: 'view' }); $.main.append(v);
    const names = {}, instCount = {};
    for (const m of Object.values(S.c.meta)) { (names[m.name] = names[m.name] || []).push(m.key); if (m.instance) instCount[m.name] = (instCount[m.name] || 0) + 1; }
    const opts = Object.keys(names).sort((a, b) => (instCount[b] || 0) - (instCount[a] || 0) || names[b].length - names[a].length || a.localeCompare(b));
    S.st.heat = S.st.heat && names[S.st.heat] ? S.st.heat : opts[0];
    const aggCb = el('input', { type: 'checkbox', onchange: () => draw() });
    const sel = el('select', { onchange: () => { S.st.heat = sel.value; save(); draw(); } }, opts.map((o) => el('option', { value: o }, o + ' (' + names[o].length + ')')));
    sel.value = S.st.heat;
    const norm = el('input', { type: 'checkbox', onchange: () => draw() });
    const sortSel = el('select', { onchange: () => draw() }, el('option', { value: 'name' }, 'name'), el('option', { value: 'mean' }, 'mean (desc)'), el('option', { value: 'max' }, 'max (desc)'));
    v.append(el('div', { class: 'toolbar' }, el('label', {}, 'Metric', sel), el('label', {}, 'Sort rows', sortSel), el('label', {}, norm, 'normalize each row'), el('label', { title: 'Also show service-level (non-instance) series with this name' }, aggCb, 'include aggregates'),
      el('span', { class: 'muted' }, 'Rows are every entity that reports this metric. One hot row = one bad instance. Whole column = a fleet-wide event.')));
    const host = el('div', { class: 'panel' }); v.append(host);
    const stats = el('div', { class: 'panel' }); v.append(stats);
    function draw() {
      host.innerHTML = ''; stats.innerHTML = '';
      const [i0, i1] = idxRange();
      let keys = names[S.st.heat]; const unit = S.c.meta[keys[0]].unit;
      if (!aggCb.checked && keys.some((k) => S.c.meta[k].instance)) keys = keys.filter((k) => S.c.meta[k].instance);
      let rows = keys.map((k) => {
        const vals = S.c.series[k].slice(i0, i1 + 1); const sorted = vals.slice().sort((a, b) => a - b);
        return { key: k, label: S.c.meta[k].entity, values: S.c.series[k], mean: vals.reduce((a, b) => a + b, 0) / vals.length, max: sorted[sorted.length - 1], p95: sorted[Math.floor(sorted.length * 0.95)] };
      });
      const sb = sortSel.value;
      rows.sort(sb === 'mean' ? (a, b) => b.mean - a.mean : sb === 'max' ? (a, b) => b.max - a.max : (a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      const sc = OBS.Heatmap(host, ctx, rows, unit, { rowNormalize: norm.checked });

      const med = rows.map((r) => r.mean).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
      const tb = el('table', { class: 'tbl' }, el('tr', {}, el('th', {}, 'entity'), el('th', { class: 'num' }, 'mean'), el('th', { class: 'num' }, 'p95'), el('th', { class: 'num' }, 'max'), el('th', { class: 'num' }, 'mean vs median'), el('th', {}, '')));
      for (const r of rows.slice().sort((a, b) => b.mean - a.mean)) {
        const dev = med ? (r.mean - med) / Math.abs(med) : 0;
        tb.append(el('tr', {}, el('td', {}, r.label), el('td', { class: 'num' }, fmt.val(r.mean, unit)), el('td', { class: 'num' }, fmt.val(r.p95, unit)), el('td', { class: 'num' }, fmt.val(r.max, unit)),
          el('td', { class: 'num ' + (Math.abs(dev) > 0.5 ? 'warnc' : '') }, Math.abs(dev) < 0.005 ? '0%' : (dev > 0 ? '+' : '') + (dev * 100).toFixed(0) + '%'),
          el('td', {}, el('button', { class: 'btn-icon', title: 'pin this summary as evidence', html: OBS.PIN_SVG, onclick: () => addPin({ t: S.range[0], text: r.key + ' over window ' + fmt.clock(S.c.start, S.range[0]) + '–' + fmt.clock(S.c.start, S.range[1]) + ': mean ' + fmt.val(r.mean, unit) + ', p95 ' + fmt.val(r.p95, unit) + ', max ' + fmt.val(r.max, unit) + ' (' + (dev * 100).toFixed(0) + '% vs fleet median)' }) }))));
      }
      stats.className = 'panel narrow';
      stats.append(el('div', { class: 'section-title' }, 'Per-entity summary ', el('span', { class: 'muted' }, '(current window, sorted by mean)')), tb);
    }
    requestAnimationFrame(draw);
  };

  // ----------------------------------------------------------- timeline ----
  VIEWS.timeline = function () {
    const v = el('div', { class: 'view' }); $.main.append(v);
    const [t0, t1] = S.range;
    const W = Math.max(500, v.clientWidth - 40 - 170);
    const X = (t) => ((t - t0) / (t1 - t0)) * W;
    const B = 120, bw = (t1 - t0) / B;
    v.append(el('div', { class: 'toolbar' }, el('span', { class: 'muted' }, 'Everything on one time axis: change events, log volume per service (red = ERROR, amber = WARN, grey = INFO), and every sampled trace (y = latency, log scale). Click a trace dot to open it.')));
    const panel = el('div', { class: 'panel', style: { padding: '6px 8px' } }); v.append(panel);
    // events lane
    const evs = S.c.events.filter((e) => inRange(e.t));
    const rowEnd = []; const rowsOf = evs.map((e) => { const x = X(e.t); const txt = e.kind + ': ' + (e.entity ? e.entity + ' ' : '') + e.msg; const label = txt.length > 46 ? txt.slice(0, 45) + '…' : txt; const w = label.length * 6.2; let r = rowEnd.findIndex((end) => end < x - 8); if (r < 0) { r = rowEnd.length; rowEnd.push(0); } rowEnd[r] = x + w; return { r, label }; });
    const evSvg = OBS.svg('svg', { width: W, height: Math.max(26, 16 + 14 * rowEnd.length) });
    evs.forEach((e, i) => {
      const x = X(e.t), col = OBS.EVENT_COLORS[e.kind] || '#999';
      evSvg.append(OBS.svg('line', { x1: x, x2: x, y1: 0, y2: 400, stroke: col, 'stroke-dasharray': '2 3' }));
      const tx = OBS.svg('text', { x: x + 3, y: 12 + 14 * rowsOf[i].r, fill: col, 'font-size': 10.5, 'font-family': 'var(--mono)' }); tx.textContent = rowsOf[i].label; evSvg.append(tx);
      const ti = OBS.svg('title'); ti.textContent = fmt.clock(S.c.start, e.t) + ' ' + e.msg; tx.append(ti);
    });
    panel.append(el('div', { class: 'lane' }, el('div', { class: 'lane-label' }, 'events'), el('div', {}, evSvg)));
    // log lanes per service
    const bySvc = {};
    for (const l of S.c.logs) { if (!inRange(l.t)) continue; const svc = String(l.entity).split('/')[0]; const b = Math.min(B - 1, Math.floor((l.t - t0) / bw)); const o = (bySvc[svc] = bySvc[svc] || { e: new Array(B).fill(0), w: new Array(B).fill(0), i: new Array(B).fill(0) }); const lv = l.level; if (lv === 'ERROR' || lv === 'FATAL') o.e[b]++; else if (lv === 'WARN') o.w[b]++; else o.i[b]++; }
    for (const svc of Object.keys(bySvc).sort()) {
      const o = bySvc[svc]; const max = Math.max(1, ...o.e.map((x, i) => x + o.w[i] + o.i[i]));
      const sv = OBS.svg('svg', { width: W, height: 34 });
      for (let i = 0; i < B; i++) {
        let y = 34; const parts = [[o.i[i], '#475569'], [o.w[i], '#f5a524'], [o.e[i], '#f2617a']];
        for (const [cnt, col] of parts) { if (!cnt) continue; const h = (cnt / max) * 32; y -= h; sv.append(OBS.svg('rect', { x: (i * W) / B, y, width: W / B - 0.5, height: h, fill: col })); }
      }
      const tot = o.e.reduce((a, b) => a + b, 0);
      { const ti = OBS.svg('title'); ti.textContent = svc + ': ' + tot + ' errors in window (peak bucket ' + max + ' lines)'; sv.append(ti); }
      panel.append(el('div', { class: 'lane' }, el('div', { class: 'lane-label', title: svc + ': peak ' + max + ' lines per bucket' }, 'logs · ' + svc, el('div', { class: 'dim', style: { fontSize: '10px' } }, 'peak ' + max + '/bucket')), el('div', {}, sv)));
    }
    // trace scatter
    const tr = S.c.traces.filter((x) => inRange(x.t));
    if (tr.length) {
      const H = Math.max(170, Math.min(360, window.innerHeight - 420)); const lo = Math.max(0.1, Math.min(...tr.map((x) => x.dur))), hi = Math.max(...tr.map((x) => x.dur));
      const L0 = Math.log10(lo) - 0.1, L1 = Math.log10(hi) + 0.1; const Y = (d) => H - 4 - ((Math.log10(d) - L0) / (L1 - L0)) * (H - 10);
      const sv = OBS.svg('svg', { width: W, height: H });
      for (let p = Math.ceil(L0); p <= L1; p++) { const y = Y(Math.pow(10, p)); sv.append(OBS.svg('line', { x1: 0, x2: W, y1: y, y2: y, class: 'grid', stroke: '#1f2a3b' })); const tx = OBS.svg('text', { x: 2, y: y - 2, fill: '#5d6b80', 'font-size': 10 }); tx.textContent = fmt.ms(Math.pow(10, p)); sv.append(tx); }
      const names = Array.from(new Set(tr.map((x) => x.name)));
      for (const x of tr) {
        const c = OBS.svg('circle', { cx: X(x.t), cy: Y(x.dur), r: 2.6, fill: x.error ? '#f2617a' : OBS.PALETTE[names.indexOf(x.name) % OBS.PALETTE.length], opacity: 0.75, style: 'cursor:pointer' });
        c.append(OBS.svg('title')); c.lastChild.textContent = x.name + ' ' + fmt.ms(x.dur) + (x.error ? ' ERROR' : '') + ' @ ' + fmt.clock(S.c.start, x.t);
        c.addEventListener('click', () => { S.selTrace = x.id; showTab('traces'); });
        sv.append(c);
      }
      panel.append(el('div', { class: 'lane' }, el('div', { class: 'lane-label' }, 'traces (' + tr.length + ')', el('div', { style: { fontSize: '10px' } }, names.map((n, i) => el('div', { style: { color: OBS.PALETTE[i % OBS.PALETTE.length] } }, n)))), el('div', {}, sv)));
    }
    // time axis
    const ax = OBS.svg('svg', { width: W, height: 18 });
    for (let i = 0; i <= 6; i++) { const t = t0 + ((t1 - t0) * i) / 6; const tx = OBS.svg('text', { x: Math.min(W - 50, X(t)), y: 13, fill: '#5d6b80', 'font-size': 10, 'font-family': 'var(--mono)' }); tx.textContent = fmt.clock(S.c.start, t); ax.append(tx); }
    panel.append(el('div', { class: 'lane' }, el('div', { class: 'lane-label' }, ''), el('div', {}, ax)));
    // cursor line + brushing across all lanes
    panel.style.position = 'relative';
    const laneLeft = () => panel.querySelector('.lane > div:last-child').getBoundingClientRect().left - panel.getBoundingClientRect().left;
    const cur = el('div', { style: { position: 'absolute', top: 0, bottom: 0, width: '1px', background: 'rgba(201,212,227,.5)', pointerEvents: 'none', display: 'none' } });
    const br = el('div', { style: { position: 'absolute', top: 0, bottom: 0, background: 'rgba(78,156,255,.18)', pointerEvents: 'none', display: 'none' } });
    panel.append(cur, br);
    S.onCursor = (t) => { if (t == null || t < t0 || t > t1) { cur.style.display = 'none'; return; } cur.style.display = 'block'; cur.style.left = laneLeft() + X(t) + 'px'; };
    let down = null;
    panel.addEventListener('mousemove', (e) => { const L = laneLeft(); const x = e.clientX - panel.getBoundingClientRect().left - L; if (x >= 0 && x <= W) setCursor(t0 + (x / W) * (t1 - t0)); if (down != null) { br.style.display = 'block'; br.style.left = L + Math.min(down, x) + 'px'; br.style.width = Math.abs(x - down) + 'px'; } });
    panel.addEventListener('mouseleave', () => setCursor(null));
    panel.addEventListener('mousedown', (e) => { if (e.target.tagName === 'circle') return; down = e.clientX - panel.getBoundingClientRect().left - laneLeft(); e.preventDefault(); });
    panel.addEventListener('mouseup', (e) => { if (down == null) return; const x = e.clientX - panel.getBoundingClientRect().left - laneLeft(); const a = Math.max(0, Math.min(down, x)), b = Math.min(W, Math.max(down, x)); down = null; br.style.display = 'none'; if (b - a > 8) setRange(t0 + (a / W) * (t1 - t0), t0 + (b / W) * (t1 - t0)); });
  };

  // ------------------------------------------------------------- traces ----
  function pct(sorted, p) { if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; }
  function selfTime(sp) {
    if (!sp.children.length) return sp.dur;
    const iv = sp.children.map((c) => [c.start, c.start + c.dur]).sort((a, b) => a[0] - b[0]);
    let cov = 0, cs = iv[0][0], ce = iv[0][1];
    for (let i = 1; i < iv.length; i++) { if (iv[i][0] <= ce) ce = Math.max(ce, iv[i][1]); else { cov += ce - cs; cs = iv[i][0]; ce = iv[i][1]; } }
    cov += ce - cs;
    return Math.max(0, sp.dur - cov);
  }
  VIEWS.traces = function () {
    const v = el('div', { class: 'view' }); $.main.append(v);
    const all = S.c.traces.filter((x) => inRange(x.t));
    if (!S.c.traces.length) { v.append(el('div', { class: 'panel muted' }, 'This scenario has no tracing instrumentation. (Not every system does!)')); return; }
    const names = Array.from(new Set(S.c.traces.map((x) => x.name))).sort();
    const services = Array.from(new Set(S.c.traces.flatMap((x) => x.services))).sort();
    const f = S.st.tf = S.st.tf || { name: '', err: false, min: '', svc: '', sort: 'dur' };
    const nameSel = el('select', {}, el('option', { value: '' }, 'all endpoints'), names.map((n) => el('option', { value: n }, n))); nameSel.value = f.name;
    const svcSel = el('select', {}, el('option', { value: '' }, 'any service'), services.map((n) => el('option', { value: n }, n))); svcSel.value = f.svc;
    const errCb = el('input', { type: 'checkbox' }); errCb.checked = f.err;
    const minIn = el('input', { type: 'number', placeholder: 'min ms', style: { width: '80px' }, value: f.min });
    const sortSel = el('select', {}, el('option', { value: 'dur' }, 'slowest first'), el('option', { value: 't' }, 'by time')); sortSel.value = f.sort;
    for (const x of [nameSel, svcSel, errCb, minIn, sortSel]) x.addEventListener('change', () => { Object.assign(f, { name: nameSel.value, svc: svcSel.value, err: errCb.checked, min: minIn.value, sort: sortSel.value }); save(); showTab('traces'); });
    v.append(el('div', { class: 'toolbar' }, nameSel, svcSel, el('label', {}, errCb, 'errors only'), el('label', {}, 'slower than', minIn), sortSel));
    let list = all.filter((x) => (!f.name || x.name === f.name) && (!f.svc || x.services.includes(f.svc)) && (!f.err || x.error) && (!f.min || x.dur >= +f.min));
    const durs = list.map((x) => x.dur).sort((a, b) => a - b);
    v.append(el('div', { class: 'stat-row' },
      [['traces', list.length], ['p50', fmt.ms(pct(durs, 0.5))], ['p95', fmt.ms(pct(durs, 0.95))], ['p99', fmt.ms(pct(durs, 0.99))], ['max', fmt.ms(durs[durs.length - 1] || 0)], ['errors', list.length ? ((100 * list.filter((x) => x.error).length) / list.length).toFixed(1) + '%' : '–']]
        .map(([k, val]) => el('div', { class: 'stat sm' }, el('div', { class: 'k' }, k), el('div', { class: 'v ' + (k === 'errors' && parseFloat(val) > 1 ? 'err' : k === 'p99' && pct(durs, 0.99) > 2 * pct(durs, 0.5) ? 'warnc' : '') }, val)))));
    list = list.slice().sort(f.sort === 'dur' ? (a, b) => b.dur - a.dur : (a, b) => a.t - b.t);
    const split = el('div', { class: 'split' }); v.append(split);
    const left = el('div', { class: 'panel scroll-box' });
    let right;
    const tb = el('table', { class: 'tbl' }, el('tr', {}, el('th', {}, 'time'), el('th', {}, 'endpoint'), el('th', { class: 'num' }, 'duration'), el('th', { class: 'num' }, 'spans'), el('th', {}, '')));
    const maxd = Math.max(1, ...list.map((x) => x.dur));
    for (const x of list.slice(0, 400)) {
      const row = el('tr', { class: 'clickable' + (x.id === S.selTrace ? ' sel' : ''), onclick: () => { S.selTrace = x.id; tb.querySelectorAll('tr.sel').forEach((r) => r.classList.remove('sel')); row.classList.add('sel'); right.innerHTML = ''; waterfall(right, x); } },
        el('td', {}, fmt.clock(S.c.start, x.t)), el('td', {}, x.name), el('td', { class: 'num bar-cell' }, el('div', { class: 'bar', style: { width: (100 * x.dur) / maxd + '%' } }), el('span', {}, fmt.ms(x.dur))), el('td', { class: 'num' }, x.spans.length), el('td', { class: x.error ? 'err' : '' }, x.error ? 'ERR' : ''));
      tb.append(row);
    }
    left.append(tb);
    if (list.length > 400) left.append(el('div', { class: 'muted' }, 'showing 400 of ' + list.length));
    split.append(left);
    right = el('div', { class: 'panel' }); split.append(right);
    if (!list.length) right.append(el('div', { class: 'muted' }, 'No traces match the filters in this window.'));
    const sel = S.c.traces.find((x) => x.id === S.selTrace) || list[0];
    if (sel) waterfall(right, sel);
    // aggregate breakdown
    const agg = {};
    let totalTime = 0;
    for (const x of list) { totalTime += x.dur; for (const sp of x.spans) { const k = sp.service + ' · ' + sp.op; const a = (agg[k] = agg[k] || { k, svc: sp.service, n: 0, self: 0, durs: [], err: 0 }); a.n++; a.self += selfTime(sp); a.durs.push(sp.dur); if (sp.error) a.err++; } }
    const rows = Object.values(agg).sort((a, b) => b.self - a.self);
    const at = el('table', { class: 'tbl' }, el('tr', {}, el('th', {}, 'service · operation'), el('th', { class: 'num' }, 'calls'), el('th', { class: 'num' }, 'calls/trace'), el('th', { class: 'num' }, 'avg dur'), el('th', { class: 'num' }, 'p99 dur'), el('th', { class: 'num' }, 'self time (total)'), el('th', { class: 'num' }, '% of trace time'), el('th', { class: 'num' }, 'err')));
    for (const a of rows) {
      a.durs.sort((p, q) => p - q);
      const share = totalTime ? a.self / totalTime : 0;
      at.append(el('tr', {}, el('td', {}, a.k), el('td', { class: 'num' }, a.n), el('td', { class: 'num' }, (a.n / Math.max(1, list.length)).toFixed(1)), el('td', { class: 'num' }, fmt.ms(a.durs.reduce((p, q) => p + q, 0) / a.n)), el('td', { class: 'num' }, fmt.ms(pct(a.durs, 0.99))), el('td', { class: 'num' }, fmt.ms(a.self)),
        el('td', { class: 'num bar-cell' }, el('div', { class: 'bar', style: { width: 100 * share + '%' } }), el('span', {}, (100 * share).toFixed(1) + '%')), el('td', { class: 'num ' + (a.err ? 'err' : '') }, a.err || '')));
    }
    v.append(el('div', { class: 'panel', style: { marginTop: '12px' } }, el('div', { class: 'section-title' }, 'Breakdown: where the time goes ', el('span', { class: 'muted' }, '(filtered traces, current window)')),
      el('p', { class: 'muted' }, 'Self time = time in a span not covered by its children: the profiler "exclusive time" view. Compare this table before vs after the incident by zooming the window.'), at));
  };
  function waterfall(host, tr) {
    const svcs = Array.from(new Set(tr.spans.map((s) => s.service)));
    const color = (s) => OBS.PALETTE[svcs.indexOf(s) % OBS.PALETTE.length];
    host.append(el('div', { class: 'row' }, el('span', { class: 'trace-title' }, tr.name), el('span', { class: 'mono muted' }, fmt.ms(tr.dur) + ' · ' + fmt.clock(S.c.start, tr.t) + ' · ' + tr.id.slice(0, 12)), tr.error ? el('span', { class: 'pill', style: { color: 'var(--bad)', borderColor: '#7a3040' } }, 'ERROR') : '', el('div', { style: { flex: 1 } }),
      el('button', { class: 'btn-icon', onclick: () => addPin({ t: tr.t, trace: tr.name + ' ' + tr.id.slice(0, 12) + ' took ' + fmt.ms(tr.dur) + ': ' + tr.spans.slice().sort((a, b) => selfTime(b) - selfTime(a)).slice(0, 3).map((s) => s.service + '·' + s.op + ' self ' + fmt.ms(selfTime(s))).join(', ') }), html: OBS.PIN_SVG + ' pin trace' })));
    host.append(el('div', { class: 'row', style: { margin: '6px 0' } }, svcs.map((s) => el('span', { class: 'lg' }, el('i', { style: { background: color(s), height: '8px' } }), s))));
    const wf = el('div', { class: 'wf' });
    wf.append(el('div', { class: 'wf-ruler' }, el('div', {}, 'span'), el('div', {}, [0, 0.25, 0.5, 0.75, 1].map((f) => el('span', { style: { left: f * 100 + '%' } }, fmt.ms(tr.dur * f))))));
    const detail = el('div', { class: 'hint', style: { display: 'none' } });
    for (const sp of tr.spans) {
      const left = (sp.start / tr.dur) * 100, width = (sp.dur / tr.dur) * 100;
      const rowEl = el('div', { class: 'wf-row', onclick: () => { wf.querySelectorAll('.wf-row.sel').forEach((r) => r.classList.remove('sel')); rowEl.classList.add('sel'); detail.style.display = 'block'; detail.innerHTML = ''; detail.append(el('b', {}, sp.service + ' · ' + sp.op), el('div', { class: 'mono' }, 'start +' + fmt.ms(sp.start) + ' · duration ' + fmt.ms(sp.dur) + ' · self ' + fmt.ms(selfTime(sp)) + (sp.error ? ' · ERROR' : '')), Object.keys(sp.tags).length ? el('div', { class: 'mono muted' }, Object.entries(sp.tags).map(([k, v]) => k + '=' + v).join('  ')) : '', sp.note ? el('div', {}, sp.note) : ''); } },
        el('div', { class: 'wf-name', style: { paddingLeft: sp.depth * 14 + 'px' }, title: sp.service + ' · ' + sp.op }, el('span', { style: { color: color(sp.service) } }, '■ '), sp.op, el('span', { class: 'dim' }, ' ' + sp.service), sp.error ? el('span', { class: 'err' }, ' ✕') : ''),
        el('div', { class: 'wf-track' }, el('div', { class: 'wf-bar' + (sp.error ? ' error' : ''), style: { left: left + '%', width: width + '%', background: color(sp.service) } }), (left + width < 80 ? el('div', { class: 'wf-dur', style: { left: left + width + 0.8 + '%' } }, fmt.ms(sp.dur)) : width > 12 ? el('div', { class: 'wf-dur inside', style: { left: left + width + '%' } }, fmt.ms(sp.dur)) : el('div', { class: 'wf-dur before', style: { left: left + '%' } }, fmt.ms(sp.dur)))));
      wf.append(rowEl);
    }
    host.append(wf, detail);
    host.append(el('div', { class: 'dim', style: { marginTop: '6px', fontSize: '11px' } }, 'Click a span for its tags. Gaps between bars are network hops / queueing that no service owns.'));
  }

  // --------------------------------------------------------------- logs ----
  function template(msg) { return String(msg).replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<id>').replace(/\d+(\.\d+)?/g, '<n>').replace(/(["'])(?:(?!\1).)*\1/g, '"…"').replace(/(<n>)(?:[^\w<]*<n>)+/g, '<n>'); }
  function tplNode(t) { const sp = el('span'); String(t).split(/(<n>|<id>|"…")/).forEach((part) => sp.append(/^(<n>|<id>|"…")$/.test(part) ? el('span', { class: 'tpl-tok' }, part) : part)); return sp; }
  VIEWS.logs = function () {
    const v = el('div', { class: 'view' }); $.main.append(v);
    const f = S.st.lf = S.st.lf || { q: '', lv: { ERROR: true, WARN: true, INFO: true, DEBUG: false }, ent: '', patterns: false };
    const q = el('input', { placeholder: 'search: text or /regex/i', style: { width: '280px' }, value: f.q });
    const lvBox = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG'].map((lv) => { if (f.lv[lv] == null) f.lv[lv] = lv !== 'DEBUG'; const cb = el('input', { type: 'checkbox' }); cb.checked = f.lv[lv]; cb.addEventListener('change', () => { f.lv[lv] = cb.checked; save(); draw(); }); return el('label', {}, cb, lv); });
    const ents = Array.from(new Set(S.c.logs.map((l) => String(l.entity)))).sort();
    const svcs = Array.from(new Set(ents.map((e) => e.split('/')[0])));
    const entSel = el('select', {}, el('option', { value: '' }, 'all sources'), svcs.map((s) => el('option', { value: s }, s + ' (all)')), ents.filter((e) => e.includes('/')).map((e) => el('option', { value: '=' + e }, e)));
    entSel.value = f.ent;
    const pat = el('input', { type: 'checkbox' }); pat.checked = f.patterns;
    v.append(el('div', { class: 'toolbar' }, q, entSel, lvBox, el('label', { title: 'Group lines that differ only by numbers/ids' }, pat, 'group into patterns')));
    const hist = el('div', {}); v.append(hist);
    const out = el('div', { class: 'panel logs' }); v.append(out);
    let tmr; q.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => { f.q = q.value; save(); draw(); }, 200); });
    entSel.addEventListener('change', () => { f.ent = entSel.value; save(); draw(); });
    pat.addEventListener('change', () => { f.patterns = pat.checked; save(); draw(); });
    function matcher() {
      if (!f.q) return null;
      const m = f.q.match(/^\/(.*)\/([a-z]*)$/);
      try { return m ? new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') : new RegExp(f.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); } catch (e) { return null; }
    }
    function draw() {
      const re = matcher();
      const rows = S.c.logs.filter((l) => inRange(l.t) && f.lv[l.level] !== false && (!f.ent || (f.ent[0] === '=' ? String(l.entity) === f.ent.slice(1) : String(l.entity).split('/')[0] === f.ent)) && (!re || (re.lastIndex = 0, re.test(l.msg) || (re.lastIndex = 0, re.test(String(l.entity))))));
      // histogram
      hist.innerHTML = '';
      const [t0, t1] = S.range; const B = 100; const W = Math.max(400, v.clientWidth - 40);
      const bins = Array.from({ length: B }, () => ({ e: 0, o: 0 }));
      for (const l of rows) { const b = Math.min(B - 1, Math.floor(((l.t - t0) / (t1 - t0)) * B)); if (l.level === 'ERROR' || l.level === 'FATAL') bins[b].e++; else bins[b].o++; }
      const mx = Math.max(1, ...bins.map((b) => b.e + b.o));
      const sv = OBS.svg('svg', { width: W, height: 46 });
      bins.forEach((b, i) => { const ho = (b.o / mx) * 40, he = (b.e / mx) * 40; sv.append(OBS.svg('rect', { x: (i * W) / B, y: 42 - ho - he, width: W / B - 1, height: ho, fill: '#475569' })); sv.append(OBS.svg('rect', { x: (i * W) / B, y: 42 - he, width: W / B - 1, height: he, fill: '#f2617a' })); });
      for (let k = 0; k <= 4; k++) { const tx = OBS.svg('text', { x: Math.min(W - 2, Math.max(2, (k / 4) * W)), y: 44, fill: '#5d6b80', 'font-size': 9.5, 'font-family': 'var(--mono)', 'text-anchor': k === 0 ? 'start' : k === 4 ? 'end' : 'middle' }); tx.textContent = fmt.clock(S.c.start, t0 + ((t1 - t0) * k) / 4).slice(0, 5); sv.append(tx); }
      sv.setAttribute('height', 48); sv.style.cursor = 'crosshair';
      let hd = null; sv.addEventListener('mousedown', (e) => { hd = e.clientX - sv.getBoundingClientRect().left; e.preventDefault(); });
      sv.addEventListener('mouseup', (e) => { if (hd == null) return; const x = e.clientX - sv.getBoundingClientRect().left; const a = Math.min(hd, x), b = Math.max(hd, x); hd = null; if (b - a > 6) setRange(t0 + (a / W) * (t1 - t0), t0 + (b / W) * (t1 - t0)); });
      hist.append(el('div', { class: 'panel', style: { padding: '6px 8px' } }, el('div', { class: 'muted mono', style: { fontSize: '11px' } }, rows.length + ' matching lines · ' + fmt.clock(S.c.start, t0) + ' → ' + fmt.clock(S.c.start, t1) + ' · drag to zoom'), sv));
      out.innerHTML = '';
      const hl = (s) => { if (!re) return document.createTextNode(s); const span = el('span'); let last = 0; re.lastIndex = 0; let m; s = String(s); while ((m = re.exec(s)) && m[0].length) { span.append(s.slice(last, m.index), el('mark', {}, m[0])); last = m.index + m[0].length; } span.append(s.slice(last)); return span; };
      if (f.patterns) {
        const g = {};
        for (const l of rows) { const k = l.level + '|' + String(l.entity).split('/')[0] + '|' + template(l.msg); const o = (g[k] = g[k] || { k, n: 0, first: l.t, last: l.t, l, ents: new Set() }); o.n++; o.last = l.t; o.ents.add(String(l.entity)); }
        const tb = el('table', { class: 'tbl' }, el('tr', {}, el('th', { class: 'num' }, 'count'), el('th', {}, 'level'), el('th', {}, 'source'), el('th', {}, 'first'), el('th', {}, 'last'), el('th', {}, 'pattern (example)')));
        for (const o of Object.values(g).sort((a, b) => b.n - a.n).slice(0, 300)) tb.append(el('tr', {}, el('td', { class: 'num' }, o.n), el('td', { class: 'lvl-' + o.l.level + ' ' + (o.l.level === 'ERROR' ? 'err' : o.l.level === 'WARN' ? 'warnc' : '') }, o.l.level), el('td', {}, String(o.l.entity).split('/')[0] + (o.ents.size > 1 ? ' (' + o.ents.size + ' sources)' : '')), el('td', {}, fmt.clock(S.c.start, o.first)), el('td', {}, fmt.clock(S.c.start, o.last)), el('td', { style: { whiteSpace: 'pre-wrap' }, title: 'example: ' + o.l.msg }, re ? hl(o.l.msg) : tplNode(template(o.l.msg)))));
        out.append(tb);
        return;
      }
      let shown = 0; const PAGE = 300;
      const more = el('button', { style: { margin: '8px' } });
      const page = () => {
        const frag = document.createDocumentFragment();
        for (const l of rows.slice(shown, shown + PAGE)) {
          const pin = () => addPin({ t: l.t, log: { level: l.level, entity: l.entity, msg: l.msg } });
          frag.append(el('div', { class: 'logline', ondblclick: pin, onmouseenter: () => setCursor(l.t) },
            el('span', { class: 'dim' }, fmt.clock(S.c.start, l.t)), el('span', { class: 'lvl-' + l.level }, l.level), el('span', { class: 'ent', title: l.entity }, l.entity), el('span', { class: 'msg' }, hl(l.msg)), el('span', { class: 'pinbtn', title: 'pin as evidence', onclick: pin, html: OBS.PIN_SVG })));
        }
        shown += PAGE; more.remove(); out.append(frag);
        if (rows.length > shown) { more.textContent = 'Show more (' + (rows.length - shown) + ' remaining)'; out.append(more); }
      };
      more.onclick = page;
      page();
      if (!rows.length) out.append(el('div', { class: 'muted' }, 'No log lines match.'));
    }
    draw();
  };

  // ------------------------------------------------------------- report ----
  const FIELDS = [
    ['root', 'Root cause', 'What actually broke, and why? Be specific about the mechanism, not just "the DB was slow".'],
    ['evidence', 'Evidence & reasoning', 'Which signals prove it? How did you get from symptom to cause? (Pins are included automatically.)'],
    ['timeline', 'Timeline', 'Trigger → first symptom → alert → peak → recovery, with timestamps.'],
    ['impact', 'Impact', 'Who / what was affected and how badly (error rates, latency, duration).'],
    ['ruled', 'Red herrings ruled out', 'What looked suspicious but wasn\'t the cause, and how you ruled it out.'],
    ['mitigate', 'Immediate mitigation', 'What would you do right now, while paged, to stop the bleeding?'],
    ['prevent', 'Long-term fixes & prevention', 'Design changes, alerts, capacity, guardrails. What threshold or alert would have caught this earlier?'],
    ['conf', 'Confidence & open questions', 'How sure are you? What data would you want that the tools didn\'t show?'],
  ];
  VIEWS.report = function () {
    const v = el('div', { class: 'view' }); $.main.append(v);
    const s = S.c.scenario;
    v.append(el('div', { class: 'panel' }, el('h3', {}, 'Incident report'), el('p', { class: 'muted' }, 'Fill this in, then press "Copy as Markdown" and paste it to Claude in the terminal, or "Download" and save it into the reports/ folder. Claude grades it against the hidden answer key and logs your progress.')));
    const pins = el('div', { class: 'panel' }, el('h3', {}, 'Pinned evidence (' + S.st.pins.length + ')'));
    if (!S.st.pins.length) pins.append(el('div', { class: 'muted' }, 'Nothing pinned yet. Hover a chart and press p, double-click a log line, or pin a trace.'));
    S.st.pins.forEach((p, i) => {
      const note = el('input', { placeholder: 'annotation (why this matters)', value: p.note || '', style: { flex: 1, minWidth: '200px' } });
      note.addEventListener('input', () => { p.note = note.value; save(); });
      pins.append(el('div', { class: 'pin' }, el('span', { class: 'mono', style: { flex: 2 } }, pinText(p)), note, el('button', { class: 'btn-icon x', title: 'remove pin', onclick: () => { S.st.pins.splice(i, 1); save(); showTab('report'); } }, '✕')));
    });
    v.append(pins);
    const form = el('div', { class: 'panel' });
    const countEl = el('span', { class: 'muted' });
    const updCount = () => { countEl.textContent = FIELDS.filter(([k]) => (S.st.notes[k] || '').trim()).length + '/' + FIELDS.length + ' sections filled · saved automatically ✓'; };
    updCount();
    for (const [k, label, ph] of FIELDS) {
      const ta = el('textarea', { rows: k === 'root' || k === 'evidence' ? 5 : 3, placeholder: ph });
      ta.value = S.st.notes[k] || '';
      ta.addEventListener('input', () => { S.st.notes[k] = ta.value; save(); });
      const dot = el('span', { class: 'dot' + ((S.st.notes[k] || '').trim() ? ' done' : '') });
      ta.addEventListener('input', () => { dot.classList.toggle('done', !!ta.value.trim()); updCount(); });
      form.append(el('div', { class: 'field' }, el('label', {}, dot, label), ta));
    }
    v.append(form);
    const md = () => {
      const mins = Math.round((Date.now() - (S.st.opened || Date.now())) / 60000);
      let out = '# Incident report: ' + s.id + ' (' + s.title + ')\n\n';
      out += '_hints used: ' + S.st.hints + '/' + (s.hints || []).length + ' · time since first opened: ~' + mins + ' min_\n\n';
      for (const [k, label] of FIELDS) out += '## ' + label + '\n' + ((S.st.notes[k] || '').trim() || '_(blank)_') + '\n\n';
      if (S.st.pins.length) { out += '## Pinned evidence\n'; for (const p of S.st.pins) out += '- ' + pinText(p) + (p.note ? '  \n  ↳ ' + p.note : '') + '\n'; }
      return out;
    };
    const copy = () => {
      const text = md();
      const fallback = () => { const ta = el('textarea', { style: { position: 'fixed', opacity: 0 } }); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand('copy'); toast('Copied. Paste it to Claude.'); } catch (e) { modal('Copy this', el('pre', {}, text)); } ta.remove(); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => toast('Copied. Paste it to Claude.'), fallback); else fallback();
    };
    const download = () => { const a = el('a', { href: URL.createObjectURL(new Blob([md()], { type: 'text/markdown' })), download: s.id + '-report.md' }); document.body.append(a); a.click(); a.remove(); };
    v.append(el('div', { class: 'report-bar' }, el('button', { class: 'primary', onclick: copy }, 'Copy as Markdown'), el('button', { onclick: download }, 'Download .md'), el('button', { onclick: () => modal('Preview', el('pre', { style: { whiteSpace: 'pre-wrap' } }, md())) }, 'Preview'), countEl,
      el('div', { style: { flex: 1 } }), el('button', { class: 'danger', onclick: () => { if (confirm('Reset ALL progress for this scenario (notes, pins, hints, charts)?')) { LS.set('obs:' + S.id, freshState()); openScenario(S.id); } } }, 'Reset scenario')));
  };

  // -------------------------------------------------------------- boot -----
  document.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === 'p' && OBS.activeChart && OBS.activeChart.hovering) OBS.activeChart.pinCursor();
    if (e.key === 'z' && S.c) zoomOut();
    if (e.key === 'Escape') document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
    if (e.key === '?' && !document.querySelector('.modal-bg')) help();
    if (/^[1-8]$/.test(e.key) && S.c && !e.ctrlKey && !e.metaKey && !e.altKey) showTab(TABS[+e.key - 1][0]);
  });
  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => S.c && refresh(), 200); });
  function route() { const m = location.hash.match(/s=([^&]+)/); if (m) openScenario(decodeURIComponent(m[1])); else landing(); }
  window.addEventListener('hashchange', route);
  loadAll(() => { shell(); route(); });
  OBS._state = S; // for debugging in devtools
})();
