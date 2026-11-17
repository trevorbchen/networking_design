/* Scenario 000 — TUTORIAL. Intermittent 502s from the image resizer.
 * Answer key: answers/scenarios/000-tutorial-oom.md  (don't peek!) */
OBS.register((function () {
  const MiB = 1048576;
  const PODS = 4, T_DEPLOY = 600, LIMIT = 1536, BASE = 380, RESTART = 22;
  const leak = (i) => 1.15 + 0.17 * i;                 // MiB/s retained per pod (differs with traffic mix)
  const begin = (i) => T_DEPLOY + (i - 1) * 45;         // rolling deploy, one pod every 45s
  const period = (i) => (LIMIT - BASE) / leak(i) + RESTART;
  const since = (t, i) => (t < begin(i) ? null : (t - begin(i)) % period(i));   // seconds since (re)start
  const restarts = (t, i) => (t < begin(i) ? 0 : Math.floor((t - begin(i)) / period(i)));
  const oomTimes = [];
  for (let i = 1; i <= PODS; i++) for (let t = begin(i) + period(i) - RESTART; t < 3600; t += period(i)) oomTimes.push({ t, i });
  oomTimes.sort((a, b) => a.t - b.t);
  const down = (t, i) => { const s = since(t, i); return s != null && s > period(i) - RESTART; };  // pod restarting
  const nearOom = (t, w) => oomTimes.filter((o) => t >= o.t && t < o.t + w);
  const traffic = (t) => 420 + 40 * Math.sin((2 * Math.PI * t) / 3000);

  return {
    id: '000-tutorial-oom',
    title: 'Tutorial: intermittent 502s from the image resizer',
    difficulty: 'easy',
    tags: ['tutorial', 'memory leak', 'OOMKill', 'kubernetes', 'sawtooth'],
    startTime: '2026-11-17T14:00:00Z',
    duration: 3600, step: 10, seed: 7,
    brief: {
      severity: 'SEV-3',
      alert: 'LB502RateHigh: 5xx from resizer pool above 1 req/s (flapping)',
      firedAt: oomTimes[0].t + 8,
      summary: `<p>You are on-call for <b>Pixel</b>, an image service. Users upload a photo and the <code>resizer</code> service produces thumbnails. Customers report that roughly once every few minutes an upload fails with <b>502 Bad Gateway</b>, then retrying works.</p>
        <p>This is the <b>tutorial</b>. It walks you through the tools:</p>
        <ol>
          <li><b>Service Map</b>: see the components; press ▶ play to watch health change over time.</li>
          <li><b>Metrics</b>: the "Resizer overview" dashboard is preloaded. Look at the <i>shape</i> of each line. Click metrics in the left tree to add your own charts.</li>
          <li><b>Heatmap</b>: pick <code>memory</code> to see all 4 pods side by side.</li>
          <li><b>Logs</b>: try the search box, the level filters, and "group into patterns".</li>
          <li><b>Traces</b>: filter "errors only" to see what a failing request looks like.</li>
          <li><b>Report</b>: write your conclusion, then Copy as Markdown and paste it to Claude.</li>
        </ol>`,
      task: '<p>Explain <b>why</b> uploads intermittently fail, what <b>triggered</b> it, and what you would do now vs. long-term. Pin at least two pieces of evidence (hover a chart, press <kbd>p</kbd>).</p>',
      questions: [
        'What is the pattern in resizer memory, and when did it start?',
        'What kills the pods, and how do you know?',
        'Why does a pod dying cause user-visible 502s rather than a transparent retry?',
        'What is the immediate mitigation, and what is the real fix?',
        'What alert would have caught this before users noticed?',
      ],
    },
    architecture: `<ul><li><b>lb</b>: L7 load balancer, round-robin to resizer pods, no retries on POST.</li>
      <li><b>resizer</b>: Java service, 4 pods, each with a 1.5 GiB memory limit. Fetches originals from object storage, resizes, writes thumbnails back.</li>
      <li><b>blobstore</b>: S3-compatible object storage (managed, external).</li></ul>`,
    hints: [
      'Open the Heatmap tab and choose <code>memory</code>. Is memory stable over time, or does it do something repetitive? When did that pattern begin?',
      'In Logs, search for <code>OOM</code>, then compare the timestamps with the spikes in <code>lb · 5xx_rate</code>.',
      'Check the Brief\'s change log: what changed right before memory started climbing, and what did that change add?',
    ],

    topology: {
      nodes: [
        { id: 'users', label: 'users', kind: 'client', x: 0, y: 50 },
        { id: 'lb', label: 'lb', kind: 'lb', x: 30, y: 50, health: 'lb:5xx_rate', thresholds: [1, 5] },
        { id: 'resizer', label: 'resizer', kind: 'service', x: 62, y: 50, health: 'resizer:pods_ready', thresholds: [3, 2], invert: true, desc: 'Java image resizer, 4 pods, 1.5 GiB memory limit each' },
        { id: 'blobstore', label: 'blobstore', kind: 'external', x: 95, y: 50, health: 'blobstore:latency_p99', thresholds: [200, 500] },
      ],
      edges: [
        { from: 'users', to: 'lb', metric: 'lb:rps' },
        { from: 'lb', to: 'resizer', metric: 'lb:5xx_rate', label: '5xx', thresholds: [1, 5] },
        { from: 'resizer', to: 'blobstore', metric: 'blobstore:rps' },
      ],
    },

    metrics: [
      { entity: 'lb', name: 'rps', unit: 'req/s', desc: 'requests per second arriving at the load balancer', fn: (t, h) => traffic(t) + h.noise(12) },
      { entity: 'lb', name: '5xx_rate', unit: 'req/s', desc: '502/503/504 responses per second', fn: (t, h) => 0.05 + Math.abs(h.noise(0.05)) + nearOom(t, 14).length * (18 + h.noise(4)) },
      { entity: 'lb', name: 'latency_p99', unit: 'ms', fn: (t, h) => 140 + h.noise(10) + nearOom(t, 30).length * 260 },
      { entity: 'resizer/pod-{i}', instances: PODS, name: 'memory', unit: 'B', desc: 'container working-set memory (limit 1.5 GiB)', fn: (t, h, i) => {
        const s = since(t, i);
        if (s == null) return (BASE + 25 * h.sine(t, 600, i * 100) + h.noise(8)) * MiB;
        if (down(t, i)) return 0;
        return (BASE + leak(i) * s * (1 + h.noise(0.02))) * MiB;
      } },
      { entity: 'resizer', name: 'memory_limit', unit: 'B', desc: 'container memory limit', fn: () => LIMIT * MiB },
      { entity: 'resizer/pod-{i}', instances: PODS, name: 'cpu', unit: '%', fn: (t, h, i) => {
        if (down(t, i)) return 0;
        const s = since(t, i); let v = 34 + h.noise(4);
        if (s != null && s < 40) v += 45;                              // JIT warm-up after (re)start
        if (s != null && BASE + leak(i) * s > LIMIT * 0.88) v += 30;   // GC thrash near the limit
        return v;
      } },
      { entity: 'resizer/pod-{i}', instances: PODS, name: 'gc_pause_ms', unit: 'ms', desc: 'max GC pause per 10s', fn: (t, h, i) => {
        if (down(t, i)) return 0; const s = since(t, i); const used = s == null ? BASE : BASE + leak(i) * s;
        return 12 + h.noise(4) + (used > LIMIT * 0.85 ? (used / LIMIT - 0.85) * 6000 : 0);
      } },
      { entity: 'resizer/pod-{i}', instances: PODS, name: 'restarts', unit: '', desc: 'container restart count (cumulative)', fn: (t, h, i) => restarts(t, i) },
      { entity: 'resizer', name: 'pods_ready', unit: '', desc: 'pods passing readiness', fn: (t) => { let n = 0; for (let i = 1; i <= PODS; i++) if (!down(t, i)) n++; return n; } },
      { entity: 'resizer/pod-{i}', instances: PODS, name: 'rps', unit: 'req/s', fn: (t, h, i) => (down(t, i) ? 0 : (traffic(t) / h.get('resizer:pods_ready', t)) * (1 + h.noise(0.05))) },
      { entity: 'blobstore', name: 'rps', unit: 'req/s', fn: (t, h) => traffic(t) * 2 + h.noise(20) },
      { entity: 'blobstore', name: 'latency_p99', unit: 'ms', desc: 'object storage GET/PUT p99', fn: (t, h) => 70 + h.noise(8) + h.pulse(t, 2300, 90, 110) },
    ],

    dashboards: [
      { title: 'Resizer overview', charts: [
        { title: 'LB 5xx per second', series: ['lb:5xx_rate'] },
        { title: 'LB request rate', series: ['lb:rps'] },
        { title: 'Resizer memory per pod', series: ['resizer/*:memory', 'resizer:memory_limit'] },
        { title: 'Resizer CPU per pod', series: ['resizer/*:cpu'] },
        { title: 'Pods ready', series: ['resizer:pods_ready'] },
        { title: 'Blobstore p99 latency', series: ['blobstore:latency_p99'] },
      ] },
    ],

    events: [
      { t: T_DEPLOY, kind: 'deploy', entity: 'resizer', msg: 'v2.3.0 rolling deploy started: "add in-memory LRU of recently generated thumbnails for faster re-fetch" (PR #812)' },
      { t: T_DEPLOY + 45 * 3 + 30, kind: 'deploy', entity: 'resizer', msg: 'v2.3.0 rollout complete (4/4 pods)' },
      { t: oomTimes[0].t + 8, kind: 'alert', entity: 'lb', msg: 'LB502RateHigh fired' },
      { t: 2300, kind: 'info', entity: 'blobstore', msg: 'provider status page: "elevated latency in us-east-2" (resolved 14:39)' },
    ],

    logs: [
      // background noise
      { entity: (t, h) => 'resizer/pod-' + h.int(1, 4), level: 'INFO', rate: 1.2, msg: (t, h) => 'resized img=' + h.hex(10) + ' ' + h.pick(['4032x3024', '1920x1080', '3000x2000']) + ' -> ' + h.pick(['400x300', '200x200', '800x600']) + ' in ' + Math.round(h.lognormal(40, 0.4)) + 'ms' },
      { entity: 'lb', level: 'INFO', rate: 0.3, msg: (t, h) => 'healthcheck resizer pool ' + PODS + ' targets' },
      { entity: (t, h) => 'resizer/pod-' + h.int(1, 4), level: 'WARN', rate: 0.01, msg: 'blobstore GET retry 1/3: SlowDown (503)' },
      // the deploy
      ...[1, 2, 3, 4].map((i) => ({ t: begin(i) + 3, entity: 'resizer/pod-' + i, level: 'INFO', msg: 'resizer v2.3.0 started; thumbnailCache=enabled maxEntries=unbounded jvm.maxHeap=1400m' })),
      // GC pressure before each OOM
      { entity: (t, h) => { const near = oomTimes.filter((o) => t > o.t - 90 && t < o.t); return near.length ? 'resizer/pod-' + near[0].i : 'resizer/pod-1'; }, level: 'WARN',
        rate: (t) => (oomTimes.some((o) => t > o.t - 90 && t < o.t) ? 0.25 : 0), msg: (t, h) => 'G1 Full GC pause ' + h.int(600, 1900) + 'ms, heap ' + h.int(91, 99) + '% used after collection' },
      // OOM kills
      ...oomTimes.map((o) => ({ t: o.t + 0.5, entity: 'kubelet', level: 'WARN', msg: 'container resizer in pod resizer/pod-' + o.i + ' terminated: reason=OOMKilled exitCode=137; restarting' })),
      ...oomTimes.map((o) => ({ t: o.t + RESTART, entity: 'resizer/pod-' + o.i, level: 'INFO', msg: 'resizer v2.3.0 started; thumbnailCache=enabled maxEntries=unbounded jvm.maxHeap=1400m' })),
      // 502s at the LB
      { entity: 'lb', level: 'ERROR', rate: (t) => nearOom(t, 14).length * 5, msg: (t, h) => { const o = nearOom(t, 14)[0]; return '502 Bad Gateway POST /v1/resize upstream=resizer/pod-' + (o ? o.i : 1) + ' error="connection reset by peer"'; } },
    ],

    traces: [
      { name: 'POST /v1/resize', rate: 0.25, fn: (t, h) => {
        const failing = nearOom(t, 14).length > 0 && h.chance(0.35);
        const gcStall = oomTimes.some((o) => t > o.t - 90 && t < o.t) && h.chance(0.5) ? h.int(400, 1500) : 0;
        const pod = 'pod-' + h.int(1, 4);
        if (failing) return h.span('lb', 'POST /v1/resize', 1, [h.span('resizer', 'resize', h.int(50, 400), [], { error: true, tags: { pod, 'error': 'connection reset by peer' } })], { error: true, tags: { status: 502 } });
        return h.span('lb', 'POST /v1/resize', 1, [
          h.span('resizer', 'resize', 3 + gcStall, [
            h.span('blobstore', 'GET original', h.lognormal(35, 0.3)),
            h.span('resizer', 'decode+scale', h.lognormal(30, 0.3)),
            h.span('blobstore', 'PUT thumbnail', h.lognormal(25, 0.3)),
          ], { tags: { pod, gc_pause_ms: gcStall } }),
        ], { tags: { status: 200 } });
      } },
    ],
  };
})());
