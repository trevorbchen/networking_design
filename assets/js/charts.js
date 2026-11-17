/* =============================================================================
 * charts.js — tiny dependency-free chart kit used by the Observatory and Lab.
 *   OBS.fmt.*        value / time formatting
 *   OBS.el(...)      DOM helper
 *   OBS.LineChart    multi-series SVG time-series chart (crosshair, brush, thresholds)
 *   OBS.Heatmap      canvas entity x time heatmap
 *   OBS.svgPlot      simple x/y plot for the Lab
 * ========================================================================== */
(function (G) {
  'use strict';
  const OBS = (G.OBS = G.OBS || {});
  const SVGNS = 'http://www.w3.org/2000/svg';

  OBS.PALETTE = ['#4e9cff', '#f5a524', '#3fcf8e', '#f2617a', '#a78bfa', '#22d3ee', '#fb923c', '#facc15', '#e879f9', '#34d399', '#94a3b8', '#60a5fa', '#fda4af', '#bef264'];
  OBS.EVENT_COLORS = { deploy: '#a78bfa', config: '#22d3ee', scale: '#3fcf8e', alert: '#f2617a', incident: '#f2617a', failover: '#fb923c', info: '#94a3b8', traffic: '#facc15', cron: '#64748b' };

  // ------------------------------------------------------------- DOM ------
  OBS.el = function (tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };
  function svg(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
    return e;
  }
  OBS.svg = svg;

  // ---------------------------------------------------------- format ------
  const fmt = (OBS.fmt = {});
  fmt.num = function (v, digits) {
    if (v == null || !isFinite(v)) return '–';
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'G';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
    if (digits != null) return v.toFixed(digits);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  };
  fmt.bytes = function (v) {
    const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0;
    while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
  };
  fmt.ms = function (v) {
    if (v == null || !isFinite(v)) return '–';
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' s';
    if (v >= 10) return v.toFixed(0) + ' ms';
    if (v >= 1) return v.toFixed(1) + ' ms';
    return (v * 1000).toFixed(0) + ' µs';
  };
  fmt.val = function (v, unit) {
    if (v == null || !isFinite(v)) return '–';
    switch (unit) {
      case '%': return v.toFixed(v < 10 ? 2 : 1) + '%';
      case 'ms': return fmt.ms(v);
      case 's': return fmt.ms(v * 1000);
      case 'B': return fmt.bytes(v);
      case 'B/s': return fmt.bytes(v) + '/s';
      case 'ratio': return (v * 100).toFixed(1) + '%';
      case '': return fmt.num(v);
      default: return fmt.num(v) + ' ' + unit;
    }
  };
  fmt.clock = function (startMs, t, withDate) {
    const d = new Date(startMs + t * 1000);
    const p = (x) => String(x).padStart(2, '0');
    const s = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
    return withDate ? d.toISOString().slice(0, 10) + ' ' + s + ' UTC' : s;
  };
  fmt.dur = function (sec) {
    sec = Math.round(sec);
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm' + (sec % 60 ? ' ' + (sec % 60) + 's' : '');
    return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
  };

  function niceTicks(lo, hi, count) {
    if (hi <= lo) hi = lo + 1;
    const span = hi - lo, raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const stepv = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / stepv) * stepv; v <= hi + 1e-9; v += stepv) out.push(+v.toFixed(10));
    return out;
  }
  OBS.niceTicks = niceTicks;
  function timeTicks(t0, t1, px) {
    const target = Math.max(2, Math.floor(px / 90));
    const cands = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600];
    const stepv = cands.find((c) => (t1 - t0) / c <= target) || 43200;
    const out = [];
    for (let v = Math.ceil(t0 / stepv) * stepv; v <= t1; v += stepv) out.push(v);
    return out;
  }

  // ------------------------------------------------------- LineChart ------
  /**
   * ctx = { c: compiled, range():[t0,t1], setRange(t0,t1), cursor():t|null, setCursor(t), pin(obj) }
   * cfg = { title, keys:[metric keys], height, threshold, stacked, onRemove, onCorrelate, logY }
   */
  class LineChart {
    constructor(host, ctx, cfg) {
      this.ctx = ctx; this.cfg = cfg; this.hidden = new Set();
      this.root = OBS.el('div', { class: 'chart' });
      host.append(this.root);
      this.build();
    }
    get keys() { return this.cfg.keys; }
    build() {
      const cfg = this.cfg, c = this.ctx.c;
      const unit = (c.meta[cfg.keys[0]] || {}).unit || '';
      this.unit = unit;
      const head = OBS.el('div', { class: 'chart-head' });
      head.append(OBS.el('div', { class: 'chart-title', title: cfg.keys.join('\n') }, cfg.title || cfg.keys.join(', ')));
      if (unit) head.append(OBS.el('span', { class: 'chart-unit' }, unit));
      const tools = OBS.el('div', { class: 'chart-tools' });
      this.thInput = OBS.el('input', { class: 'th-input', type: 'number', step: 'any', placeholder: 'threshold', title: 'Draw a threshold line. Regions above it are shaded and the first crossing is reported.', value: cfg.threshold != null ? cfg.threshold : '' });
      this.thInput.addEventListener('input', () => { const v = parseFloat(this.thInput.value); this.cfg.threshold = isFinite(v) ? v : null; this.render(); this.ctx.onChange && this.ctx.onChange(); });
      tools.append(this.thInput);
      tools.append(OBS.el('button', { class: 'btn-icon', title: 'Toggle log scale', onclick: () => { cfg.logY = !cfg.logY; this.render(); } }, 'log'));
      tools.append(OBS.el('button', { class: 'btn-icon', title: 'Pin the value under the cursor as evidence in your report', onclick: () => this.pinCursor() }, '📌'));
      if (cfg.onCorrelate) tools.append(OBS.el('button', { class: 'btn-icon', title: 'Rank all other metrics by correlation with this one in the current time window', onclick: () => cfg.onCorrelate(this) }, '≈'));
      if (cfg.onRemove) tools.append(OBS.el('button', { class: 'btn-icon', title: 'Remove chart', onclick: () => cfg.onRemove(this) }, '✕'));
      head.append(tools);
      this.root.append(head);
      this.plot = OBS.el('div', { class: 'chart-plot' });
      this.root.append(this.plot);
      this.info = OBS.el('div', { class: 'chart-info' });
      this.root.append(this.info);
      this.legend = OBS.el('div', { class: 'chart-legend' });
      this.root.append(this.legend);
      this.tip = OBS.el('div', { class: 'chart-tip' });
      this.plot.append(this.tip);
    }
    colorOf(i) { return (this.cfg.colors && this.cfg.colors[i]) || OBS.PALETTE[i % OBS.PALETTE.length]; }
    labelOf(k) {
      const m = this.ctx.c.meta[k]; if (!m) return k;
      const sameName = this.cfg.keys.every((x) => (this.ctx.c.meta[x] || {}).name === m.name);
      return sameName ? m.entity : m.entity + ' · ' + m.name;
    }
    render() {
      const c = this.ctx.c, cfg = this.cfg;
      const [t0, t1] = this.ctx.range();
      const W = Math.max(200, this.plot.clientWidth || 600), H = cfg.height || 170;
      const M = { l: 54, r: 10, t: 8, b: 20 };
      const iw = W - M.l - M.r, ih = H - M.t - M.b;
      const i0 = Math.max(0, Math.floor(t0 / c.step)), i1 = Math.min(c.n - 1, Math.ceil(t1 / c.step));
      const keys = cfg.keys.filter((k) => c.series[k] && !this.hidden.has(k));
      let lo = Infinity, hi = -Infinity;
      for (const k of keys) { const s = c.series[k]; for (let i = i0; i <= i1; i++) { if (s[i] < lo) lo = s[i]; if (s[i] > hi) hi = s[i]; } }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (cfg.threshold != null) { hi = Math.max(hi, cfg.threshold); lo = Math.min(lo, cfg.threshold); }
      const logY = cfg.logY && lo >= 0;
      let ylo, yhi, ticks;
      if (logY) {
        ylo = Math.max(1e-3, lo > 0 ? lo : 1e-3); yhi = Math.max(ylo * 10, hi);
        ylo = Math.pow(10, Math.floor(Math.log10(ylo))); yhi = Math.pow(10, Math.ceil(Math.log10(yhi)));
        ticks = []; for (let v = ylo; v <= yhi * 1.0001; v *= 10) ticks.push(v);
      } else {
        ylo = lo >= 0 ? 0 : lo; yhi = hi + (hi - ylo) * 0.08 || 1;
        ticks = niceTicks(ylo, yhi, 4); yhi = Math.max(yhi, ticks[ticks.length - 1]);
      }
      const X = (t) => M.l + ((t - t0) / (t1 - t0 || 1)) * iw;
      const Y = logY ? (v) => M.t + ih - ((Math.log10(Math.max(v, ylo)) - Math.log10(ylo)) / (Math.log10(yhi) - Math.log10(ylo))) * ih
                     : (v) => M.t + ih - ((v - ylo) / (yhi - ylo || 1)) * ih;
      this.geom = { X, Y, M, iw, ih, t0, t1, W, H };

      const s = svg('svg', { width: W, height: H, class: 'chart-svg' });
      // grid + y ticks
      for (const v of ticks) {
        const y = Y(v);
        s.append(svg('line', { x1: M.l, x2: W - M.r, y1: y, y2: y, class: 'grid' }));
        const tx = svg('text', { x: M.l - 6, y: y + 3.5, class: 'tick', 'text-anchor': 'end' }); tx.textContent = OBS.fmt.val(v, this.unit === '%' ? '' : this.unit).replace(/ (req\/s|conn|ops\/s|msgs|msg\/s)$/, ''); s.append(tx);
      }
      for (const v of timeTicks(t0, t1, iw)) {
        const x = X(v);
        s.append(svg('line', { x1: x, x2: x, y1: M.t, y2: M.t + ih, class: 'grid grid-v' }));
        const tx = svg('text', { x, y: H - 5, class: 'tick', 'text-anchor': 'middle' }); tx.textContent = OBS.fmt.clock(c.start, v).slice(0, 5 + (t1 - t0 < 600 ? 3 : 0)); s.append(tx);
      }
      // threshold shading
      this.info.textContent = '';
      if (cfg.threshold != null && keys.length) {
        const th = cfg.threshold, yth = Y(th);
        let first = null, above = 0, total = 0, runStart = null;
        for (let i = i0; i <= i1; i++) {
          const any = keys.some((k) => c.series[k][i] > th);
          total++; if (any) { above++; if (first == null) first = c.times[i]; }
          if (any && runStart == null) runStart = c.times[i];
          if ((!any || i === i1) && runStart != null) {
            const xe = X(any ? c.times[i] : c.times[i]);
            s.append(svg('rect', { x: X(runStart), y: M.t, width: Math.max(1, xe - X(runStart)), height: ih, class: 'th-shade' }));
            runStart = null;
          }
        }
        s.append(svg('line', { x1: M.l, x2: W - M.r, y1: yth, y2: yth, class: 'th-line' }));
        this.info.textContent = first == null ? 'never above ' + OBS.fmt.val(th, this.unit) + ' in window'
          : 'first above ' + OBS.fmt.val(th, this.unit) + ' at ' + OBS.fmt.clock(c.start, first) + ' · above for ' + Math.round((100 * above) / total) + '% of window (' + OBS.fmt.dur(above * c.step) + ')';
      }
      // events
      for (const e of c.events) {
        if (e.t < t0 || e.t > t1) continue;
        const x = X(e.t), col = OBS.EVENT_COLORS[e.kind] || '#94a3b8';
        const g = svg('g', { class: 'evt' });
        g.append(svg('line', { x1: x, x2: x, y1: M.t, y2: M.t + ih, stroke: col, 'stroke-dasharray': '3 3', 'stroke-width': 1 }));
        g.append(svg('path', { d: `M${x - 4},${M.t} L${x + 4},${M.t} L${x},${M.t + 6} Z`, fill: col }));
        const ti = svg('title'); ti.textContent = OBS.fmt.clock(c.start, e.t) + ' [' + e.kind + '] ' + (e.entity ? e.entity + ': ' : '') + e.msg; g.append(ti);
        s.append(g);
      }
      // series
      keys.forEach((k) => {
        const idx = cfg.keys.indexOf(k);
        const vals = c.series[k]; let d = '';
        for (let i = i0; i <= i1; i++) d += (i === i0 ? 'M' : 'L') + X(c.times[i]).toFixed(1) + ',' + Y(vals[i]).toFixed(1);
        s.append(svg('path', { d, class: 'line', stroke: this.colorOf(idx), 'stroke-width': cfg.keys.length > 6 ? 1.1 : 1.6 }));
      });
      // cursor + interaction layer
      this.cursorLine = svg('line', { y1: M.t, y2: M.t + ih, class: 'cursor', visibility: 'hidden' });
      s.append(this.cursorLine);
      this.brush = svg('rect', { y: M.t, height: ih, class: 'brush', visibility: 'hidden' });
      s.append(this.brush);
      const hit = svg('rect', { x: M.l, y: M.t, width: iw, height: ih, fill: 'transparent', style: 'cursor:crosshair' });
      s.append(hit);
      this.bindMouse(hit);
      if (this.svgEl) this.svgEl.remove();
      this.svgEl = s; this.plot.prepend(s);
      this.renderLegend();
      this.drawCursor(this.ctx.cursor());
    }
    tAtX(px) { const g = this.geom; return g.t0 + ((px - g.M.l) / g.iw) * (g.t1 - g.t0); }
    bindMouse(hit) {
      let down = null;
      const local = (ev) => { const r = this.svgEl.getBoundingClientRect(); return ev.clientX - r.left; };
      hit.addEventListener('mousemove', (ev) => {
        const x = local(ev);
        this.hovering = true; this.lastCursor = Math.max(0, this.tAtX(x));
        OBS.activeChart = this;
        this.ctx.setCursor(this.lastCursor);
        if (down != null) {
          this.brush.setAttribute('x', Math.min(down, x)); this.brush.setAttribute('width', Math.abs(x - down));
          this.brush.setAttribute('visibility', 'visible');
        }
      });
      hit.addEventListener('mouseleave', () => { this.hovering = false; this.ctx.setCursor(null); });
      hit.addEventListener('mousedown', (ev) => { down = local(ev); ev.preventDefault(); });
      const up = (ev) => {
        if (down == null) return;
        const x = local(ev); const a = this.tAtX(Math.min(down, x)), b = this.tAtX(Math.max(down, x));
        down = null; this.brush.setAttribute('visibility', 'hidden');
        if (b - a > (this.geom.t1 - this.geom.t0) / 100 && b - a >= this.ctx.c.step * 2) this.ctx.setRange(Math.max(0, a), Math.min(this.ctx.c.duration, b));
      };
      hit.addEventListener('mouseup', up);
      hit.addEventListener('dblclick', () => this.ctx.setRange(0, this.ctx.c.duration));
    }
    valuesAt(t) {
      const c = this.ctx.c; const i = Math.max(0, Math.min(c.n - 1, Math.round(t / c.step)));
      return this.cfg.keys.filter((k) => c.series[k]).map((k, j) => ({ key: k, label: this.labelOf(k), v: c.series[k][i], color: this.colorOf(this.cfg.keys.indexOf(k)), hidden: this.hidden.has(k) }));
    }
    drawCursor(t) {
      if (!this.geom || !this.cursorLine) return;
      if (t == null || t < this.geom.t0 || t > this.geom.t1) { this.cursorLine.setAttribute('visibility', 'hidden'); this.tip.style.display = 'none'; this.updateLegendValues(null); return; }
      const x = this.geom.X(t);
      this.cursorLine.setAttribute('x1', x); this.cursorLine.setAttribute('x2', x); this.cursorLine.setAttribute('visibility', 'visible');
      const vals = this.valuesAt(t);
      this.updateLegendValues(vals);
      if (this.hovering) {
        const rows = vals.filter((v) => !v.hidden).sort((a, b) => b.v - a.v).slice(0, 8);
        this.tip.innerHTML = '<div class="tip-time">' + OBS.fmt.clock(this.ctx.c.start, t) + '</div>' + rows.map((r) => `<div><i style="background:${r.color}"></i>${r.label}<b>${OBS.fmt.val(r.v, this.unit)}</b></div>`).join('');
        this.tip.style.display = 'block';
        const left = x + 14 + 220 > this.geom.W ? x - 14 - 220 : x + 14;
        this.tip.style.left = left + 'px';
      } else this.tip.style.display = 'none';
    }
    renderLegend() {
      this.legend.innerHTML = '';
      this.legendItems = {};
      this.cfg.keys.forEach((k, i) => {
        if (!this.ctx.c.series[k]) { this.legend.append(OBS.el('span', { class: 'lg missing' }, '⚠ ' + k)); return; }
        const val = OBS.el('b', {}, '');
        const item = OBS.el('span', { class: 'lg' + (this.hidden.has(k) ? ' off' : ''), title: (this.ctx.c.meta[k].desc || k) + '\n(click to hide/show, alt-click to solo)', onclick: (ev) => {
          if (ev.altKey) { const solo = this.hidden.size === this.cfg.keys.length - 1 && !this.hidden.has(k); this.hidden = new Set(solo ? [] : this.cfg.keys.filter((x) => x !== k)); }
          else if (this.hidden.has(k)) this.hidden.delete(k); else this.hidden.add(k);
          this.render();
        } }, OBS.el('i', { style: { background: this.colorOf(i) } }), this.labelOf(k), val);
        this.legendItems[k] = val; this.legend.append(item);
      });
    }
    updateLegendValues(vals) {
      if (!this.legendItems) return;
      for (const k in this.legendItems) this.legendItems[k].textContent = '';
      if (vals) for (const v of vals) if (this.legendItems[v.key]) this.legendItems[v.key].textContent = OBS.fmt.val(v.v, this.unit);
    }
    pinCursor() {
      const t = this.lastCursor != null ? this.lastCursor : this.ctx.cursor();
      if (t == null) { alert('Hover over the chart first, then press 📌 (or press "p" while hovering).'); return; }
      const vals = this.valuesAt(t).filter((v) => !v.hidden);
      this.ctx.pin({ t, chart: this.cfg.title || this.cfg.keys.join(', '), values: vals.map((v) => ({ label: v.label, v: OBS.fmt.val(v.v, this.unit) })) });
    }
  }
  OBS.LineChart = LineChart;

  // --------------------------------------------------------- Heatmap ------
  /** rows: [{label, values:[]}]; draws entity x time grid on canvas */
  OBS.Heatmap = function (host, ctx, rows, unit, opts) {
    opts = opts || {};
    const c = ctx.c; const [t0, t1] = ctx.range();
    const i0 = Math.max(0, Math.floor(t0 / c.step)), i1 = Math.min(c.n - 1, Math.ceil(t1 / c.step));
    const labelW = 170, rowH = Math.max(10, Math.min(26, Math.floor(420 / Math.max(1, rows.length))));
    const W = Math.max(300, host.clientWidth - 4), H = rows.length * rowH + 24;
    const cv = OBS.el('canvas', { width: W * 2, height: H * 2, style: { width: W + 'px', height: H + 'px' }, class: 'heat-canvas' });
    const g = cv.getContext('2d'); g.scale(2, 2);
    let lo = Infinity, hi = -Infinity;
    for (const r of rows) for (let i = i0; i <= i1; i++) { lo = Math.min(lo, r.values[i]); hi = Math.max(hi, r.values[i]); }
    if (opts.rowNormalize) { lo = 0; hi = 1; }
    const iw = W - labelW - 4, cols = i1 - i0 + 1, cw = iw / cols;
    const color = (f) => { // dark blue -> teal -> yellow -> red
      f = Math.max(0, Math.min(1, f));
      const stops = [[13, 27, 52], [20, 110, 140], [60, 190, 120], [245, 200, 50], [242, 80, 90]];
      const x = f * (stops.length - 1), a = Math.floor(x), b = Math.min(stops.length - 1, a + 1), u = x - a;
      return 'rgb(' + stops[a].map((v, j) => Math.round(v + (stops[b][j] - v) * u)).join(',') + ')';
    };
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'; g.textBaseline = 'middle';
    rows.forEach((r, ri) => {
      let rlo = lo, rhi = hi;
      if (opts.rowNormalize) { rlo = Infinity; rhi = -Infinity; for (let i = i0; i <= i1; i++) { rlo = Math.min(rlo, r.values[i]); rhi = Math.max(rhi, r.values[i]); } }
      for (let i = i0; i <= i1; i++) {
        g.fillStyle = color((r.values[i] - rlo) / (rhi - rlo || 1));
        g.fillRect(labelW + (i - i0) * cw, ri * rowH, Math.ceil(cw) + 0.5, rowH - 1);
      }
      g.fillStyle = '#c9d4e3'; g.fillText(r.label.length > 24 ? '…' + r.label.slice(-23) : r.label, 4, ri * rowH + rowH / 2);
    });
    g.fillStyle = '#8a97ab';
    for (const v of timeTicks(t0, t1, iw)) { const x = labelW + ((v - t0) / (t1 - t0)) * iw; g.fillText(OBS.fmt.clock(c.start, v).slice(0, 5), x - 14, rows.length * rowH + 12); }
    for (const e of c.events) { if (e.t < t0 || e.t > t1) continue; const x = labelW + ((e.t - t0) / (t1 - t0)) * iw; g.fillStyle = OBS.EVENT_COLORS[e.kind] || '#999'; g.fillRect(x, 0, 1.5, rows.length * rowH); }
    host.append(cv);
    const tip = OBS.el('div', { class: 'chart-tip' }); host.style.position = 'relative'; host.append(tip);
    cv.addEventListener('mousemove', (ev) => {
      const rc = cv.getBoundingClientRect(); const x = ev.clientX - rc.left, y = ev.clientY - rc.top;
      const ri = Math.floor(y / rowH), ci = Math.floor((x - labelW) / cw) + i0;
      if (ri < 0 || ri >= rows.length || x < labelW || ci > i1) { tip.style.display = 'none'; return; }
      ctx.setCursor(c.times[ci]);
      tip.style.display = 'block'; tip.style.left = Math.min(x + 12, W - 230) + 'px'; tip.style.top = y + 10 + 'px';
      tip.innerHTML = `<div class="tip-time">${OBS.fmt.clock(c.start, c.times[ci])}</div><div>${rows[ri].label}<b>${OBS.fmt.val(rows[ri].values[ci], unit)}</b></div>`;
    });
    cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; ctx.setCursor(null); });
    return { lo, hi };
  };

  // ------------------------------------------------- simple x/y plot ------
  /** For the Lab. series: [{label, color, points:[[x,y],...], dash}], opts: {xLabel,yLabel,xMax,yMax,marker:[x,y],xLog,height} */
  OBS.svgPlot = function (host, series, opts) {
    opts = opts || {};
    host.innerHTML = '';
    const W = Math.max(280, host.clientWidth || 520), H = opts.height || 260, M = { l: 56, r: 14, t: 12, b: 38 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    let xmax = opts.xMax, ymax = opts.yMax, xmin = opts.xMin || 0, ymin = opts.yMin || 0;
    if (xmax == null) xmax = Math.max(...series.flatMap((s) => s.points.map((p) => p[0])));
    if (ymax == null) ymax = Math.max(...series.flatMap((s) => s.points.map((p) => p[1]))) * 1.08 || 1;
    const X = (x) => M.l + ((x - xmin) / (xmax - xmin || 1)) * iw, Y = (y) => M.t + ih - ((Math.min(y, ymax) - ymin) / (ymax - ymin || 1)) * ih;
    const s = svg('svg', { width: W, height: H, class: 'chart-svg' });
    for (const v of niceTicks(ymin, ymax, 5)) { s.append(svg('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: 'grid' })); const t = svg('text', { x: M.l - 6, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' }); t.textContent = opts.yFmt ? opts.yFmt(v) : fmt.num(v); s.append(t); }
    for (const v of niceTicks(xmin, xmax, 6)) { s.append(svg('line', { x1: X(v), x2: X(v), y1: M.t, y2: M.t + ih, class: 'grid grid-v' })); const t = svg('text', { x: X(v), y: H - 22, class: 'tick', 'text-anchor': 'middle' }); t.textContent = opts.xFmt ? opts.xFmt(v) : fmt.num(v); s.append(t); }
    if (opts.xLabel) { const t = svg('text', { x: M.l + iw / 2, y: H - 4, class: 'axis-label', 'text-anchor': 'middle' }); t.textContent = opts.xLabel; s.append(t); }
    if (opts.yLabel) { const t = svg('text', { x: 12, y: M.t + ih / 2, class: 'axis-label', 'text-anchor': 'middle', transform: `rotate(-90 12 ${M.t + ih / 2})` }); t.textContent = opts.yLabel; s.append(t); }
    for (const b of opts.bands || []) s.append(svg('rect', { x: X(b.x0), y: M.t, width: X(b.x1) - X(b.x0), height: ih, fill: b.color, opacity: b.opacity || 0.12 }));
    series.forEach((se, i) => {
      const d = se.points.filter((p) => isFinite(p[1])).map((p, j) => (j ? 'L' : 'M') + X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join('');
      s.append(svg('path', { d, class: 'line', stroke: se.color || OBS.PALETTE[i], 'stroke-width': se.width || 2, 'stroke-dasharray': se.dash || null }));
    });
    for (const mk of opts.markers || []) {
      s.append(svg('circle', { cx: X(mk[0]), cy: Y(mk[1]), r: 5, fill: mk[2] || '#f2617a', stroke: '#fff', 'stroke-width': 1.5 }));
    }
    host.append(s);
    if (series.some((se) => se.label)) host.append(OBS.el('div', { class: 'chart-legend' }, series.filter((se) => se.label).map((se, i) => OBS.el('span', { class: 'lg' }, OBS.el('i', { style: { background: se.color || OBS.PALETTE[i] } }), se.label))));
  };
})(typeof window !== 'undefined' ? window : globalThis);
