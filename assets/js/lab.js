/* =============================================================================
 * lab.js — Concepts Lab: interactive visualizations of classic system-design and
 * database ideas. Each widget is a function (host) => void registered in LAB.
 * ========================================================================== */
(function () {
  'use strict';
  const { el, fmt } = OBS;
  const LAB = [];
  const add = (id, title, render) => LAB.push({ id, title, render });

  function slider(label, min, max, step, value, onInput, format, lazy) {
    const out = el('output', {}, format ? format(value) : value);
    const inp = el('input', { type: 'range', min, max, step, value });
    inp.addEventListener('input', () => { out.textContent = format ? format(+inp.value) : inp.value; if (!lazy) onInput(+inp.value); });
    if (lazy) inp.addEventListener('change', () => onInput(+inp.value));
    const row = el('div', { class: 'ctrl' }, el('label', {}, label), inp, out);
    row.input = inp; row.set = (v) => { inp.value = v; out.textContent = format ? format(v) : v; }; return row;
  }
  const stat = (k, v) => el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
  const seeded = (seed) => { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  // ------------------------------------------------------------ queueing --
  function erlangC(c, a) { // a = λ/μ offered load; returns P(wait)
    let sum = 0, term = 1;
    for (let k = 0; k < c; k++) { if (k > 0) term *= a / k; sum += term; }
    const last = term * a / c; // a^c/c!
    const rho = a / c; if (rho >= 1) return 1;
    const top = last / (1 - rho);
    return top / (sum + top);
  }
  function mmc(lambda, S, c) { // S in ms
    const mu = 1000 / S; const a = lambda / mu; const rho = a / c;
    if (rho >= 1) return { rho, mean: Infinity, p99: Infinity, pw: 1 };
    const pw = erlangC(c, a); const rate = c * mu - lambda; // per second
    const wq = pw / rate * 1000;
    // P(Wq > t) = pw * exp(-rate t) → t99 for waiting; approximate total p99 = S*ln(100)?? use waiting tail + service median
    // sojourn T = S (prob 1-pw) or Wq+S (prob pw); Wq~Exp(rate), S~Exp(mu): solve P(T>t)=0.01
    const tail = (t) => { const a = Math.exp(-mu * t); const b = Math.abs(rate - mu) < 1e-9 ? (1 + mu * t) * a : (mu * Math.exp(-rate * t) - rate * a) / (mu - rate); return (1 - pw) * a + pw * b; };
    let lo = 0, hi = 1; while (tail(hi) > 0.01) hi *= 2;
    for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (tail(m) > 0.01) lo = m; else hi = m; }
    return { rho, mean: wq + S, p99: hi * 1000, pw, wq };
  }
  add('queueing', 'Queueing & the utilization knee', (host) => {
    host.append(el('h2', {}, 'Queueing: why latency explodes near 100% utilization'),
      el('p', {}, 'Model a service as an M/M/c queue: requests arrive randomly at rate λ, each takes ~S ms of work, and there are c workers (threads, connections, CPU cores). As utilization ρ = λ·S / c approaches 1, the time spent ', el('i', {}, 'waiting'), ' grows like 1/(1−ρ). That is why a pool at 85% is fine and at 97% is an incident, and why thresholds at 70–80% buy real headroom.'),
      el('div', { class: 'callout' }, el('b', {}, 'Little\'s law: '), 'L = λ × W. Items in the system = arrival rate × time in system. Use it everywhere: connections in use = QPS × hold time; queue length = rate × wait.'));
    const st = { lambda: 600, S: 20, c: 16 };
    const stats = el('div', { class: 'stat-row' }); const plot = el('div', { class: 'panel' });
    host.append(slider('arrival rate λ (req/s)', 10, 1500, 10, st.lambda, (v) => { st.lambda = v; draw(); }),
      slider('service time S (ms)', 1, 100, 1, st.S, (v) => { st.S = v; draw(); }, (v) => v + ' ms'),
      slider('servers c (threads/conns)', 1, 64, 1, st.c, (v) => { st.c = v; draw(); }), stats, plot,
      el('p', { class: 'muted' }, 'Try it: set c=16, S=20ms and slide λ from 400 → 790. Utilization rises ~2× but p99 rises far more than 2×. Then double c: the same load sits comfortably on the flat part of the curve. Bigger pools also "smooth" randomness. Compare c=1 vs c=32 at the same ρ.'));
    function draw() {
      const r = mmc(st.lambda, st.S, st.c);
      stats.innerHTML = '';
      stats.append(stat('utilization ρ', (r.rho * 100).toFixed(1) + '%'), stat('P(must wait)', (r.pw * 100).toFixed(1) + '%'), stat('mean latency', isFinite(r.mean) ? fmt.ms(r.mean) : '∞ (overloaded)'), stat('≈ p99 latency', isFinite(r.p99) ? fmt.ms(r.p99) : '∞'), stat('in system (L=λW)', isFinite(r.mean) ? (st.lambda * r.mean / 1000).toFixed(1) : '∞'), stat('capacity', fmt.num(st.c * 1000 / st.S) + ' req/s'));
      const pts = [], pts99 = [];
      for (let u = 0.02; u < 0.995; u += 0.005) { const m = mmc(u * st.c * 1000 / st.S, st.S, st.c); pts.push([u * 100, m.mean]); pts99.push([u * 100, m.p99]); }
      const ymax = Math.max(st.S * 12, isFinite(r.p99) ? r.p99 * 1.2 : 0);
      OBS.svgPlot(plot, [{ label: 'mean latency', points: pts, color: '#4e9cff' }, { label: '≈ p99 latency', points: pts99, color: '#f2617a' }],
        { xLabel: 'utilization', xFmt: (v) => v + '%', yLabel: 'latency (ms)', xMax: 100, yMax: Math.min(ymax, st.S * 60), markers: isFinite(r.mean) ? [[r.rho * 100, Math.min(r.p99, st.S * 60)], [r.rho * 100, r.mean, '#4e9cff']] : [], bands: [{ x0: 80, x1: 100, color: '#f2617a', opacity: 0.08 }], height: 300 });
    }
    draw();
  });

  // ------------------------------------------------------------- fan-out --
  add('fanout', 'Tail latency at scale (fan-out)', (host) => {
    host.append(el('h2', {}, 'Fan-out: your p99 becomes everyone\'s p50'),
      el('p', {}, 'If one request fans out to N backends in parallel and waits for all of them, it is as slow as the slowest. If each backend is "slow" with probability p (say p=1%, its p99), then P(request is slow) = 1 − (1−p)^N. With N=100, 63% of requests hit at least one backend\'s p99.'),
      el('p', {}, el('b', {}, 'Hedged requests'), ': after waiting for the p95 latency, send a duplicate to another replica and take whichever answers first. Per-backend slow probability drops from p to ≈ p·p′ for ~5% extra load (Dean & Barroso, "The Tail at Scale").'));
    const st = { p: 1, N: 8 };
    const stats = el('div', { class: 'stat-row' }), plot = el('div', { class: 'panel' });
    host.append(slider('per-backend P(slow) %', 0.1, 10, 0.1, st.p, (v) => { st.p = v; draw(); }, (v) => v.toFixed(1) + '%'), slider('fan-out N', 1, 200, 1, st.N, (v) => { st.N = v; draw(); }), stats, plot);
    function draw() {
      const p = st.p / 100, f = (n, q) => 100 * (1 - Math.pow(1 - q, n));
      const ph = p * 0.05; // hedge after p95: request slow only if both primary slow and hedge slow-ish
      stats.innerHTML = ''; stats.append(stat('P(request slow)', f(st.N, p).toFixed(1) + '%'), stat('with hedging', f(st.N, ph).toFixed(2) + '%'), stat('one always-slow node', '100%'));
      const a = [], b = []; for (let n = 1; n <= 200; n++) { a.push([n, f(n, p)]); b.push([n, f(n, ph)]); }
      OBS.svgPlot(plot, [{ label: 'no hedging', points: a }, { label: 'hedged at p95', points: b, color: '#3fcf8e' }], { xLabel: 'fan-out N', yLabel: 'requests slow', yFmt: (v) => v + '%', yMax: 100, markers: [[st.N, f(st.N, p)]], height: 280 });
    }
    draw();
  });

  // ---------------------------------------------------- consistent hashing --
  function h32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15; return (h >>> 0) / 4294967296; }
  add('hashing', 'Consistent hashing', (host) => {
    host.append(el('h2', {}, 'Consistent hashing & virtual nodes'),
      el('p', {}, 'Keys and nodes are hashed onto a ring. A key belongs to the first node clockwise. Adding or removing a node only moves the keys in its arc (~1/N of keys), unlike ', el('code', {}, 'hash(key) mod N'), ', which remaps almost everything. Virtual nodes (many points per physical node) even out the arcs, so load is balanced.'));
    const st = { nodes: 5, vnodes: 1 };
    const KEYS = Array.from({ length: 3000 }, (_, i) => 'key-' + i);
    const ring = el('div', { class: 'panel', style: { display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' } });
    const stats = el('div', { class: 'stat-row' });
    host.append(slider('physical nodes', 2, 12, 1, st.nodes, (v) => { st.nodes = v; draw(); }), slider('virtual nodes per node', 1, 200, 1, st.vnodes, (v) => { st.vnodes = v; draw(); }), stats, ring);
    function build(n, v) { const pts = []; for (let i = 0; i < n; i++) for (let j = 0; j < v; j++) pts.push({ pos: h32('node-' + i + '#' + j), node: i }); return pts.sort((a, b) => a.pos - b.pos); }
    function owner(pts, k) { const x = h32(k); let lo = 0, hi = pts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].pos < x) lo = m + 1; else hi = m; } return pts[lo % pts.length].node; }
    function draw() {
      const pts = build(st.nodes, st.vnodes), pts2 = build(st.nodes + 1, st.vnodes);
      const counts = new Array(st.nodes).fill(0); let moved = 0, movedMod = 0;
      for (const k of KEYS) { const o = owner(pts, k); counts[o]++; if (owner(pts2, k) !== o) moved++; const hv = Math.floor(h32(k) * 1e9); if (hv % st.nodes !== hv % (st.nodes + 1)) movedMod++; }
      const mean = KEYS.length / st.nodes, max = Math.max(...counts);
      stats.innerHTML = ''; stats.append(stat('max / mean load', (max / mean).toFixed(2) + '×'), stat('keys moved adding 1 node', (100 * moved / KEYS.length).toFixed(1) + '%'), stat('ideal', (100 / (st.nodes + 1)).toFixed(1) + '%'), stat('with mod-N hashing', (100 * movedMod / KEYS.length).toFixed(1) + '%'));
      ring.innerHTML = '';
      const R = 140, C = 160; const s = OBS.svg('svg', { width: 320, height: 320 });
      s.append(OBS.svg('circle', { cx: C, cy: C, r: R, fill: 'none', stroke: '#33435c', 'stroke-width': 2 }));
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length]; const a0 = a.pos * 2 * Math.PI - Math.PI / 2; let a1 = b.pos * 2 * Math.PI - Math.PI / 2; if (a1 <= a0) a1 += 2 * Math.PI;
        // arc (a, b] owned by b.node
        const large = a1 - a0 > Math.PI ? 1 : 0;
        s.append(OBS.svg('path', { d: `M${C + R * Math.cos(a0)},${C + R * Math.sin(a0)} A${R},${R} 0 ${large} 1 ${C + R * Math.cos(a1)},${C + R * Math.sin(a1)}`, stroke: OBS.PALETTE[b.node % 14], 'stroke-width': 10, fill: 'none' }));
      }
      if (pts.length <= 300) for (const p of pts) { const a = p.pos * 2 * Math.PI - Math.PI / 2; s.append(OBS.svg('circle', { cx: C + R * Math.cos(a), cy: C + R * Math.sin(a), r: st.vnodes > 20 ? 1.5 : 4, fill: '#fff' })); }
      const t = OBS.svg('text', { x: C, y: C + 4, fill: '#8a97ab', 'text-anchor': 'middle', 'font-size': 12 }); t.textContent = pts.length + ' ring points'; s.append(t);
      ring.append(s);
      const bars = el('div', { style: { flex: 1, minWidth: '260px' } }, el('h3', {}, 'keys per node (3000 keys)'));
      counts.forEach((c, i) => bars.append(el('div', { class: 'row', style: { margin: '3px 0' } }, el('span', { class: 'mono', style: { width: '60px' } }, 'node-' + i), el('div', { style: { height: '12px', width: (c / max) * 220 + 'px', background: OBS.PALETTE[i % 14], borderRadius: '2px' } }), el('span', { class: 'mono muted' }, c))));
      ring.append(bars);
    }
    draw();
  });

  // --------------------------------------------------------------- quorum --
  add('quorum', 'Quorum replication (N, R, W)', (host) => {
    host.append(el('h2', {}, 'Leaderless quorums: N replicas, write to W, read from R'),
      el('p', {}, 'Dynamo-style stores (Cassandra, Riak) write to W of N replicas and read from R, returning the newest version seen. If R + W > N, every read set overlaps every write set, so reads see the latest acknowledged write (absent sloppy quorums and concurrent-write edge cases). Lower R or W buys latency and availability at the cost of stale reads.'));
    const st = { N: 3, W: 2, R: 2, latest: 0, reps: [], log: [] };
    const reset = () => { st.reps = Array.from({ length: st.N }, () => ({ v: 0, up: true })); st.latest = 0; st.log = []; };
    reset();
    const rnd = seeded(42);
    const pickUp = (k) => { const up = st.reps.map((r, i) => i).filter((i) => st.reps[i].up); for (let i = up.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [up[i], up[j]] = [up[j], up[i]]; } return up.length >= k ? up.slice(0, k) : null; };
    const view = el('div', { class: 'panel' }); const info = el('div', { class: 'stat-row' });
    const sN = slider('N replicas', 1, 7, 1, st.N, (v) => { st.N = v; st.W = Math.min(st.W, v); st.R = Math.min(st.R, v); reset(); draw(); });
    const sW = slider('W (write acks)', 1, 7, 1, st.W, (v) => { st.W = Math.min(v, st.N); draw(); });
    const sR = slider('R (read replicas)', 1, 7, 1, st.R, (v) => { st.R = Math.min(v, st.N); draw(); });
    host.append(sN, sW, sR, el('div', { class: 'row' },
      el('button', { onclick: () => { const s = pickUp(st.W); if (!s) st.log.unshift('✕ write FAILED: fewer than W=' + st.W + ' replicas up (unavailable)'); else { st.latest++; s.forEach((i) => (st.reps[i].v = st.latest)); st.log.unshift('✓ write v' + st.latest + ' acked by replicas ' + s.map((i) => i + 1).join(',')); } draw(); } }, 'Write'),
      el('button', { onclick: () => { const s = pickUp(st.R); if (!s) st.log.unshift('✕ read FAILED: fewer than R=' + st.R + ' replicas up'); else { const v = Math.max(...s.map((i) => st.reps[i].v)); st.log.unshift((v < st.latest ? '⚠ STALE read' : '✓ read') + ' v' + v + ' from replicas ' + s.map((i) => i + 1).join(',') + (v < st.latest ? ' (latest is v' + st.latest + ')' : '')); } draw(); } }, 'Read'),
      el('button', { onclick: () => { for (let k = 0; k < 20; k++) { const s = pickUp(st.R); if (s) { const v = Math.max(...s.map((i) => st.reps[i].v)); if (v < st.latest) st.log.unshift('⚠ STALE read v' + v + ' (latest v' + st.latest + ')'); } } st.log.unshift('— ran 20 reads —'); draw(); } }, '20 reads'),
      el('button', { onclick: () => { st.reps.forEach((r) => (r.v = st.latest)); st.log.unshift('anti-entropy / read-repair: all up replicas synced'); draw(); } }, 'Anti-entropy repair'),
      el('button', { onclick: () => { reset(); draw(); } }, 'Reset')), info, view);
    function draw() {
      sW.input.max = st.N; sR.input.max = st.N; sW.set(st.W); sR.set(st.R);
      info.innerHTML = '';
      const strong = st.R + st.W > st.N;
      info.append(stat('R + W', st.R + st.W + (strong ? ' > ' : ' ≤ ') + 'N=' + st.N), stat('read overlap', strong ? 'guaranteed' : 'NOT guaranteed'), stat('writes tolerate', Math.max(0, st.N - st.W) + ' down'), stat('reads tolerate', Math.max(0, st.N - st.R) + ' down'));
      view.innerHTML = '';
      const row = el('div', { class: 'row', style: { marginBottom: '10px' } });
      st.reps.forEach((r, i) => row.append(el('div', { class: 'stat', style: { cursor: 'pointer', borderColor: r.up ? (r.v === st.latest ? '#3fcf8e' : '#f5a524') : '#f2617a', opacity: r.up ? 1 : 0.5 }, title: 'click to take down / bring up', onclick: () => { r.up = !r.up; st.log.unshift('replica ' + (i + 1) + (r.up ? ' back up' : ' DOWN')); draw(); } }, el('div', { class: 'k' }, 'replica ' + (i + 1) + (r.up ? '' : ' (down)')), el('div', { class: 'v' }, 'v' + r.v))));
      view.append(el('div', { class: 'muted' }, 'Click a replica to fail it. Green = has latest, amber = stale.'), row, el('div', { class: 'mono', style: { maxHeight: '220px', overflow: 'auto', fontSize: '12px' } }, st.log.slice(0, 40).map((l) => el('div', { class: l.startsWith('⚠') ? 'warnc' : l.startsWith('✕') ? 'err' : '' }, l))));
    }
    draw();
  });

  // ------------------------------------------------------------------ LSM --
  add('lsm', 'LSM-tree vs B-tree', (host) => {
    host.append(el('h2', {}, 'LSM-trees: buffer writes, flush sorted runs, compact'),
      el('p', {}, 'Writes go to an in-memory memtable (plus a WAL). When full, it is flushed as an immutable sorted file (SSTable) in L0. Compaction merges files into larger levels. Writes are sequential and fast. Reads may have to check the memtable and several SSTables (read amplification), which bloom filters mitigate. Data gets rewritten by every compaction (write amplification).'),
      el('p', {}, 'A ', el('b', {}, 'B-tree'), ' updates pages in place: a read touches ~log_B(n) pages (usually 3–4, mostly cached), and a write dirties a whole page (e.g. 8 KiB for a 100-byte row) plus the WAL. B-trees favor read-heavy workloads with predictable latency. LSMs favor write-heavy ingestion (Cassandra, RocksDB, ScyllaDB). Postgres and InnoDB use B-trees.'));
    const MEM = 8, L0MAX = 4, FAN = 4;
    const st = { mem: [], levels: [[], [], [], []], inserted: 0, written: 0, bloom: true, lastRead: '' };
    const rnd = seeded(7);
    const view = el('div', { class: 'panel' }), stats = el('div', { class: 'stat-row' });
    const bloomCb = el('input', { type: 'checkbox', checked: true }); bloomCb.addEventListener('change', () => { st.bloom = bloomCb.checked; draw(); });
    const put = (n) => {
      for (let i = 0; i < n; i++) {
        st.mem.push(Math.floor(rnd() * 500)); st.inserted++;
        if (st.mem.length >= MEM) { const run = Array.from(new Set(st.mem)).sort((a, b) => a - b); st.levels[0].push(run); st.written += run.length; st.mem = []; compact(); }
      }
      draw();
    };
    function compact() {
      if (st.levels[0].length > L0MAX) { const merged = mergeAll(st.levels[0].concat(st.levels[1])); st.levels[0] = []; st.levels[1] = split(merged); st.written += merged.length; }
      for (let L = 1; L < st.levels.length - 1; L++) {
        const size = st.levels[L].reduce((a, r) => a + r.length, 0);
        if (size > MEM * L0MAX * Math.pow(FAN, L - 1) * 1.5) { const merged = mergeAll(st.levels[L].concat(st.levels[L + 1])); st.levels[L] = []; st.levels[L + 1] = split(merged); st.written += merged.length; }
      }
    }
    const mergeAll = (runs) => Array.from(new Set(runs.flat())).sort((a, b) => a - b);
    const split = (arr) => { const out = []; for (let i = 0; i < arr.length; i += 16) out.push(arr.slice(i, i + 16)); return out; };
    const get = () => {
      const k = Math.floor(rnd() * 500); let checked = 0, bloomSkips = 0, found = false;
      if (st.mem.includes(k)) found = true;
      const runs = [...st.levels[0].slice().reverse(), ...st.levels.slice(1).flat()];
      for (const r of runs) {
        if (found) break;
        if (k < r[0] || k > r[r.length - 1]) continue; // key-range check from file metadata
        if (st.bloom && !r.includes(k) && rnd() > 0.01) { bloomSkips++; continue; } // bloom says no (1% FP)
        checked++; if (r.includes(k)) found = true;
      }
      st.lastRead = 'get(' + k + '): ' + (found ? 'found' : 'not found') + ' after reading ' + checked + ' SSTable(s)' + (st.bloom ? ', bloom filter skipped ' + bloomSkips : '');
      draw();
    };
    host.append(el('div', { class: 'row' }, el('button', { onclick: () => put(1) }, 'put 1 key'), el('button', { onclick: () => put(25) }, 'put 25'), el('button', { onclick: () => put(200) }, 'put 200'), el('button', { onclick: get }, 'get random key'), el('label', { class: 'muted' }, bloomCb, ' bloom filters'),
      el('button', { onclick: () => { st.mem = []; st.levels = [[], [], [], []]; st.inserted = 0; st.written = 0; st.lastRead = ''; draw(); } }, 'reset')), stats, view);
    function draw() {
      stats.innerHTML = '';
      const files = st.levels.flat().length;
      stats.append(stat('keys inserted', st.inserted), stat('keys written to disk', st.written), stat('write amplification', st.inserted ? (st.written / st.inserted).toFixed(2) + '×' : '–'), stat('SSTables', files));
      view.innerHTML = '';
      const box = (vals, color, title) => el('div', { title: title || vals.join(','), style: { display: 'inline-block', padding: '3px 6px', margin: '2px', borderRadius: '4px', border: '1px solid ' + color, fontFamily: 'var(--mono)', fontSize: '11px' } }, vals.length ? vals[0] + '…' + vals[vals.length - 1] + ' (' + vals.length + ')' : 'empty');
      view.append(el('div', { class: 'row' }, el('b', { style: { width: '120px' } }, 'memtable (RAM)'), st.mem.length ? st.mem.map((k) => el('span', { class: 'pill' }, k)) : el('span', { class: 'dim' }, 'empty'), el('span', { class: 'dim' }, '  flushes at ' + MEM)));
      st.levels.forEach((lv, i) => view.append(el('div', { class: 'row', style: { marginTop: '6px' } }, el('b', { style: { width: '120px' } }, 'L' + i + (i === 0 ? ' (overlapping)' : '')), lv.length ? lv.map((r) => box(r, OBS.PALETTE[i])) : el('span', { class: 'dim' }, '—'))));
      if (st.lastRead) view.append(el('div', { class: 'hint' }, st.lastRead));
    }
    draw();
  });

  // ---------------------------------------------------------------- cache --
  add('cache', 'Cache hit ratio & Zipf', (host) => {
    host.append(el('h2', {}, 'Caching: hit ratio vs size under skewed access'),
      el('p', {}, 'Real access patterns are skewed (Zipf): a few keys get most traffic. A cache holding 1% of keys can serve most reads, and every extra % of hit ratio is load the database doesn\'t see. Going from 95% → 99% hit cuts DB load 5×. That is also why a cold or flushed cache (deploys, restarts, synchronized TTLs) can take a database down.'));
    const st = { s: 1.0, keys: 10000 };
    const plot = el('div', { class: 'panel' }), stats = el('div', { class: 'stat-row' });
    host.append(slider('Zipf skew s', 0.5, 1.5, 0.05, st.s, (v) => { st.s = v; draw(); }, (v) => v.toFixed(2), true), stats, plot,
      el('p', { class: 'muted' }, 'LRU evicts least-recently-used; LFU evicts least-frequently-used. Each point is a 20k-request simulation (recomputed when you release the slider). "DB load" assumes misses go to the DB.'));
    const memo = new Map();
    function zipfSampler(n, s, rnd) { const w = []; let tot = 0; for (let i = 1; i <= n; i++) { tot += 1 / Math.pow(i, s); w.push(tot); } return () => { const x = rnd() * tot; let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (w[m] < x) lo = m + 1; else hi = m; } return lo; }; }
    function simLRU(reqs, size) { const m = new Map(); let hit = 0; for (const k of reqs) { if (m.has(k)) { hit++; m.delete(k); m.set(k, 1); } else { m.set(k, 1); if (m.size > size) m.delete(m.keys().next().value); } } return hit / reqs.length; }
    // O(1) LFU: frequency buckets (freq -> insertion-ordered Set) + min frequency
    function simLFU(reqs, size) {
      const freq = new Map(), buckets = new Map(); let minF = 0, hit = 0;
      const touch = (k) => { const f = freq.get(k); buckets.get(f).delete(k); if (!buckets.get(f).size) { buckets.delete(f); if (minF === f) minF = f + 1; } freq.set(k, f + 1); if (!buckets.has(f + 1)) buckets.set(f + 1, new Set()); buckets.get(f + 1).add(k); };
      for (const k of reqs) {
        if (freq.has(k)) { hit++; touch(k); continue; }
        if (freq.size >= size) { const b = buckets.get(minF); const victim = b.values().next().value; b.delete(victim); if (!b.size) buckets.delete(minF); freq.delete(victim); }
        freq.set(k, 1); if (!buckets.has(1)) buckets.set(1, new Set()); buckets.get(1).add(k); minF = 1;
      }
      return hit / reqs.length;
    }
    function draw() {
      const key = st.s.toFixed(2);
      if (!memo.has(key)) {
        const rnd = seeded(11); const z = zipfSampler(st.keys, st.s, rnd); const reqs = Array.from({ length: 20000 }, z);
        const sizes = [10, 25, 50, 100, 200, 400, 800, 1600, 3200];
        memo.set(key, { lru: sizes.map((sz) => [100 * sz / st.keys, 100 * simLRU(reqs, sz)]), lfu: sizes.map((sz) => [100 * sz / st.keys, 100 * simLFU(reqs, sz)]) });
      }
      const { lru, lfu } = memo.get(key);
      stats.innerHTML = ''; stats.append(stat('LRU @1% size', lru[3][1].toFixed(1) + '%'), stat('DB load vs no cache', (100 - lru[3][1]).toFixed(1) + '%'), stat('LRU @8% size', lru[6][1].toFixed(1) + '%'));
      OBS.svgPlot(plot, [{ label: 'LRU', points: lru }, { label: 'LFU', points: lfu, color: '#3fcf8e', dash: '5 4' }], { xLabel: 'cache size (% of keyspace)', yLabel: 'hit ratio', yMax: 100, height: 280, yFmt: (v) => v + '%', xFmt: (v) => v + '%' });
    }
    draw();
  });

  // ------------------------------------------------------------ isolation --
  const ANOM = {
    'dirty read': { desc: 'T2 reads data T1 wrote but has not committed. If T1 rolls back, T2 acted on data that never existed.', sched: ['T1: UPDATE acct SET bal = 0 WHERE id=1', 'T2: SELECT bal FROM acct WHERE id=1  → 0  (uncommitted!)', 'T1: ROLLBACK'], allowed: ['read uncommitted'] },
    'non-repeatable read': { desc: 'T1 reads a row twice and gets different values because T2 committed an update in between.', sched: ['T1: SELECT bal WHERE id=1 → 100', 'T2: UPDATE bal = 50 WHERE id=1; COMMIT', 'T1: SELECT bal WHERE id=1 → 50'], allowed: ['read uncommitted', 'read committed'] },
    'phantom': { desc: 'T1 runs a range query twice. T2 inserts a row matching the range in between, so a "phantom" row appears.', sched: ['T1: SELECT count(*) FROM orders WHERE day=today → 7', 'T2: INSERT INTO orders (day) VALUES (today); COMMIT', 'T1: SELECT count(*) ... → 8'], allowed: ['read uncommitted', 'read committed', 'repeatable read*'] },
    'lost update': { desc: 'Two read-modify-write cycles interleave. One increment overwrites the other.', sched: ['T1: SELECT counter → 10', 'T2: SELECT counter → 10', 'T1: UPDATE counter = 11; COMMIT', 'T2: UPDATE counter = 11; COMMIT   (one increment lost)'], allowed: ['read uncommitted', 'read committed'], fix: 'Use atomic UPDATE counter = counter + 1, SELECT … FOR UPDATE, or compare-and-set.' },
    'write skew': { desc: 'Two transactions read an overlapping set, each decides based on it, and write *different* rows. Each is fine alone; together they violate an invariant. Example: at least one doctor must be on call.', sched: ['T1: SELECT count(*) WHERE on_call → 2', 'T2: SELECT count(*) WHERE on_call → 2', 'T1: UPDATE doctors SET on_call=false WHERE name=\'alice\'; COMMIT', 'T2: UPDATE doctors SET on_call=false WHERE name=\'bob\'; COMMIT  → 0 on call!'], allowed: ['read uncommitted', 'read committed', 'repeatable read', 'snapshot isolation'], fix: 'SERIALIZABLE (Postgres SSI), or SELECT … FOR UPDATE on the rows read, or materialize the conflict.' },
  };
  const LEVELS = ['read uncommitted', 'read committed', 'repeatable read', 'snapshot isolation', 'serializable'];
  add('isolation', 'Transaction isolation anomalies', (host) => {
    host.append(el('h2', {}, 'Isolation levels: which anomalies can happen?'),
      el('p', {}, 'Isolation levels are defined by which concurrency anomalies they allow. Defaults matter: Postgres and Oracle default to READ COMMITTED, and MySQL InnoDB to REPEATABLE READ. Many "impossible" production bugs (double-spends, oversold inventory) are lost updates or write skew under a default level. Click a cell.'));
    const tb = el('table', { class: 'tbl', style: { maxWidth: '900px' } });
    tb.append(el('tr', {}, el('th', {}, 'anomaly \\ level'), LEVELS.map((l) => el('th', {}, l))));
    const detail = el('div', { class: 'panel', style: { marginTop: '12px', maxWidth: '900px' } }, el('span', { class: 'muted' }, 'Click any cell to see an example schedule.'));
    for (const [name, a] of Object.entries(ANOM)) {
      tb.append(el('tr', {}, el('td', { style: { fontFamily: 'var(--sans)' } }, name), LEVELS.map((l) => {
        const may = a.allowed.some((x) => x.replace('*', '') === l); const star = a.allowed.includes(l + '*');
        return el('td', { class: 'clickable ' + (may ? 'err' : 'okc'), style: { cursor: 'pointer' }, onclick: () => show(name, l, may, star) }, may ? (star ? 'possible*' : 'possible') : 'prevented');
      })));
    }
    function show(name, lvl, may, star) {
      const a = ANOM[name]; detail.innerHTML = '';
      detail.append(el('h3', {}, name + ' @ ' + lvl + ': ' + (may ? 'CAN happen' : 'prevented')), el('p', {}, a.desc), el('div', { class: 'mono' }, a.sched.map((s, i) => el('div', { style: { padding: '3px 0', paddingLeft: s.startsWith('T2') ? '40px' : '0', color: s.startsWith('T2') ? '#f5a524' : '#4e9cff' } }, (i + 1) + '. ' + s))),
        star ? el('p', { class: 'muted' }, '* The SQL standard allows phantoms under REPEATABLE READ, but Postgres (snapshot-based) and InnoDB (next-key locks) prevent most of them.') : '',
        a.fix ? el('div', { class: 'callout' }, el('b', {}, 'Fix: '), a.fix) : '');
    }
    host.append(tb, detail);
  });

  // ------------------------------------------------------- back of envelope --
  add('envelope', 'Back-of-envelope estimator', (host) => {
    host.append(el('h2', {}, 'Back-of-the-envelope capacity estimation'),
      el('p', {}, 'Interviewers (and design reviews) expect you to size things in two minutes: requests/s, storage, bandwidth, machines. Rules of thumb: a day ≈ 10⁵ s (86,400). Peak ≈ 2–5× average. One commodity server handles ~1–10k simple req/s, and an SSD does ~10⁴–10⁵ IOPS.'));
    const st = { dau: 50e6, actions: 20, readRatio: 10, size: 2000, retentionY: 5, repl: 3, peak: 3 };
    const out = el('div', { class: 'stat-row' });
    const fields = [['daily active users', 'dau', 1e5, 1e9, 1e5, (v) => fmt.num(v)], ['writes per user per day', 'actions', 1, 200, 1], ['reads per write', 'readRatio', 1, 200, 1], ['bytes per write', 'size', 100, 1e6, 100, (v) => fmt.bytes(v)], ['retention (years)', 'retentionY', 1, 10, 1], ['replication factor', 'repl', 1, 5, 1], ['peak / average', 'peak', 1, 10, 0.5]];
    for (const [label, k, mn, mx, step, f] of fields) host.append(slider(label, mn, mx, step, st[k], (v) => { st[k] = v; draw(); }, f));
    host.append(out);
    const lat = el('div', { class: 'panel', style: { maxWidth: '700px' } }, el('h3', {}, 'Latency numbers every engineer should know (order of magnitude)'));
    const tb = el('table', { class: 'tbl' });
    for (const [k, v] of [['L1 cache reference', '1 ns'], ['branch mispredict', '3 ns'], ['main memory reference', '100 ns'], ['compress 1 KB (fast codec)', '2 µs'], ['read 1 MB sequentially from RAM', '10 µs'], ['SSD random read (4 KB)', '16–100 µs'], ['round trip within same datacenter', '0.5 ms'], ['read 1 MB sequentially from SSD', '50–200 µs'], ['disk seek (HDD)', '2–10 ms'], ['read 1 MB from HDD', '1–5 ms'], ['round trip US east ↔ west', '~60–70 ms'], ['round trip US ↔ Europe', '~80–150 ms'], ['TLS handshake (new connection)', '1–2 RTTs']]) tb.append(el('tr', {}, el('td', { style: { fontFamily: 'var(--sans)' } }, k), el('td', { class: 'num' }, v)));
    lat.append(tb); host.append(lat);
    function draw() {
      const wps = st.dau * st.actions / 86400, rps = wps * st.readRatio;
      const storage = st.dau * st.actions * st.size * 365 * st.retentionY * st.repl;
      out.innerHTML = '';
      out.append(stat('avg writes/s', fmt.num(wps)), stat('peak writes/s', fmt.num(wps * st.peak)), stat('avg reads/s', fmt.num(rps)), stat('peak reads/s', fmt.num(rps * st.peak)), stat('ingest bandwidth', fmt.bytes(wps * st.size) + '/s'), stat('egress (reads)', fmt.bytes(rps * st.size) + '/s'), stat('storage/day (raw)', fmt.bytes(st.dau * st.actions * st.size)), stat('total storage (×repl)', fmt.bytes(storage)), stat('servers @5k rps', Math.ceil((rps + wps) * st.peak / 5000)));
    }
    draw();
  });

  // ---------------------------------------------------------- rate limits --
  add('ratelimit', 'Rate limiting: token bucket', (host) => {
    host.append(el('h2', {}, 'Token bucket rate limiter'),
      el('p', {}, 'A bucket holds up to B tokens and refills at r tokens/s. Each request takes one token or is rejected (or queued). B allows bursts and r caps the sustained rate. Compare with a fixed-window counter, which lets 2× the limit through at window boundaries, and a sliding-window log, which is exact but costs memory per request.'));
    const st = { r: 10, B: 20, burst: 40 };
    const plot = el('div', { class: 'panel' }), stats = el('div', { class: 'stat-row' });
    host.append(slider('refill rate r (tokens/s)', 1, 50, 1, st.r, (v) => { st.r = v; draw(); }), slider('bucket size B', 1, 100, 1, st.B, (v) => { st.B = v; draw(); }), slider('client burst rate (req/s, t=5..15s)', 1, 100, 1, st.burst, (v) => { st.burst = v; draw(); }), stats, plot);
    function draw() {
      let tokens = st.B; const dt = 0.1; const tok = [], acc = [], offered = []; let accepted = 0, rejected = 0, accW = 0;
      for (let t = 0; t <= 30; t += dt) {
        tokens = Math.min(st.B, tokens + st.r * dt);
        const want = (t >= 5 && t < 15 ? st.burst : 4) * dt; let got = Math.min(want, tokens); tokens -= got; accepted += got; rejected += want - got;
        accW = accW * 0.9 + (got / dt) * 0.1;
        tok.push([t, tokens]); acc.push([t, accW]); offered.push([t, want / dt]);
      }
      stats.innerHTML = ''; stats.append(stat('accepted', Math.round(accepted)), stat('rejected', Math.round(rejected)), stat('max burst passed', Math.round(st.B + st.r) + ' in first second'));
      OBS.svgPlot(plot, [{ label: 'offered req/s', points: offered, color: '#94a3b8', dash: '4 4' }, { label: 'accepted req/s', points: acc, color: '#3fcf8e' }, { label: 'tokens in bucket', points: tok, color: '#f5a524' }], { xLabel: 'seconds', yLabel: 'rate / tokens', height: 280 });
    }
    draw();
  });

  // ================================================================ ML ====
  const GPUS = {
    H100: { name: 'H100 SXM', tflops: 989, bw: 3.35, mem: 80 },
    A100: { name: 'A100 SXM', tflops: 312, bw: 2.0, mem: 80 },
    L4: { name: 'L4', tflops: 121, bw: 0.3, mem: 24 },
  };
  function select(label, options, value, onChange) {
    const s = el('select', { onchange: () => onChange(s.value) }, ...Object.entries(options).map(([k, v]) => el('option', { value: k, selected: k === value }, v)));
    return el('div', { class: 'ctrl' }, el('label', {}, label), s, el('output', {}, ''));
  }
  const log10 = Math.log10, pow10 = (v) => Math.pow(10, v);
  const sci = (v) => { const x = pow10(v); return x >= 1000 ? fmt.num(x) : x >= 1 ? String(Math.round(x)) : x.toPrecision(1); };

  // ------------------------------------------------------------ roofline --
  add('roofline', 'ML · GPU roofline (compute vs memory bound)', (host) => {
    host.append(el('h2', {}, 'Roofline: is this kernel limited by FLOPs or by memory bandwidth?'),
      el('p', {}, 'A GPU can do P FLOP/s of math but only move B bytes/s from HBM. A kernel\'s ', el('b', {}, 'arithmetic intensity'), ' AI = FLOPs / bytes moved decides which limit it hits: attainable = min(P, AI × B). The crossover ("ridge") is P/B. That\'s ~295 FLOP/byte on an H100. Below it you are ', el('b', {}, 'memory-bound'), ' and faster math units don\'t help. Only moving fewer bytes (batching, fusion, quantization) does.'),
      el('div', { class: 'callout' }, el('b', {}, 'The LLM-serving punchline: '), 'decoding one token multiplies a (batch × d) activation by a (d × d) weight. The weights are read once per step no matter the batch, so AI ≈ batch size. At batch 1 an H100 runs at ~0.3% of peak. This is why inference servers batch aggressively, and why ', el('i', {}, 'prefill'), ' (thousands of tokens at once) is compute-bound while ', el('i', {}, 'decode'), ' is memory-bound.'));
    const st = { gpu: 'H100', M: 8, K: 8192, N: 8192, bytes: 2 };
    const stats = el('div', { class: 'stat-row' }), plot = el('div', { class: 'panel' });
    host.append(select('GPU', Object.fromEntries(Object.entries(GPUS).map(([k, g]) => [k, g.name + ' (' + g.tflops + ' TF, ' + g.bw + ' TB/s)'])), st.gpu, (v) => { st.gpu = v; draw(); }),
      slider('M = tokens in the batch (log)', 0, 4.2, 0.05, log10(st.M), (v) => { st.M = Math.round(pow10(v)); draw(); }, (v) => String(Math.round(pow10(v)))),
      slider('K = N = hidden size', 1024, 16384, 1024, st.K, (v) => { st.K = st.N = v; draw(); }),
      select('precision', { 2: 'bf16 (2 bytes)', 1: 'fp8 / int8 (1 byte, 2× FLOPs)' }, '2', (v) => { st.bytes = +v; draw(); }),
      stats, plot,
      el('p', { class: 'muted' }, 'Try it: M=1 (decode, batch 1) vs M=256 (decode, batch 256) vs M=4096 (prefill of a 4k prompt). Watch the dot climb the slanted memory roof until it hits the flat compute roof. Then switch to the L4: its ridge is much lower, so it becomes compute-bound sooner.'));
    function draw() {
      const g = GPUS[st.gpu], P = g.tflops * 1e12 * (st.bytes === 1 ? 2 : 1), B = g.bw * 1e12;
      const flops = 2 * st.M * st.K * st.N, bytes = st.bytes * (st.M * st.K + st.K * st.N + st.M * st.N);
      const ai = flops / bytes, att = Math.min(P, ai * B), t = flops / att;
      const ridge = P / B;
      stats.innerHTML = '';
      stats.append(stat('arithmetic intensity', ai.toFixed(1) + ' FLOP/B'), stat('ridge point', ridge.toFixed(0) + ' FLOP/B'), stat('bound by', ai < ridge ? 'memory bandwidth' : 'compute'),
        stat('attainable', (att / 1e12).toFixed(1) + ' TFLOP/s'), stat('% of peak', (100 * att / P).toFixed(1) + '%'), stat('kernel time', fmt.ms(t * 1000)));
      const roof = []; for (let x = -0.5; x <= 4; x += 0.02) roof.push([x, log10(Math.min(P, pow10(x) * B) / 1e12)]);
      OBS.svgPlot(plot, [{ label: 'roofline (attainable TFLOP/s)', points: roof, color: '#4e9cff' }],
        { xLabel: 'arithmetic intensity (FLOP/byte, log)', yLabel: 'TFLOP/s (log)', xMin: -0.5, xMax: 4, yMin: -0.5, yMax: log10(P / 1e12) + 0.3, xFmt: sci, yFmt: sci,
          markers: [[log10(ai), log10(att / 1e12), '#f2617a']], bands: [{ x0: -0.5, x1: log10(ridge), color: '#f5a524', opacity: 0.06 }], height: 320 });
    }
    draw();
  });

  // ---------------------------------------------------------- LLM serving --
  const MODELS = {
    '8b': { name: 'Llama-3-8B-like (GQA)', P: 8e9, L: 32, kv: 8, hd: 128 },
    '13b': { name: '13B (no GQA, MHA)', P: 13e9, L: 40, kv: 40, hd: 128 },
    '70b': { name: 'Llama-3-70B-like (GQA)', P: 70e9, L: 80, kv: 8, hd: 128 },
    '405b': { name: '405B (GQA)', P: 405e9, L: 126, kv: 8, hd: 128 },
  };
  add('llmserve', 'ML · LLM serving: KV cache, batching, TTFT/TPOT', (host) => {
    host.append(el('h2', {}, 'LLM serving calculator: where the memory and the time go'),
      el('p', {}, 'GPU memory holds ', el('b', {}, 'weights'), ' (params × bytes) plus the ', el('b', {}, 'KV cache'), ': for every token of every running request, each layer stores a key and a value vector. KV bytes per token = 2 × layers × kv_heads × head_dim × bytes. Free memory ÷ (KV per token × context) is how many requests can run at once.'),
      el('p', {}, el('b', {}, 'Decode'), ' (one token per step for every running request) is memory-bound: each step reads all weights plus every running request\'s KV. Bigger batch → much higher throughput, slightly slower tokens. ', el('b', {}, 'Prefill'), ' (the prompt) is compute-bound and sets time-to-first-token (TTFT).'));
    const st = { model: '70b', gpu: 'H100', tp: 8, wb: 2, ctx: 4096, batch: 64 };
    const stats = el('div', { class: 'stat-row' }), plot = el('div', { class: 'panel' }), plot2 = el('div', { class: 'panel' });
    host.append(select('model', Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, m.name])), st.model, (v) => { st.model = v; draw(); }),
      select('GPU', Object.fromEntries(Object.entries(GPUS).map(([k, g]) => [k, g.name])), st.gpu, (v) => { st.gpu = v; draw(); }),
      slider('GPUs (tensor parallel)', 1, 16, 1, st.tp, (v) => { st.tp = v; draw(); }),
      select('weights / KV precision', { 2: 'bf16', 1: 'fp8' }, '2', (v) => { st.wb = +v; draw(); }),
      slider('avg context per request (prompt + output)', 256, 131072, 256, st.ctx, (v) => { st.ctx = v; draw(); }, (v) => fmt.num(v) + ' tok', true),
      slider('running batch (concurrent requests)', 1, 512, 1, st.batch, (v) => { st.batch = v; draw(); }),
      stats, plot, plot2,
      el('p', { class: 'muted' }, 'Try it: 70B on 8×H100, context 4k: lots of headroom. Now raise context to 32k: max batch collapses, so throughput collapses too (scenario 008). Switch to the 13B MHA model: no grouped-query attention means ~2.5× more KV per token than the 70B, despite being 5× smaller! Try fp8 to see how quantization buys both memory and speed. Numbers are idealized (~80% of bandwidth, 50% MFU for prefill).'));
    function draw() {
      const m = MODELS[st.model], g = GPUS[st.gpu];
      const wBytes = m.P * st.wb, mem = st.tp * g.mem * 1e9 * 0.9;
      const kvTok = 2 * m.L * m.kv * m.hd * st.wb;
      const kvCapTok = Math.max(0, (mem - wBytes) / kvTok);
      const maxBatch = Math.floor(kvCapTok / st.ctx);
      const BW = st.tp * g.bw * 1e12 * 0.8, PEAK = st.tp * g.tflops * 1e12 * (st.wb === 1 ? 2 : 1) * 0.5;
      const stepT = (b) => (wBytes + b * st.ctx * 0.5 * kvTok) / BW + 0.004 * (st.tp > 1 ? 1 : 0.5); // avg request is halfway through its context
      const b = Math.min(st.batch, Math.max(maxBatch, 0));
      const prompt = st.ctx * 0.75, ttft = 2 * m.P * prompt / PEAK;
      stats.innerHTML = '';
      const fits = wBytes < mem;
      stats.append(stat('weights', fmt.bytes(wBytes)), stat('KV per token', fmt.bytes(kvTok)), stat('KV per request', fmt.bytes(kvTok * st.ctx)),
        stat('KV pool', fits ? fmt.num(kvCapTok) + ' tokens' : 'weights don\'t fit!'), stat('max concurrent requests', fits ? String(maxBatch) : '0'),
        stat('TPOT at batch ' + b, b > 0 ? fmt.ms(stepT(b) * 1000) : '–'), stat('throughput', b > 0 ? fmt.num(b / stepT(b)) + ' tok/s' : '–'), stat('TTFT (prefill ' + fmt.num(prompt) + ' tok)', fmt.ms(ttft * 1000)));
      if (st.batch > maxBatch && fits) stats.append(stat('⚠ batch ' + st.batch, 'exceeds KV → queueing/preemption'));
      if (!fits || maxBatch < 1) { plot.innerHTML = '<p class="muted">Model + one request do not fit in memory. Add GPUs or quantize.</p>'; plot2.innerHTML = ''; return; }
      const thr = [], tp = [], lim = Math.max(2, Math.min(512, maxBatch));
      for (let x = 1; x <= lim; x += Math.max(1, Math.floor(lim / 120))) { thr.push([x, x / stepT(x)]); tp.push([x, stepT(x) * 1000]); }
      OBS.svgPlot(plot, [{ label: 'decode throughput (tokens/s)', points: thr, color: '#3fcf8e' }], { xLabel: 'running batch (up to the KV limit)', yLabel: 'tokens/s', yFmt: fmt.num, markers: [[b, b / stepT(b)]], height: 240 });
      OBS.svgPlot(plot2, [{ label: 'time per output token (ms)', points: tp, color: '#f5a524' }], { xLabel: 'running batch', yLabel: 'TPOT (ms)', yMin: 0, markers: [[b, stepT(b) * 1000]], height: 200 });
    }
    draw();
  });

  // ------------------------------------------------- distributed training --
  add('training', 'ML · Distributed training: step time & scaling', (host) => {
    host.append(el('h2', {}, 'Data-parallel training: compute, all-reduce, overlap and stragglers'),
      el('p', {}, 'Training FLOPs ≈ ', el('b', {}, '6 × params × tokens'), ' (2 forward + 4 backward). With data parallelism, every GPU computes on its own tokens, then all GPUs ', el('b', {}, 'all-reduce'), ' gradients. A ring all-reduce sends ≈ 2·(N−1)/N × gradient bytes per GPU. That\'s roughly constant in N, so bandwidth cost doesn\'t grow, but the latency term (2(N−1) hops) does. Comm overlapped with backward is free. Only the part that sticks out ("exposed") adds to step time.'),
      el('div', { class: 'callout' }, el('b', {}, 'Synchronous = slowest wins. '), 'Each step waits for the slowest GPU. If per-GPU step time jitters with coefficient of variation σ, the expected max over N GPUs grows like σ·√(2 ln N). At 1,000s of GPUs, small jitter (or one throttled GPU, or one bad link: scenario 007) taxes everyone.'));
    const st = { P: 13, N: 128, tok: 32768, bw: 50, ovl: 70, cv: 2, mfu: 45 };
    const stats = el('div', { class: 'stat-row' }), plot = el('div', { class: 'panel' });
    host.append(slider('model params (B)', 1, 200, 1, st.P, (v) => { st.P = v; draw(); }, (v) => v + 'B'),
      slider('GPUs N (log)', 0, 4, 0.05, log10(st.N), (v) => { st.N = Math.round(pow10(v)); draw(); }, (v) => String(Math.round(pow10(v)))),
      slider('tokens per GPU per step', 2048, 262144, 2048, st.tok, (v) => { st.tok = v; draw(); }, fmt.num),
      slider('network bandwidth per GPU (GB/s)', 5, 100, 5, st.bw, (v) => { st.bw = v; draw(); }, (v) => v + ' GB/s (' + v * 8 + ' Gb/s)'),
      slider('% of comm overlappable with backward', 0, 100, 5, st.ovl, (v) => { st.ovl = v; draw(); }, (v) => v + '%'),
      slider('per-GPU step-time jitter σ', 0, 15, 0.5, st.cv, (v) => { st.cv = v; draw(); }, (v) => v + '%'),
      stats, plot,
      el('p', { class: 'muted' }, 'Try it: drop bandwidth from 50 to 12 GB/s (a 400→100 Gb/s link, as in scenario 007) and watch exposed comm appear. Cut tokens per GPU (smaller batch) and comm takes a bigger share. Raise jitter to 5% at 4,096 GPUs to see the straggler tax. Memory: plain DP needs ~16 bytes/param on every GPU (bf16 weights+grads, fp32 Adam states + master weights). FSDP/ZeRO-3 shards that across N.'));
    function model(N) {
      const H = GPUS.H100, Pp = st.P * 1e9;
      const compute = 6 * Pp * st.tok / (H.tflops * 1e12 * st.mfu / 100);
      const bwd = compute * 2 / 3;
      const comm = N > 1 ? (2 * (N - 1) / N) * Pp * 2 / (st.bw * 1e9) + 2 * (N - 1) * 8e-6 : 0;
      const exposed = Math.max(0, comm - bwd * st.ovl / 100);
      const straggle = compute * (st.cv / 100) * Math.sqrt(2 * Math.log(Math.max(2, N)));
      const step = compute + straggle + exposed;
      return { compute, comm, exposed, straggle, step, eff: compute / step };
    }
    function draw() {
      const r = model(st.N), Pp = st.P * 1e9;
      stats.innerHTML = '';
      stats.append(stat('compute / step', fmt.ms(r.compute * 1000)), stat('all-reduce', fmt.ms(r.comm * 1000)), stat('exposed comm', fmt.ms(r.exposed * 1000)), stat('straggler tax', fmt.ms(r.straggle * 1000)),
        stat('step time', fmt.ms(r.step * 1000)), stat('scaling efficiency', (100 * r.eff).toFixed(0) + '%'), stat('cluster tokens/s', fmt.num(st.N * st.tok / r.step)),
        stat('memory/GPU: DP vs FSDP', fmt.bytes(16 * Pp) + ' vs ' + fmt.bytes(16 * Pp / st.N)));
      const e = [], ex = [], sg = [];
      for (let x = 0; x <= 4.01; x += 0.05) { const n = Math.max(1, Math.round(pow10(x))), m = model(n); e.push([x, 100 * m.eff]); ex.push([x, 100 * m.exposed / m.step]); sg.push([x, 100 * m.straggle / m.step]); }
      OBS.svgPlot(plot, [{ label: 'scaling efficiency', points: e, color: '#3fcf8e' }, { label: 'exposed comm share', points: ex, color: '#f2617a' }, { label: 'straggler share', points: sg, color: '#f5a524' }],
        { xLabel: 'GPUs (log)', xMin: 0, xMax: 4, xFmt: sci, yLabel: '% of step', yMax: 100, yFmt: (v) => v + '%', markers: [[log10(st.N), 100 * r.eff]], height: 280 });
    }
    draw();
  });

  // ----------------------------------------------------------------- boot --
  window.addEventListener('DOMContentLoaded', () => {
    const nav = document.getElementById('nav'), body = document.getElementById('body');
    for (const w of LAB) nav.append(el('a', { href: '#' + w.id, 'data-id': w.id }, w.title));
    function route() {
      const id = (location.hash || '#' + LAB[0].id).slice(1);
      const w = LAB.find((x) => x.id === id) || LAB[0];
      for (const a of nav.children) a.classList.toggle('active', a.dataset.id === w.id);
      body.innerHTML = ''; w.render(body);
      document.title = w.title + ' — Concepts Lab';
    }
    window.addEventListener('hashchange', route); route();
  });
})();
