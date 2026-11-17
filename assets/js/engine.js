/* =============================================================================
 * engine.js — Scenario compiler for the Observatory.
 *
 * A scenario is a *declarative description of telemetry* (metrics, logs, traces,
 * events, topology). This file turns it into concrete arrays the UI can render.
 * Nothing here simulates a distributed system; it simulates what your
 * monitoring tools would SHOW you about one.
 *
 * Works in the browser (attaches to window.OBS) and in node (tools/validate.js).
 * See docs/scenario-format.md for the full authoring reference.
 * ========================================================================== */
(function (G) {
  'use strict';
  const OBS = (G.OBS = G.OBS || {});
  OBS.scenarios = OBS.scenarios || {};
  OBS.register = function (s) {
    if (!s || !s.id) throw new Error('OBS.register: scenario needs an id');
    OBS.scenarios[s.id] = s;
  };

  // ---------------------------------------------------------------- RNG ----
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function poisson(rand, lambda) {
    if (lambda <= 0) return 0;
    if (lambda > 30) { // normal approximation
      let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand();
      return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
    }
    const L = Math.exp(-lambda); let k = 0, p = 1;
    do { k++; p *= rand(); } while (p > L);
    return k - 1;
  }

  // ------------------------------------------------------------ helpers ----
  // `h` is passed to every authoring function: fn(t, h, i)
  function makeHelpers(rand, store, step) {
    const h = {
      rand,
      /** uniform noise in [-amp, amp] */
      noise: (amp = 1) => (rand() * 2 - 1) * amp,
      /** gaussian noise with std-dev sd */
      gauss: (sd = 1) => {
        let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand();
        return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      },
      /** v scaled by a random factor in [1-frac, 1+frac] */
      jitter: (v, frac = 0.05) => v * (1 + (rand() * 2 - 1) * frac),
      /** heavy-tailed sample (log-normal) with given median; sigma ~0.3-1 */
      lognormal: (median, sigma = 0.5) => median * Math.exp(h.gauss(sigma)),
      /** a before t0, b after t1, linear in between */
      ramp: (t, t0, t1, a = 0, b = 1) => (t <= t0 ? a : t >= t1 ? b : a + ((b - a) * (t - t0)) / (t1 - t0)),
      /** v once t >= t0, else 0 */
      step: (t, t0, v = 1) => (t >= t0 ? v : 0),
      /** v while t0 <= t < t1, else 0 */
      window: (t, t0, t1, v = 1) => (t >= t0 && t < t1 ? v : 0),
      /** gaussian bump centred at `center`, full width ~`width` */
      pulse: (t, center, width, height = 1) => height * Math.exp(-0.5 * ((t - center) / (width / 2)) ** 2),
      /** jumps to `height` at t0 then decays exponentially with time-constant tau */
      decay: (t, t0, height, tau) => (t < t0 ? 0 : height * Math.exp(-(t - t0) / tau)),
      /** sawtooth 0→1 repeating every `period` seconds */
      saw: (t, period, phase = 0) => ((((t + phase) % period) + period) % period) / period,
      /** sine in [-1, 1] */
      sine: (t, period, phase = 0) => Math.sin((2 * Math.PI * (t + phase)) / period),
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      chance: (p) => rand() < p,
      pick: (arr) => arr[Math.floor(rand() * arr.length)],
      int: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)),
      hex: (n = 8) => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(rand() * 16).toString(16); return s; },
      /** value of an already-defined metric at time t (nearest sample). */
      get: (key, t) => {
        const s = store[key];
        if (!s) throw new Error('h.get: unknown metric "' + key + '" (metrics can only read metrics defined ABOVE them)');
        let i = Math.round(t / step); i = Math.max(0, Math.min(s.length - 1, i));
        return s[i];
      },
      /** value of a metric `dt` seconds ago — useful for feedback loops / lag */
      lag: (key, t, dt) => h.get(key, t - dt),
      /** Build a trace span. children are laid out sequentially unless opts.parallel. */
      span: (service, op, selfMs, children, opts) => {
        opts = opts || {};
        return {
          service, op,
          self: Math.max(0.05, +selfMs || 0),
          children: (children || []).filter(Boolean),
          parallel: !!opts.parallel,
          error: !!opts.error,
          tags: opts.tags || {},
          note: opts.note || null,
          gap: opts.gap != null ? opts.gap : 0.3, // network hop before this span, ms
        };
      },
    };
    return h;
  }

  // ------------------------------------------------------- trace layout ----
  function layoutSpan(sp, start, depth, out) {
    sp.start = start; sp.depth = depth;
    out.push(sp);
    const pre = sp.self * 0.6;
    let cur = start + pre, end = cur;
    if (sp.parallel) {
      for (const c of sp.children) { layoutSpan(c, cur + c.gap, depth + 1, out); end = Math.max(end, c.start + c.dur); }
    } else {
      for (const c of sp.children) { layoutSpan(c, cur + c.gap, depth + 1, out); cur = c.start + c.dur; end = cur; }
    }
    sp.dur = end - start + sp.self * 0.4;
    return sp;
  }

  // ----------------------------------------------------------- compile ----
  OBS.compile = function (s) {
    const errors = [];
    const step = s.step || 10;
    const duration = s.duration || 3600;
    const n = Math.floor(duration / step) + 1;
    const times = new Array(n); for (let i = 0; i < n; i++) times[i] = i * step;
    const rand = mulberry32(s.seed != null ? s.seed : hashStr(s.id));
    const series = {}, meta = {};
    const h = makeHelpers(rand, series, step);

    // ---- metrics
    for (const m of s.metrics || []) {
      let insts = [null];
      if (typeof m.instances === 'number') insts = Array.from({ length: m.instances }, (_, k) => k + 1);
      else if (Array.isArray(m.instances)) insts = m.instances;
      for (const i of insts) {
        const entity = i == null ? m.entity : String(m.entity).split('{i}').join(i);
        const key = entity + ':' + m.name;
        if (series[key]) errors.push('duplicate metric ' + key);
        const vals = new Array(n);
        let ema = null;
        for (let k = 0; k < n; k++) {
          let v = m.fn(times[k], h, i);
          if (typeof v !== 'number' || !isFinite(v)) { errors.push(key + ' produced ' + v + ' at t=' + times[k]); v = 0; }
          if (m.smooth) { ema = ema == null ? v : ema + (v - ema) / m.smooth; v = ema; }
          const lo = m.min != null ? m.min : 0;
          if (lo !== null && lo !== -Infinity) v = Math.max(lo, v);
          if (m.max != null) v = Math.min(m.max, v);
          vals[k] = v;
        }
        series[key] = vals;
        const parts = entity.split('/');
        meta[key] = {
          key, entity, name: m.name, unit: m.unit || '', desc: m.desc || '',
          service: parts[0], instance: parts.length > 1 ? parts.slice(1).join('/') : null,
        };
      }
    }

    // ---- events
    const events = (s.events || []).map((e) => Object.assign({ kind: 'info', entity: '', msg: '' }, e)).sort((a, b) => a.t - b.t);

    // ---- logs
    const logs = [];
    const MAX_LOGS = s.maxLogs || 25000;
    const resolveEntity = (e, t) => (typeof e === 'function' ? e(t, h) : Array.isArray(e) ? h.pick(e) : e);
    for (const L of s.logs || []) {
      if (L.t != null) {
        const ent = resolveEntity(L.entity, L.t);
        logs.push({ t: L.t, entity: ent, level: L.level || 'INFO', msg: typeof L.msg === 'function' ? L.msg(L.t, h, ent) : L.msg });
        continue;
      }
      const from = L.from != null ? L.from : 0, to = L.to != null ? L.to : duration;
      const rateOf = typeof L.rate === 'function' ? L.rate : () => (L.rate != null ? L.rate : 1 / (L.every || 60));
      for (let t = from; t < to && logs.length < MAX_LOGS; t += 1) {
        const k = poisson(rand, rateOf(t, h));
        for (let j = 0; j < k; j++) {
          const tt = t + rand();
          const ent = resolveEntity(L.entity, tt);
          const lvl = typeof L.level === 'function' ? L.level(tt, h) : L.level || 'INFO';
          logs.push({ t: tt, entity: ent, level: lvl, msg: typeof L.msg === 'function' ? L.msg(tt, h, ent) : L.msg });
        }
      }
    }
    if (logs.length >= MAX_LOGS) errors.push('log cap (' + MAX_LOGS + ') reached: later log generators were truncated. Lower rates or set scenario.maxLogs');
    logs.sort((a, b) => a.t - b.t);

    // ---- traces
    const traces = [];
    const MAX_TRACES = s.maxTraces || 4000;
    for (const T of s.traces || []) {
      const from = T.from != null ? T.from : 0, to = T.to != null ? T.to : duration;
      let ts = [];
      if (T.count) { for (let j = 0; j < T.count; j++) ts.push(from + rand() * (to - from)); }
      else {
        const rateOf = typeof T.rate === 'function' ? T.rate : () => T.rate || 0.1;
        for (let t = from; t < to; t += 1) { const k = poisson(rand, rateOf(t, h)); for (let j = 0; j < k; j++) ts.push(t + rand()); }
      }
      for (const t of ts) {
        if (traces.length >= MAX_TRACES) break;
        let root;
        try { root = T.fn(t, h); } catch (e) { errors.push('trace ' + (T.name || '?') + ': ' + e.message); break; }
        if (!root) continue;
        const spans = [];
        layoutSpan(root, 0, 0, spans);
        const services = Array.from(new Set(spans.map((x) => x.service)));
        traces.push({
          id: h.hex(16), t, name: T.name || root.op, root, spans,
          dur: root.dur, error: spans.some((x) => x.error), services,
        });
      }
    }
    traces.sort((a, b) => a.t - b.t);

    // ---- sanity checks on references
    const keyExists = (k) => !!series[k];
    for (const d of s.dashboards || []) for (const c of d.charts || []) for (const k of c.series || []) {
      if (!keyExists(k) && !(k.includes('*'))) errors.push('dashboard "' + d.title + '" references unknown metric ' + k);
    }
    for (const nd of (s.topology && s.topology.nodes) || []) {
      if (nd.health && !keyExists(nd.health)) errors.push('topology node ' + nd.id + ' health metric missing: ' + nd.health);
    }
    for (const e of (s.topology && s.topology.edges) || []) {
      if (e.metric && !keyExists(e.metric)) errors.push('topology edge ' + e.from + '->' + e.to + ' metric missing: ' + e.metric);
    }

    return {
      scenario: s, step, duration, n, times, series, meta, events, logs, traces, errors,
      start: Date.parse(s.startTime || '2026-01-01T00:00:00Z'),
    };
  };

  /** Expand a metric pattern like "orders/*:cpu" into concrete keys. */
  OBS.expandKeys = function (compiled, pattern) {
    if (!pattern.includes('*')) return compiled.series[pattern] ? [pattern] : [];
    const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^:]*') + '$');
    return Object.keys(compiled.series).filter((k) => re.test(k));
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = OBS;
})(typeof window !== 'undefined' ? window : globalThis);
