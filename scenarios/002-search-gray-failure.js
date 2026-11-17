/* Scenario 002 — Search p99 tripled; nothing is "down".
 * Answer key: answers/scenarios/002-search-gray-failure.md  (don't peek!) */
OBS.register((function () {
  const SHARDS = 8, BAD = 5, T_ON = 1500;
  const NODES = { 1: 'node-03', 2: 'node-08', 3: 'node-11', 4: 'node-12', 5: 'node-17', 6: 'node-21', 7: 'node-22', 8: 'node-30' };
  const traffic = (t) => 640 + 60 * Math.sin((2 * Math.PI * (t + 400)) / 3600);
  const steal = (t, i) => (i === BAD ? 1 + 34 * Math.min(1, Math.max(0, (t - T_ON) / 60)) * (1 + 0.15 * Math.sin(t / 37)) : 0.8);
  const merge = (t, i) => (i === 3 ? Math.exp(-0.5 * ((t - 2650) / 40) ** 2) : 0);   // short segment merge on shard-3
  const p50 = (t, i) => (i === 2 ? 5.2 : 4.1) * (1 + steal(t, i) / 9) * (1 + merge(t, i) * 2);
  const p99 = (t, i) => (i === 2 ? 31 : 24) + Math.max(0, steal(t, i) - 1) * 12.5 + merge(t, i) * 160;
  const sigma = (t, i) => Math.log(p99(t, i) / p50(t, i)) / 2.33;
  // Approximate p-quantiles of max over shards by sampling deterministic grid of percentiles
  const fanQuantile = (t, q) => { // P(max <= x) = prod_i F_i(x); bisection on x
    const F = (x) => { let p = 1; for (let i = 1; i <= SHARDS; i++) { const z = (Math.log(x / p50(t, i))) / sigma(t, i); p *= 0.5 * (1 + erf(z / Math.SQRT2)); } return p; };
    let lo = 0.5, hi = 5000; for (let k = 0; k < 40; k++) { const m = Math.sqrt(lo * hi); if (F(m) < q) lo = m; else hi = m; } return hi;
  };
  function erf(x) { const s = Math.sign(x); x = Math.abs(x); const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911; const t = 1 / (1 + p * x); return s * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)); }

  return {
    id: '002-search-gray-failure',
    title: 'Search got slow, but every health check is green',
    difficulty: 'medium',
    tags: ['gray failure', 'tail latency', 'fan-out', 'noisy neighbor', 'cpu steal', 'heatmap'],
    startTime: '2026-11-17T16:00:00Z',
    duration: 3600, step: 10, seed: 202,
    brief: {
      severity: 'SEV-3',
      alert: 'SearchLatencySLO: /search p99 > 200ms (SLO burn rate 14x)',
      firedAt: 1680,
      summary: `<p><b>Findly</b> runs product search. Starting mid-afternoon, <code>/search</code> p99 went from ~50 ms to ~400–500 ms. p50 barely moved. There are no errors, no pods are crash-looping, and every health check is green. The frontend team shipped a deploy earlier and is getting blamed.</p>`,
      task: '<p>Find the cause of the tail latency, explain <b>why one component\'s problem shows up in every request</b>, and propose both a fix for right now and a design change so this class of problem hurts less next time.</p>',
      questions: [
        'Which component is responsible? How did you isolate it?',
        'Why didn\'t health checks or error-rate alerts catch it?',
        'Why does overall p99 look like one component\'s p99 even though it\'s 1 of 8?',
        'What is the underlying cause on that component (not just "it\'s slow")?',
        'Immediate mitigation? Architectural changes to make the system tolerant of a slow node?',
      ],
    },
    architecture: `<ul>
      <li><b>web</b>: frontend. Calls <b>search-agg</b> (3 pods).</li>
      <li><b>search-agg</b> does <b>scatter-gather</b>: every query fans out to <b>all 8 index shards in parallel</b>, waits for all of them (timeout 2s), merges, and returns.</li>
      <li><b>search-shard</b>: 8 shards, one pod each, on dedicated VMs. Each shard holds 1/8 of the index.</li>
      <li>Shard → VM placement: ${Object.entries(NODES).map(([k, v]) => 'shard-' + k + ' → ' + v).join(', ')}.</li>
      <li>Health check: <code>GET /healthz</code> every 5s; returns 200 if the process is up and the index is loaded.</li></ul>`,
    hints: [
      'Averages hide outliers. Use the <b>Heatmap</b> on a per-shard metric. Is there one row that\'s different?',
      'Open a slow trace: the shard calls are parallel. Which child bar is the long one? Is it the same shard across slow traces?',
      'The slow shard\'s CPU <i>utilization</i> isn\'t extreme, but look at <b>every</b> metric it reports, then check the event log for anything about its VM.',
    ],
    topology: {
      nodes: [
        { id: 'users', kind: 'client', x: 0, y: 50 },
        { id: 'web', kind: 'service', x: 18, y: 50, health: 'web:latency_p99', thresholds: [250, 600] },
        { id: 'search-agg', kind: 'service', x: 42, y: 50, health: 'search-agg:latency_p99', thresholds: [200, 400], desc: 'scatter-gather aggregator, 3 pods' },
        { id: 'search-shard', kind: 'service', x: 75, y: 50, health: 'search-shard:healthy_shards', thresholds: [7.5, 6.5], invert: true, desc: '8 shards, 1 pod each; health = shards passing /healthz' },
        { id: 'infra', kind: 'storage', x: 75, y: 92, desc: 'VM fleet (hypervisor-level metrics)' },
      ],
      edges: [
        { from: 'users', to: 'web', metric: 'web:rps' },
        { from: 'web', to: 'search-agg', metric: 'search-agg:rps' },
        { from: 'search-agg', to: 'search-shard', label: 'fan-out ×8' },
      ],
    },
    metrics: [
      { entity: 'web', name: 'rps', unit: 'req/s', fn: (t, h) => traffic(t) * 1.6 + h.noise(20) },
      { entity: 'web', name: 'latency_p99', unit: 'ms', fn: (t, h) => 70 + fanQuantile(t, 0.99) * 1.05 + h.noise(8) + (t > 900 && t < 960 ? 40 : 0) },
      { entity: 'web', name: 'error_rate', unit: '%', fn: (t, h) => 0.05 + Math.abs(h.noise(0.04)) },
      { entity: 'search-agg', name: 'rps', unit: 'req/s', fn: (t, h) => traffic(t) + h.noise(12) },
      { entity: 'search-agg', name: 'latency_p50', unit: 'ms', fn: (t, h) => 3 + fanQuantile(t, 0.5) * (1 + h.noise(0.05)) },
      { entity: 'search-agg', name: 'latency_p99', unit: 'ms', fn: (t, h) => 4 + fanQuantile(t, 0.99) * (1 + h.noise(0.06)) },
      { entity: 'search-agg', name: 'shard_timeouts', unit: '/s', desc: 'shard calls exceeding the 2s timeout', fn: (t, h) => Math.abs(h.noise(0.02)) },
      { entity: 'search-agg/pod-{i}', instances: 3, name: 'cpu', unit: '%', fn: (t, h, i) => 31 + traffic(t) * 0.01 + h.noise(3) },
      { entity: 'search-agg/pod-{i}', instances: 3, name: 'gc_pause_ms', unit: 'ms', fn: (t, h, i) => 9 + h.noise(3) + (h.saw(t, 420, i * 140) > 0.97 ? 120 : 0) },
      { entity: 'search-shard/shard-{i}', instances: SHARDS, name: 'latency_p50', unit: 'ms', fn: (t, h, i) => p50(t, i) * (1 + h.noise(0.06)) },
      { entity: 'search-shard/shard-{i}', instances: SHARDS, name: 'latency_p99', unit: 'ms', fn: (t, h, i) => p99(t, i) * (1 + h.noise(0.08)) },
      { entity: 'search-shard/shard-{i}', instances: SHARDS, name: 'qps', unit: 'q/s', desc: 'every query hits every shard', fn: (t, h, i) => traffic(t) * (1 + h.noise(0.02)) },
      { entity: 'search-shard/shard-{i}', instances: SHARDS, name: 'cpu', unit: '%', desc: 'CPU utilization as seen by the guest', fn: (t, h, i) => (i === 2 ? 46 : 41) + traffic(t) * 0.008 + (i === BAD ? steal(t, i) * 0.7 : 0) + merge(t, i) * 30 + h.noise(3) },
      { entity: 'search-shard/shard-{i}', instances: SHARDS, name: 'cpu_steal', unit: '%', desc: 'time the hypervisor ran other tenants while this VM wanted CPU', fn: (t, h, i) => steal(t, i) * (1 + h.noise(0.1)) },
      { entity: 'search-shard/shard-{i}', instances: SHARDS, name: 'disk_read_ms', unit: 'ms', fn: (t, h, i) => 0.4 + Math.abs(h.noise(0.1)) + merge(t, i) * 6 },
      { entity: 'search-shard/shard-{i}', instances: SHARDS, name: 'heap_used', unit: '%', fn: (t, h, i) => 55 + 15 * h.saw(t, 900 + i * 37, i * 100) + h.noise(1) },
      { entity: 'search-shard', name: 'healthy_shards', unit: '', desc: 'shards passing /healthz', fn: () => 8 },
    ],
    dashboards: [
      { title: 'Search SLO', charts: [
        { title: 'Aggregator latency', series: ['search-agg:latency_p50', 'search-agg:latency_p99'], threshold: 200 },
        { title: 'Web latency p99', series: ['web:latency_p99'] },
        { title: 'Traffic', series: ['search-agg:rps'] },
        { title: 'Errors', series: ['web:error_rate'] },
        { title: 'Shard CPU (avg view)', series: ['search-shard/*:cpu'] },
        { title: 'Healthy shards', series: ['search-shard:healthy_shards'] },
      ] },
    ],
    events: [
      { t: 900, kind: 'deploy', entity: 'web', msg: 'web v8.40.1: new results-page CSS bundle + image lazy-loading' },
      { t: T_ON - 8, kind: 'info', entity: 'infra', msg: 'cloud provider maintenance notice: host h-2291 (VMs: node-17, node-41, node-44) live-migrated to h-3310' },
      { t: 1680, kind: 'alert', entity: 'search-agg', msg: 'SearchLatencySLO fired' },
      { t: 2600, kind: 'cron', entity: 'search-shard', msg: 'shard-3: scheduled index segment merge' },
    ],
    logs: [
      { entity: (t, h) => 'search-shard/shard-' + h.int(1, 8), level: 'INFO', rate: 0.8, msg: (t, h) => 'GET /healthz 200 ' + h.int(1, 4) + 'ms' },
      { entity: (t, h) => 'search-agg/pod-' + h.int(1, 3), level: 'INFO', rate: 1.2, msg: (t, h) => 'q="' + h.pick(['running shoes', 'usb-c cable', 'desk lamp', 'yoga mat', 'coffee grinder', 'headphones']) + '" shards=8/8 hits=' + h.int(10, 4000) + ' took=' + Math.round(fanQuantile(t, h.rand())) + 'ms' },
      { entity: (t, h) => 'search-agg/pod-' + h.int(1, 3), level: 'WARN', rate: (t) => (t > T_ON + 30 ? 0.35 : 0.004), msg: (t, h) => { const s = t > T_ON + 30 ? BAD : h.int(1, 8); return 'slow shard response shard=' + s + ' took=' + h.int(260, 900) + 'ms (threshold 250ms)'; } },
      { entity: 'search-agg/pod-1', level: 'WARN', rate: (t) => (t > 2620 && t < 2690 ? 0.2 : 0), msg: (t, h) => 'slow shard response shard=3 took=' + h.int(250, 330) + 'ms (threshold 250ms)' },
      { entity: (t, h) => 'search-agg/pod-' + h.int(1, 3), level: 'INFO', rate: 1 / 140, msg: (t, h) => 'G1 Young Generation pause ' + h.int(80, 140) + 'ms' },
      { entity: 'search-shard/shard-3', level: 'INFO', t: 2605, msg: 'segment merge started: 14 segments -> 1 (2.1 GiB)' },
      { entity: 'search-shard/shard-3', level: 'INFO', t: 2700, msg: 'segment merge finished in 95s' },
      { entity: 'web', level: 'INFO', t: 905, msg: 'web v8.40.1 serving; assets hash 9f3ac1' },
      { entity: 'web', level: 'WARN', rate: 0.01, msg: 'client reported slow LCP > 4s' },
      { entity: 'infra', level: 'WARN', rate: (t) => (t > T_ON ? 1 / 120 : 0), msg: 'node-exporter node-17: cpu steal above 20% for 2m' },
    ],
    traces: [
      { name: 'GET /search', rate: 0.22, fn: (t, h) => {
        const shards = Array.from({ length: SHARDS }, (_, k) => { const i = k + 1; const d = h.lognormal(p50(t, i), sigma(t, i)); return h.span('search-shard', 'shard-' + i + ' query', d, [], { tags: { shard: i, node: NODES[i] } }); });
        return h.span('web', 'GET /search', 2, [
          h.span('search-agg', 'scatter-gather', 1.5, [
            h.span('search-agg', 'fan-out (wait for all 8)', 0.2, shards, { parallel: true }),
            h.span('search-agg', 'merge+rank', h.lognormal(2.5, 0.3)),
          ], { tags: { pod: 'pod-' + h.int(1, 3) } }),
          h.span('web', 'render', h.lognormal(8, 0.3)),
        ]);
      } },
    ],
  };
})());
