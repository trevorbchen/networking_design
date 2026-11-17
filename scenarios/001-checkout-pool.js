/* Scenario 001 — Checkout latency & 504s at lunch peak.
 * Answer key: answers/scenarios/001-checkout-pool.md  (don't peek!) */
OBS.register((function () {
  const PODS = 6, POOL = 20, T_DEPLOY = 1200, T_PEAK0 = 1700, T_PEAK1 = 2300;
  const skew = [0, 0.96, 1.03, 0.99, 1.05, 0.97, 1.0];          // per-pod load imbalance
  const traffic = (t) => 820 + (1180 - 820) * Math.min(1, Math.max(0, (t - T_PEAK0) / (T_PEAK1 - T_PEAK0))) - Math.max(0, (t - 3300) * 0.4);
  const checkoutRps = (t) => traffic(t) * 0.22;                     // 22% of requests are checkouts
  const deployed = (t, i) => t >= T_DEPLOY + (i - 1) * 25;           // rolling deploy, 25s per pod
  const queriesPerReq = (t, i) => (deployed(t, i) ? 3 + 6.2 : 3);    // N+1: one loyalty query per cart item (avg 6.2 items)
  const dbLat = (t) => 3.2 + 2.2 * Math.max(0, (traffic(t) - 800) / 400) * (t > T_DEPLOY ? 1.6 : 1); // ms per query
  // connection hold time per checkout: queries + the inventory call made INSIDE the transaction
  const hold = (t, i) => queriesPerReq(t, i) * dbLat(t) + 38;
  const demand = (t, i) => (checkoutRps(t) / PODS) * skew[i] * 1.15 * (hold(t, i) / 1000) * 4.5; // x4.5: connection checkouts per request (cart tx + order tx + retries)
  const rho = (t, i) => demand(t, i) / POOL;
  const waitMs = (t, i) => { const r = rho(t, i); const w = r < 1 ? hold(t, i) * Math.pow(r, 14) / (1 - r + 0.03) : 3000; return Math.min(3000, w); };
  const errPct = (t, i) => Math.min(30, Math.max(0, (rho(t, i) - 0.96) * 160));
  const avgOver = (f, t) => { let s = 0; for (let i = 1; i <= PODS; i++) s += f(t, i); return s / PODS; };

  return {
    id: '001-checkout-pool',
    title: 'Checkout p99 explodes at lunch',
    difficulty: 'medium',
    tags: ['latency', 'connection pool', 'saturation', 'N+1 queries', 'deploy regression'],
    startTime: '2026-11-17T11:30:00Z',
    duration: 3600, step: 10, seed: 101,
    brief: {
      severity: 'SEV-2',
      alert: 'CheckoutLatencyHigh: POST /checkout p99 > 1s for 5m; 504s rising',
      firedAt: 2140,
      summary: `<p>You run checkout for <b>Cartwheel</b>, a mid-size e-commerce site. During the lunch rush, checkout p99 latency went from ~250 ms to multiple seconds and the gateway started returning <b>504 Gateway Timeout</b>. Browsing (GET /cart, product pages) seems fine.</p>
        <p>Someone in the incident channel already said <i>"the database is overloaded, we need a bigger instance"</i>. Someone else blames the payments provider, which posted a status update.</p>`,
      task: '<p>Find what is <b>actually</b> saturated and why it started <b>today</b>, since lunch traffic happens every day. Recommend a mitigation that works in minutes, plus a durable fix.</p>',
      questions: [
        'Which resource is saturated? Show the metric that proves saturation (not just "it\'s slow").',
        'Is the database overloaded? Defend your answer with numbers.',
        'What changed today that made normal lunch traffic tip the system over?',
        'Why does checkout fail while GET /cart is fine?',
        'Mitigation in the next 10 minutes? Durable fix? What alert would catch this earlier?',
      ],
    },
    architecture: `<ul>
      <li><b>gateway</b>: API gateway, 5s upstream timeout, returns 504 on timeout.</li>
      <li><b>checkout</b>: 6 pods (JVM, HikariCP). Each pod has a <b>DB connection pool of max 20</b>, with a 3000 ms connection-acquire timeout.</li>
      <li><b>orders-db</b>: PostgreSQL primary, max_connections=500, 16 vCPU.</li>
      <li><b>cart</b>: serves GET /cart from <b>redis</b>. Checkout calls <b>inventory</b> to reserve stock, and <b>payments</b> (external PSP) to charge.</li>
      <li>Checkout opens a DB transaction, reads cart and prices, reserves inventory, writes the order, and commits. The transaction is open while inventory is called.</li></ul>`,
    hints: [
      'Latency can come from <i>doing work</i> or from <i>waiting for a resource</i>. Look at the checkout pods\' per-pod metrics: is anything pinned at a hard ceiling?',
      'Open a slow checkout trace. Which span has the largest <b>self time</b>? Then open the Traces → Breakdown table and look at the <b>calls/trace</b> column for orders-db. Compare a window before 11:50 with one after 12:10.',
      'Is the DB query latency actually bad? Compare <code>orders-db:query_latency_p99</code> with the checkout latency. Then read the deploy description in the change log carefully.',
    ],

    topology: {
      nodes: [
        { id: 'users', kind: 'client', x: 0, y: 45 },
        { id: 'gateway', kind: 'lb', x: 18, y: 45, health: 'gateway:5xx_rate', thresholds: [0.5, 2] },
        { id: 'cart', kind: 'service', x: 40, y: 10, health: 'cart:latency_p99', thresholds: [150, 400] },
        { id: 'redis', kind: 'cache', x: 66, y: 4, health: 'redis:latency_p99', thresholds: [5, 20] },
        { id: 'checkout', kind: 'service', x: 40, y: 58, health: 'checkout:latency_p99', thresholds: [800, 2000], desc: '6 pods, HikariCP pool max=20/pod, acquire timeout 3000ms' },
        { id: 'inventory', kind: 'service', x: 66, y: 38, health: 'inventory:latency_p99', thresholds: [150, 400] },
        { id: 'orders-db', kind: 'db', x: 66, y: 78, health: 'orders-db:cpu', thresholds: [75, 90], desc: 'PostgreSQL 15 primary, 16 vCPU, max_connections=500' },
        { id: 'payments', kind: 'external', x: 92, y: 58, health: 'payments:latency_p99', thresholds: [900, 2000], desc: 'third-party payment service provider' },
      ],
      edges: [
        { from: 'users', to: 'gateway', metric: 'gateway:rps' },
        { from: 'gateway', to: 'cart', label: 'GET /cart' },
        { from: 'gateway', to: 'checkout', metric: 'checkout:rps' },
        { from: 'cart', to: 'redis' },
        { from: 'checkout', to: 'inventory' },
        { from: 'checkout', to: 'orders-db', metric: 'orders-db:qps' },
        { from: 'checkout', to: 'payments' },
        { from: 'inventory', to: 'orders-db' },
      ],
    },

    metrics: [
      { entity: 'gateway', name: 'rps', unit: 'req/s', fn: (t, h) => traffic(t) * (1 + h.noise(0.03)) },
      { entity: 'gateway', name: '5xx_rate', unit: '%', desc: '% of all gateway responses that are 5xx', fn: (t, h) => 0.05 + Math.abs(h.noise(0.04)) + avgOver(errPct, t) * 0.22 * (1 + h.noise(0.1)) },
      { entity: 'checkout', name: 'rps', unit: 'req/s', fn: (t, h) => checkoutRps(t) * (1 + h.noise(0.04)) },
      { entity: 'checkout', name: 'latency_p50', unit: 'ms', fn: (t, h) => 140 + avgOver(waitMs, t) * 0.45 + h.noise(8) },
      { entity: 'checkout', name: 'latency_p99', unit: 'ms', fn: (t, h) => Math.min(5000, 260 + avgOver(waitMs, t) * 1.55 + h.noise(25)) },
      { entity: 'checkout', name: 'error_rate', unit: '%', fn: (t, h) => 0.1 + Math.abs(h.noise(0.08)) + avgOver(errPct, t) * (1 + h.noise(0.1)) },
      { entity: 'checkout/pod-{i}', instances: PODS, name: 'db_pool_active', unit: 'conn', desc: 'HikariCP active connections (max 20)', fn: (t, h, i) => Math.min(POOL, demand(t, i) * (1 + h.noise(0.08))), max: POOL },
      { entity: 'checkout/pod-{i}', instances: PODS, name: 'db_pool_pending', unit: 'threads', desc: 'threads waiting to acquire a connection', fn: (t, h, i) => { const r = rho(t, i); return r < 0.85 ? Math.abs(h.noise(0.2)) : (r - 0.85) * 160 * (1 + h.noise(0.15)); } },
      { entity: 'checkout/pod-{i}', instances: PODS, name: 'db_pool_wait_ms', unit: 'ms', desc: 'mean time to acquire a connection', fn: (t, h, i) => waitMs(t, i) * (1 + h.noise(0.1)) + 0.3 },
      { entity: 'checkout/pod-{i}', instances: PODS, name: 'cpu', unit: '%', fn: (t, h, i) => 28 + checkoutRps(t) / PODS * 0.08 + (deployed(t, i) ? 6 : 0) + Math.min(14, rho(t, i) * 6) + h.noise(3) },
      { entity: 'checkout/pod-{i}', instances: PODS, name: 'threads_busy', unit: 'threads', desc: 'busy request-handler threads (max 200)', fn: (t, h, i) => Math.min(200, 12 + rho(t, i) * 20 + Math.max(0, rho(t, i) - 0.85) * 600 + h.noise(2)) },
      { entity: 'checkout', name: 'db_queries_per_request', unit: 'q', desc: 'SQL statements per checkout request', fn: (t, h) => avgOver(queriesPerReq, t) + h.noise(0.3) },
      { entity: 'orders-db', name: 'qps', unit: 'q/s', desc: 'queries per second (all clients)', fn: (t, h) => checkoutRps(t) * avgOver(queriesPerReq, t) * 1.0 + traffic(t) * 0.35 + h.noise(20) },
      { entity: 'orders-db', name: 'cpu', unit: '%', fn: (t, h) => 22 + (checkoutRps(t) * avgOver(queriesPerReq, t) + traffic(t) * 0.35) * 0.018 + h.noise(2.5) },
      { entity: 'orders-db', name: 'query_latency_p99', unit: 'ms', desc: 'server-side statement latency p99', fn: (t, h) => dbLat(t) * 2.1 + h.noise(0.6) },
      { entity: 'orders-db', name: 'connections', unit: 'conn', desc: 'open client connections (max_connections=500)', fn: (t, h) => PODS * POOL + 30 + h.int(0, 3) },
      { entity: 'orders-db', name: 'disk_iops', unit: 'iops', fn: (t, h) => 1800 + traffic(t) * 0.9 + h.noise(120) + h.pulse(t, 2950, 120, 1400) },
      { entity: 'orders-db', name: 'replication_lag', unit: 's', fn: (t, h) => 0.2 + Math.abs(h.noise(0.1)) },
      { entity: 'cart', name: 'latency_p99', unit: 'ms', fn: (t, h) => 48 + h.noise(5) },
      { entity: 'redis', name: 'latency_p99', unit: 'ms', fn: (t, h) => 1.2 + Math.abs(h.noise(0.3)) },
      { entity: 'redis', name: 'hit_ratio', unit: '%', fn: (t, h) => 97.5 + h.noise(0.6) },
      { entity: 'inventory', name: 'latency_p99', unit: 'ms', fn: (t, h) => 62 + h.noise(6) + (traffic(t) - 800) * 0.02 },
      { entity: 'payments', name: 'latency_p99', unit: 'ms', desc: 'PSP charge call latency p99 (external)', fn: (t, h) => 520 + h.noise(40) + h.pulse(t, 2520, 160, 900) },
      { entity: 'payments', name: 'error_rate', unit: '%', fn: (t, h) => 0.2 + Math.abs(h.noise(0.1)) + h.pulse(t, 2520, 100, 1.5) },
    ],

    dashboards: [
      { title: 'Checkout golden signals', charts: [
        { title: 'Checkout latency', series: ['checkout:latency_p50', 'checkout:latency_p99'] },
        { title: 'Checkout error rate', series: ['checkout:error_rate'] },
        { title: 'Traffic', series: ['gateway:rps', 'checkout:rps'] },
        { title: 'Checkout CPU per pod', series: ['checkout/*:cpu'] },
        { title: 'orders-db CPU', series: ['orders-db:cpu'] },
        { title: 'Payments p99 (external)', series: ['payments:latency_p99'] },
      ] },
      { title: 'Database', charts: [
        { title: 'orders-db CPU', series: ['orders-db:cpu'] },
        { title: 'orders-db QPS', series: ['orders-db:qps'] },
        { title: 'orders-db query p99', series: ['orders-db:query_latency_p99'] },
        { title: 'orders-db connections', series: ['orders-db:connections'] },
        { title: 'orders-db disk IOPS', series: ['orders-db:disk_iops'] },
        { title: 'replication lag', series: ['orders-db:replication_lag'] },
      ] },
    ],

    events: [
      { t: T_DEPLOY, kind: 'deploy', entity: 'checkout', msg: 'v4.12.0 rolling deploy: "show loyalty points earned per line item on order confirmation" (PR #2291)' },
      { t: T_DEPLOY + 150, kind: 'deploy', entity: 'checkout', msg: 'v4.12.0 rollout complete 6/6' },
      { t: 2140, kind: 'alert', entity: 'checkout', msg: 'CheckoutLatencyHigh fired (p99 > 1s for 5m)' },
      { t: 2520, kind: 'info', entity: 'payments', msg: 'PSP status page: "Investigating elevated API latency" (resolved 12:14)' },
      { t: 2700, kind: 'config', entity: 'search', msg: 'feature flag search.typo_tolerance=on (10% → 50%)' },
      { t: 2950, kind: 'cron', entity: 'orders-db', msg: 'scheduled: autovacuum on table order_events' },
    ],

    logs: [
      { entity: (t, h) => 'checkout/pod-' + h.int(1, PODS), level: 'INFO', rate: (t) => checkoutRps(t) * 0.01, msg: (t, h) => 'order ' + h.hex(12) + ' created items=' + h.int(1, 14) + ' total=$' + h.int(12, 400) + '.' + h.int(10, 99) },
      { entity: 'cart', level: 'INFO', rate: 0.4, msg: (t, h) => 'GET /cart 200 ' + h.int(8, 40) + 'ms' },
      { entity: 'inventory', level: 'WARN', rate: 0.02, msg: (t, h) => 'slow query 212ms: SELECT ... FROM stock_levels WHERE warehouse_id = $1 (seq scan)' },
      { entity: 'orders-db', level: 'INFO', rate: 1 / 300, msg: (t, h) => 'checkpoint complete: wrote ' + h.int(800, 4000) + ' buffers' },
      ...Array.from({ length: PODS }, (_, k) => ({ t: T_DEPLOY + k * 25 + 4, entity: 'checkout/pod-' + (k + 1), level: 'INFO', msg: 'checkout v4.12.0 started (features: loyalty-line-items=ON) hikari.maximumPoolSize=20 connectionTimeout=3000' })),
      { entity: (t, h) => 'checkout/pod-' + h.int(1, PODS), level: 'DEBUG', rate: (t) => (t > T_DEPLOY ? 0.3 : 0), msg: (t, h) => 'LoyaltyService.pointsFor(sku=' + h.int(10000, 99999) + ') -> SELECT points_rule FROM loyalty_rules WHERE sku = $1' },
      { entity: (t, h) => 'checkout/pod-' + h.int(1, PODS), level: 'WARN', rate: (t) => { const r = avgOver(rho, t); return r > 0.9 ? (r - 0.9) * 12 : 0; }, msg: (t, h) => 'HikariPool-1 - Pool stats (total=20, active=20, idle=0, waiting=' + h.int(20, 140) + ')' },
      { entity: (t, h) => 'checkout/pod-' + h.int(1, PODS), level: 'ERROR', rate: (t) => avgOver(errPct, t) * checkoutRps(t) / 100 * 0.25, msg: (t, h) => 'java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 3000ms.' },
      { entity: 'gateway', level: 'ERROR', rate: (t) => avgOver(errPct, t) * checkoutRps(t) / 100 * 0.15, msg: (t, h) => '504 upstream timed out (5000ms) POST /checkout upstream=checkout' },
      { entity: 'payments', level: 'WARN', rate: (t) => (t > 2440 && t < 2600 ? 0.4 : 0.01), msg: (t, h) => 'PSP charge latency ' + h.int(900, 2400) + 'ms (> 800ms SLO)' },
      { entity: 'search', level: 'INFO', rate: 0.05, msg: 'typo-tolerance experiment bucket assigned' },
    ],

    traces: [
      { name: 'POST /checkout', rate: (t) => 0.12 * checkoutRps(t) / 180, fn: (t, h) => {
        const i = h.int(1, PODS);
        const w = waitMs(t, i) * h.lognormal(1, 0.5);
        const failed = h.chance(errPct(t, i) / 100);
        const ql = () => h.lognormal(dbLat(t), 0.35);
        const pool = h.span('checkout', 'hikari.getConnection', Math.min(3000, w), [], { error: failed, tags: { pool_max: 20 } });
        if (failed) return h.span('gateway', 'POST /checkout', 1, [h.span('checkout', 'CheckoutController.submit', 2, [pool], { error: true, tags: { pod: 'pod-' + i, exception: 'SQLTransientConnectionException' } })], { error: true, tags: { status: 500 } });
        const items = deployed(t, i) ? h.int(2, 11) : 0;
        const loyalty = Array.from({ length: items }, () => h.span('orders-db', 'SELECT loyalty_rules', ql(), [], { tags: { 'db.statement': 'SELECT points_rule FROM loyalty_rules WHERE sku = $1' } }));
        return h.span('gateway', 'POST /checkout', 1, [
          h.span('checkout', 'CheckoutController.submit', 4, [
            pool,
            h.span('orders-db', 'BEGIN; SELECT cart', ql()),
            h.span('orders-db', 'SELECT prices', ql()),
            ...loyalty,
            h.span('inventory', 'POST /reserve', h.lognormal(34, 0.3), [h.span('orders-db', 'UPDATE stock', ql())]),
            h.span('orders-db', 'INSERT order; COMMIT', ql() * 1.5),
            h.span('payments', 'charge', h.lognormal(t > 2440 && t < 2600 ? 1100 : 300, 0.35)),
          ], { tags: { pod: 'pod-' + i, items: items || h.int(1, 11), version: deployed(t, i) ? '4.12.0' : '4.11.3' } }),
        ], { tags: { status: 200 } });
      } },
      { name: 'GET /cart', rate: 0.1, fn: (t, h) => h.span('gateway', 'GET /cart', 1, [h.span('cart', 'getCart', h.lognormal(6, 0.3), [h.span('redis', 'GET cart:*', h.lognormal(0.6, 0.3))])]) },
    ],
  };
})());
