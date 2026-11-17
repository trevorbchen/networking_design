/* Scenario 004 — Periodic error bursts on product pages.
 * Answer key: answers/scenarios/004-cache-stampede.md  (don't peek!) */
OBS.register((function () {
  const PODS = 12, T_D = 900, TTL = 300, DUR = 5400, DB_CAP = 14000;
  const traffic = (t) => 1500 + 1100 * Math.min(1, t / 4800) + 40 * Math.sin(t / 200);
  const lookups = (t) => traffic(t) * 18;                       // product lookups per second (18 per page)
  // synchronized expiry wave: cold start at deploy, then every TTL seconds; slowly spreading
  const wave = (t, phase) => {
    if (t < T_D) return 0;
    let w = 0;
    for (let k = 0; T_D + 25 + k * TTL < DUR + TTL; k++) {
      const c = T_D + 25 + k * TTL + (phase || 0) * 0.3, width = 9 + 1.5 * k;
      w = Math.max(w, Math.exp(-0.5 * ((t - c) / (width / 2.4)) ** 2));
    }
    return w;
  };
  const hit = (t, i) => (t >= T_D && t < T_D + 25 ? 0.05 : 0.962 - 0.37 * wave(t, i));
  const avgHit = (t) => { let s = 0; for (let i = 1; i <= PODS; i++) s += hit(t, i); return s / PODS; };
  const dbDemand = (t) => lookups(t) * (1 - avgHit(t)) + 600;    // + background writers
  const over = (t) => Math.max(0, dbDemand(t) / DB_CAP - 1);
  const errPct = (t) => Math.min(45, over(t) * 60);

  return {
    id: '004-cache-stampede',
    title: 'Product pages error out every five minutes',
    difficulty: 'medium',
    tags: ['caching', 'thundering herd', 'cache stampede', 'TTL', 'periodicity', 'database overload'],
    startTime: '2026-11-17T17:30:00Z',
    duration: DUR, step: 10, seed: 404,
    brief: {
      severity: 'SEV-2',
      alert: 'CatalogErrorBudgetBurn: 5xx bursts on /product/* (recurring)',
      firedAt: 2745,
      summary: `<p><b>Shoply</b>'s product pages are throwing bursts of 500s, each lasting ~10–30 seconds, and the bursts are getting <b>worse as evening traffic climbs</b>. Between bursts everything looks perfectly healthy. The DB team says <code>products-db</code> keeps "randomly" maxing out connections. A product manager asks if you need a bigger database before Black Friday.</p>`,
      task: '<p>Explain the <b>periodic</b> pattern: why it\'s periodic, why it started when it did, and why it\'s getting worse. Decide whether a bigger DB is the right fix.</p>',
      questions: [
        'What is the period of the bursts, and what in the system has that period?',
        'Why did this begin at a specific time, when the cache config hasn\'t changed in months?',
        'Why does the DB get overwhelmed even though average DB load is moderate?',
        'Why is it getting worse over time?',
        'Fixes: immediate, and durable (name the techniques). Is a bigger DB the right call?',
      ],
    },
    architecture: `<ul>
      <li><b>catalog</b>: 12 pods. Each pod has an <b>in-process product cache</b> (Caffeine, <code>expireAfterWrite=300s</code>, 200k entries). On a miss, it loads from products-db (read-through, no request coalescing).</li>
      <li>A product page does ~18 product lookups (item, variants, recommendations).</li>
      <li><b>products-db</b>: PostgreSQL, sustained capacity ≈ 14k simple queries/s, max_connections 300.</li>
      <li>Cache config unchanged since March.</li></ul>`,
    hints: [
      'Measure the time between bursts precisely: zoom in, hover, and compare timestamps (or use a threshold on DB CPU). Does that number appear anywhere in the architecture notes?',
      'Use the Heatmap on <code>cache_hit_ratio</code>. Are the pods\' dips at random times, or <b>aligned</b>? What would make 12 independent caches synchronized? Look at what happened at the first dip.',
      'Compare the <i>average</i> DB QPS with the <i>peak</i>. Then compare each burst\'s peak with DB capacity as traffic grows.',
    ],
    topology: {
      nodes: [
        { id: 'users', kind: 'client', x: 0, y: 50 },
        { id: 'web', kind: 'lb', x: 22, y: 50, health: 'web:error_rate', thresholds: [1, 5] },
        { id: 'catalog', kind: 'service', x: 52, y: 50, health: 'catalog:cache_hit_ratio', thresholds: [85, 60], invert: true, desc: '12 pods, in-process cache TTL 300s' },
        { id: 'products-db', kind: 'db', x: 85, y: 50, health: 'products-db:cpu', thresholds: [80, 95] },
        { id: 'price-import', kind: 'worker', x: 85, y: 88, desc: 'nightly price import job' },
      ],
      edges: [
        { from: 'users', to: 'web', metric: 'web:rps' },
        { from: 'web', to: 'catalog' },
        { from: 'catalog', to: 'products-db', metric: 'products-db:qps', thresholds: [11000, 14000] },
        { from: 'price-import', to: 'products-db', async: true },
      ],
    },
    metrics: [
      { entity: 'web', name: 'rps', unit: 'req/s', fn: (t, h) => traffic(t) * (1 + h.noise(0.02)) },
      { entity: 'web', name: 'error_rate', unit: '%', fn: (t, h) => 0.05 + Math.abs(h.noise(0.04)) + errPct(t) * (1 + h.noise(0.1)) },
      { entity: 'catalog', name: 'latency_p50', unit: 'ms', fn: (t, h) => 22 + 180 * (1 - avgHit(t)) * Math.min(1, dbDemand(t) / DB_CAP) + h.noise(2) },
      { entity: 'catalog', name: 'latency_p99', unit: 'ms', fn: (t, h) => Math.min(5000, 95 + 900 * (1 - avgHit(t)) + over(t) * 6000 + h.noise(8)) },
      { entity: 'catalog', name: 'cache_hit_ratio', unit: '%', desc: 'fleet-wide product cache hit ratio', fn: (t, h) => 100 * avgHit(t) + h.noise(0.4) },
      { entity: 'catalog/pod-{i}', instances: PODS, name: 'cache_hit_ratio', unit: '%', fn: (t, h, i) => 100 * hit(t, i) + h.noise(0.6) },
      { entity: 'catalog/pod-{i}', instances: PODS, name: 'cache_entries', unit: '', fn: (t, h, i) => (t >= T_D && t < T_D + 25 ? 20000 * (t - T_D) / 25 : t < T_D ? 186000 + h.noise(800) : 186000 * (1 - 0.85 * wave(t - 4, i))) + h.noise(500) },
      { entity: 'catalog/pod-{i}', instances: PODS, name: 'cpu', unit: '%', fn: (t, h, i) => 30 + traffic(t) * 0.006 + (t > T_D ? 5 : 0) + 25 * wave(t, i) + h.noise(3) },
      { entity: 'catalog', name: 'db_load_inflight', unit: 'loads', desc: 'cache loads currently waiting on the DB (all pods)', fn: (t, h) => Math.min(3600, 30 * (1 - avgHit(t)) * lookups(t) / 1000 * (1 + over(t) * 8)) + h.noise(2) },
      { entity: 'products-db', name: 'qps', unit: 'q/s', fn: (t, h) => Math.min(DB_CAP * 1.05, dbDemand(t)) * (1 + h.noise(0.03)) },
      { entity: 'products-db', name: 'cpu', unit: '%', fn: (t, h) => Math.min(100, 12 + 85 * dbDemand(t) / DB_CAP + h.noise(2) + (t > 3000 && t < 3400 ? 6 : 0)) },
      { entity: 'products-db', name: 'connections', unit: 'conn', desc: 'max_connections = 300', fn: (t, h) => Math.min(300, 48 + 260 * Math.max(0, dbDemand(t) / DB_CAP - 0.55) + h.int(0, 4)) },
      { entity: 'products-db', name: 'identical_inflight_queries', unit: 'q', desc: 'max number of identical statements (same params) executing concurrently', fn: (t, h) => 1 + Math.round(PODS * 6 * wave(t, 0) * (traffic(t) / 1500)) + h.int(0, 1) },
      { entity: 'products-db', name: 'query_latency_p99', unit: 'ms', fn: (t, h) => 4 + 40 * Math.max(0, dbDemand(t) / DB_CAP - 0.6) + over(t) * 400 + h.noise(0.5) },
      { entity: 'products-db', name: 'write_iops', unit: 'iops', fn: (t, h) => 300 + h.noise(30) + (t > 3000 && t < 3400 ? 2200 : 0) },
    ],
    dashboards: [
      { title: 'Catalog', charts: [
        { title: 'Web error rate', series: ['web:error_rate'] },
        { title: 'Catalog latency', series: ['catalog:latency_p50', 'catalog:latency_p99'] },
        { title: 'Traffic', series: ['web:rps'] },
        { title: 'products-db CPU', series: ['products-db:cpu'] },
        { title: 'products-db connections', series: ['products-db:connections'], threshold: 300 },
        { title: 'Catalog pod CPU', series: ['catalog/*:cpu'] },
      ] },
    ],
    events: [
      { t: T_D, kind: 'deploy', entity: 'catalog', msg: 'catalog v3.8.0: bump jackson-databind 2.15 → 2.17 (CVE fix). Strategy: Recreate (all pods replaced at once; "faster than rolling for a library bump")' },
      { t: 2745, kind: 'alert', entity: 'web', msg: 'CatalogErrorBudgetBurn fired' },
      { t: 3000, kind: 'cron', entity: 'price-import', msg: 'nightly price import started (UPSERT 1.2M rows)' },
      { t: 3400, kind: 'cron', entity: 'price-import', msg: 'price import finished' },
    ],
    logs: [
      { entity: (t, h) => 'catalog/pod-' + h.int(1, PODS), level: 'INFO', rate: 1.2, msg: (t, h) => 'GET /product/' + h.int(10000, 99999) + ' 200 ' + h.int(10, 60) + 'ms' },
      ...Array.from({ length: PODS }, (_, k) => ({ t: T_D + 2 + k * 0.7, entity: 'catalog/pod-' + (k + 1), level: 'INFO', msg: 'catalog v3.8.0 started; productCache expireAfterWrite=300s maximumSize=200000 (cold)' })),
      { entity: (t, h) => 'catalog/pod-' + h.int(1, PODS), level: 'WARN', rate: (t) => wave(t, 0) * 3, msg: (t, h) => 'slow cache load product=' + h.int(10000, 99999) + ' took ' + h.int(150, 2400) + 'ms' },
      { entity: (t, h) => 'catalog/pod-' + h.int(1, PODS), level: 'ERROR', rate: (t) => errPct(t) * 0.5, msg: (t, h) => h.chance(0.6) ? 'org.postgresql.util.PSQLException: FATAL: sorry, too many clients already' : 'CacheLoader timed out after 2000ms for key product:' + h.int(10000, 99999) },
      { entity: 'web', level: 'ERROR', rate: (t) => errPct(t) * 0.3, msg: (t, h) => '500 GET /product/' + h.int(10000, 99999) + ' upstream=catalog' },
      { entity: 'products-db', level: 'WARN', rate: (t) => (over(t) > 0 ? 1.5 : 0), msg: (t, h) => 'connection limit reached (300); rejecting new connection from ' + '10.4.' + h.int(1, 12) + '.' + h.int(2, 250) },
      { entity: 'products-db', level: 'INFO', rate: (t) => (dbDemand(t) > DB_CAP * 0.8 ? 0.5 : 0), msg: (t, h) => 'duration: ' + h.int(120, 900) + ' ms  statement: SELECT * FROM products WHERE id = ' + h.pick([10423, 10423, 55120, 88001, 10423, 20231]) },
      { entity: 'price-import', level: 'INFO', rate: (t) => (t > 3000 && t < 3400 ? 0.2 : 0), msg: (t, h) => 'upserted batch ' + h.int(1, 600) + '/600 (2000 rows)' },
      { entity: 'products-db', level: 'INFO', rate: 1 / 400, msg: 'automatic vacuum of table "shop.public.product_views": index scans: 1' },
    ],
    traces: [
      { name: 'GET /product/:id', rate: 0.2, fn: (t, h) => {
        const pod = h.int(1, PODS), hr = hit(t, pod);
        const failed = h.chance(errPct(t) / 100);
        const lk = Array.from({ length: 6 }, (_, k) => {
          if (h.chance(hr)) return h.span('catalog', 'cache.get (hit)', 0.05);
          const ql = h.lognormal(3, 0.3) * (1 + over(t) * 40) * (1 + Math.max(0, dbDemand(t) / DB_CAP - 0.6) * 10);
          return h.span('catalog', 'cache.get (MISS → load)', 0.2, [h.span('products-db', 'SELECT product', Math.min(2000, ql), [], { error: failed && k === 0 })], { error: failed && k === 0 });
        });
        return h.span('web', 'GET /product/:id', 1, [h.span('catalog', 'ProductPage', 2, [h.span('catalog', 'lookups', 0.1, lk, { parallel: true }), h.span('catalog', 'render', h.lognormal(6, 0.2))], { tags: { pod: 'pod-' + pod } })], { error: failed, tags: { status: failed ? 500 : 200 } });
      } },
    ],
  };
})());
