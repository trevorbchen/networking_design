/* Scenario 005 — "I saved my settings and they reverted."
 * Answer key: answers/scenarios/005-stale-reads.md  (don't peek!) */
OBS.register((function () {
  const T_Q = 1210, T_QEND = 2930, T_DEPLOY = 900, T_CDN = 1500;
  const lag2 = (t) => (t < T_Q ? 0.3 : t < T_QEND ? 0.3 + (t - T_Q) : Math.max(0.3, (T_QEND - T_Q) * (1 - (t - T_QEND) / 140)));
  const lag1 = () => 0.25;
  const traffic = (t) => 2200 + 300 * Math.sin(t / 900);
  const writes = (t) => 140 + 20 * Math.sin(t / 500);
  // P(a read after a recent write hits stale data): 50% of reads go to replica-2, stale if lag > time since write (~typ 5-60s)
  const staleFrac = (t) => 0.5 * Math.min(1, Math.max(0, (lag2(t) - 2) / 60));

  return {
    id: '005-stale-reads',
    title: 'Users say their saved settings keep reverting',
    difficulty: 'medium',
    tags: ['replication lag', 'read-your-writes', 'stale reads', 'postgres', 'read replicas', 'consistency'],
    startTime: '2026-11-17T09:00:00Z',
    duration: 3600, step: 10, seed: 505,
    brief: {
      severity: 'SEV-3',
      alert: 'Support escalation: spike in "my changes didn\'t save" tickets',
      firedAt: 1900,
      summary: `<p><b>Tempo</b> is a fitness app. Since mid-morning, support has been flooded with tickets: users change a setting (units, privacy, display name), see "Saved ✓", and then on the next screen or after a refresh <b>the old value is back</b>. Sometimes refreshing again shows the new value. No errors in the API, and latency is normal.</p>
        <p>The profile team shipped a deploy this morning and is being blamed. The web team also changed CDN caching rules today, and someone suspects the CDN is serving stale pages.</p>`,
      task: '<p>Explain why users see stale data, why it\'s intermittent, and which component is responsible. Propose a mitigation for right now and design changes so read-after-write is reliable.</p>',
      questions: [
        'Where is the stale data coming from? Prove it.',
        'Why is it intermittent (sometimes refreshing "fixes" it)?',
        'What caused it to start, and why did it stop when it did?',
        'Why didn\'t any latency/error alert fire?',
        'Immediate mitigation? Durable fixes for read-your-writes consistency?',
      ],
    },
    architecture: `<ul>
      <li><b>api</b> (8 pods) → writes go to <b>pg-primary</b>, reads go through <b>pg-read</b> (pgbouncer, round-robin) to <b>pg-replica-1</b> and <b>pg-replica-2</b>. Replication is asynchronous streaming.</li>
      <li>Replicas run with <code>max_standby_streaming_delay = -1</code> ("never cancel queries on replicas", set last quarter so analytics queries stop failing).</li>
      <li>The analytics team has read access to the replicas for ad-hoc and scheduled reports.</li>
      <li><b>cdn</b> caches static assets and public pages only. API responses are <code>Cache-Control: no-store</code>.</li>
      <li>The mobile app reports a telemetry event when it reads back a profile version lower than one it just wrote (<code>client:version_regressions</code>).</li></ul>`,
    hints: [
      'Where can a read get older data than a write that already succeeded? List every layer between the client and the data. Then check which of them have metrics that changed.',
      'Look at the replicas side by side (Heatmap on <code>replay_lag_s</code>, or the Metrics tree). Is the lag shape a spike, a step, or a <i>ramp</i>? What produces a linear ramp?',
      'A replica that receives WAL but doesn\'t <b>replay</b> it is usually waiting for something. Check the replica\'s longest-running query, its logs, and the cron events.',
    ],
    topology: {
      nodes: [
        { id: 'mobile', kind: 'client', x: 0, y: 50 },
        { id: 'cdn', kind: 'lb', x: 16, y: 20, health: 'cdn:hit_ratio', thresholds: [80, 60], invert: true },
        { id: 'api', kind: 'service', x: 34, y: 50, health: 'api:error_rate', thresholds: [1, 5] },
        { id: 'pg-primary', kind: 'db', x: 62, y: 18, health: 'pg-primary:cpu', thresholds: [75, 90] },
        { id: 'pg-read', kind: 'lb', x: 58, y: 65, desc: 'pgbouncer round-robin over replicas' },
        { id: 'pg-replica', kind: 'db', x: 84, y: 65, health: 'pg-replica:max_replay_lag_s', thresholds: [5, 30], desc: 'two async streaming replicas' },
        { id: 'analytics', kind: 'worker', x: 92, y: 95, desc: 'BI / reporting jobs' },
      ],
      edges: [
        { from: 'mobile', to: 'cdn', label: 'static' },
        { from: 'mobile', to: 'api', metric: 'api:rps' },
        { from: 'api', to: 'pg-primary', metric: 'api:writes', label: 'writes' },
        { from: 'api', to: 'pg-read', label: 'reads' },
        { from: 'pg-read', to: 'pg-replica' },
        { from: 'pg-primary', to: 'pg-replica', label: 'WAL stream', async: true },
        { from: 'analytics', to: 'pg-replica', async: true },
      ],
    },
    metrics: [
      { entity: 'api', name: 'rps', unit: 'req/s', fn: (t, h) => traffic(t) + h.noise(40) },
      { entity: 'api', name: 'writes', unit: 'req/s', desc: 'PUT/PATCH requests', fn: (t, h) => writes(t) + h.noise(8) },
      { entity: 'api', name: 'latency_p99', unit: 'ms', fn: (t, h) => 85 + h.noise(8) + (t > T_DEPLOY && t < T_DEPLOY + 60 ? 60 : 0) },
      { entity: 'api', name: 'error_rate', unit: '%', fn: (t, h) => 0.08 + Math.abs(h.noise(0.05)) },
      { entity: 'client', name: 'version_regressions', unit: '/min', desc: 'mobile app saw an older profile version than it just wrote', fn: (t, h) => Math.max(0, writes(t) * 60 * 0.35 * staleFrac(t) * (1 + h.noise(0.15)) + Math.abs(h.noise(0.3))) },
      { entity: 'support', name: 'tickets', unit: '/10min', desc: 'tickets tagged "data not saved"', fn: (t, h) => Math.max(0, 0.4 + 30 * staleFrac(Math.max(0, t - 300)) + h.noise(0.8)), smooth: 6 },
      { entity: 'cdn', name: 'hit_ratio', unit: '%', fn: (t, h) => (t < T_CDN ? 88 : 93) + h.noise(0.8) },
      { entity: 'cdn', name: 'egress', unit: 'B/s', fn: (t, h) => (t < T_CDN ? 410 : 380) * 1048576 + h.noise(2e7) },
      { entity: 'pg-primary', name: 'cpu', unit: '%', fn: (t, h) => 38 + writes(t) * 0.05 + h.noise(3) },
      { entity: 'pg-primary', name: 'wal_rate', unit: 'B/s', desc: 'WAL generated', fn: (t, h) => (writes(t) * 9000 + 2e5) * (1 + h.noise(0.05)) },
      { entity: 'pg-primary', name: 'connections', unit: 'conn', fn: (t, h) => 180 + h.int(0, 8) },
      { entity: 'pg-replica/replica-{i}', instances: 2, name: 'replay_lag_s', unit: 's', desc: 'now() - pg_last_xact_replay_timestamp(): how stale reads are', fn: (t, h, i) => (i === 2 ? lag2(t) : lag1()) * (1 + h.noise(0.03)) + Math.abs(h.noise(0.05)) },
      { entity: 'pg-replica/replica-{i}', instances: 2, name: 'receive_lag_b', unit: 'B', desc: 'WAL sent by primary but not yet received', fn: (t, h, i) => Math.abs(h.noise(40000)) },
      { entity: 'pg-replica', name: 'max_replay_lag_s', unit: 's', fn: (t, h) => Math.max(h.get('pg-replica/replica-1:replay_lag_s', t), h.get('pg-replica/replica-2:replay_lag_s', t)) },
      { entity: 'pg-replica/replica-{i}', instances: 2, name: 'cpu', unit: '%', fn: (t, h, i) => 30 + traffic(t) * 0.004 + (i === 2 && t >= T_Q && t < T_QEND ? 28 : 0) + h.noise(3) },
      { entity: 'pg-replica/replica-{i}', instances: 2, name: 'read_qps', unit: 'q/s', fn: (t, h, i) => traffic(t) * 1.6 / 2 + h.noise(30) },
      { entity: 'pg-replica/replica-{i}', instances: 2, name: 'disk_read_iops', unit: 'iops', fn: (t, h, i) => 900 + (i === 2 && t >= T_Q && t < T_QEND ? 5200 : 0) + h.noise(80) },
      { entity: 'pg-replica/replica-{i}', instances: 2, name: 'longest_query_s', unit: 's', desc: 'age of the oldest running query', fn: (t, h, i) => (i === 2 && t >= T_Q && t < T_QEND ? t - T_Q + 2 : h.int(0, 3) + Math.abs(h.noise(1))) },
      { entity: 'pg-replica/replica-{i}', instances: 2, name: 'read_latency_p99', unit: 'ms', fn: (t, h, i) => 6 + (i === 2 && t >= T_Q && t < T_QEND ? 2.5 : 0) + h.noise(0.6) },
    ],
    dashboards: [
      { title: 'API overview', charts: [
        { title: 'API latency p99', series: ['api:latency_p99'] },
        { title: 'API errors', series: ['api:error_rate'] },
        { title: 'Traffic', series: ['api:rps', 'api:writes'] },
        { title: 'Support tickets', series: ['support:tickets'] },
        { title: 'pg-primary CPU', series: ['pg-primary:cpu'] },
        { title: 'CDN hit ratio', series: ['cdn:hit_ratio'] },
      ] },
    ],
    events: [
      { t: T_DEPLOY, kind: 'deploy', entity: 'api', msg: 'profile-api v5.2.0: new avatar cropper; settings page uses PATCH instead of PUT' },
      { t: 1200, kind: 'cron', entity: 'analytics', msg: 'scheduled report "weekly_cohort_retention" started (target: pg-read replicas)' },
      { t: T_CDN, kind: 'config', entity: 'cdn', msg: 'cache rules: static asset TTL 1h → 24h; add stale-while-revalidate=60 for /blog/*' },
      { t: 1900, kind: 'alert', entity: 'support', msg: 'support escalation opened (#INC-7781)' },
      { t: T_QEND, kind: 'cron', entity: 'analytics', msg: 'report "weekly_cohort_retention" finished (28m 40s)' },
    ],
    logs: [
      { entity: (t, h) => 'api/pod-' + h.int(1, 8), level: 'INFO', rate: 1.5, msg: (t, h) => (h.chance(0.07) ? 'PATCH /v1/profile 200 user=' + h.int(1e5, 9e5) + ' version=' + h.int(10, 400) : 'GET /v1/' + h.pick(['profile', 'workouts', 'feed', 'stats']) + ' 200 ' + h.int(8, 60) + 'ms db=' + h.pick(['replica-1', 'replica-2'])) },
      { entity: 'pg-replica/replica-2', level: 'INFO', t: T_Q + 3, msg: 'connection authorized: user=bi_reader database=app application_name=metabase' },
      { entity: 'pg-replica/replica-2', level: 'WARN', rate: (t) => (t > T_Q + 30 && t < T_QEND ? 1 / 60 : 0), msg: (t, h) => 'recovery is waiting: WAL replay blocked by conflicting query pid=48121 (bi_reader) running ' + Math.round((t - T_Q) / 60) + ' min; max_standby_streaming_delay=-1' },
      { entity: 'pg-replica/replica-2', level: 'INFO', t: T_QEND + 1, msg: 'duration: 1720342.118 ms  statement: SELECT cohort_week, ... FROM workouts w JOIN users u ... GROUP BY 1,2 /* weekly_cohort_retention */' },
      { entity: 'pg-replica/replica-2', level: 'INFO', t: T_QEND + 140, msg: 'recovery caught up with primary' },
      { entity: (t, h) => 'api/pod-' + h.int(1, 8), level: 'WARN', rate: (t) => writes(t) * 0.004 * staleFrac(t) * 10, msg: (t, h) => 'client reported version regression user=' + h.int(1e5, 9e5) + ' wrote=v' + h.int(50, 400) + ' read=v-1 db=replica-2' },
      { entity: 'cdn', level: 'INFO', rate: 0.2, msg: (t, h) => 'HIT /static/app.' + h.hex(6) + '.js age=' + h.int(10, 80000) },
      { entity: 'api/pod-3', level: 'WARN', rate: 0.01, msg: 'avatar cropper: image exceeded 8MB, downscaling' },
      { entity: 'pg-primary', level: 'INFO', rate: 1 / 300, msg: (t, h) => 'checkpoint complete: wrote ' + h.int(1000, 5000) + ' buffers' },
    ],
    traces: [
      { name: 'PATCH /v1/profile → GET', rate: 0.15, fn: (t, h) => {
        const rep = h.chance(0.5) ? 2 : 1;
        const stale = rep === 2 && lag2(t) > 3 && h.chance(Math.min(1, (lag2(t) - 2) / 60));
        return h.span('mobile', 'save settings flow', 1, [
          h.span('api', 'PATCH /v1/profile', 2, [h.span('pg-primary', 'UPDATE profiles SET ... version=version+1', h.lognormal(3, 0.3))], { tags: { version_written: 'v42' } }),
          h.span('mobile', 'navigate', h.lognormal(400, 0.4)),
          h.span('api', 'GET /v1/profile', 1.5, [h.span('pg-replica', 'SELECT * FROM profiles (replica-' + rep + ')', h.lognormal(rep === 2 && t > T_Q && t < T_QEND ? 6 : 3, 0.3), [], { tags: { 'db.host': 'replica-' + rep, replica_lag_s: (rep === 2 ? lag2(t) : lag1()).toFixed(1) } })], { error: stale, tags: { version_read: stale ? 'v41 (STALE)' : 'v42' } }),
        ], { error: stale });
      } },
      { name: 'GET /v1/feed', rate: 0.1, fn: (t, h) => h.span('api', 'GET /v1/feed', 2, [h.span('pg-replica', 'SELECT feed', h.lognormal(5, 0.3))]) },
    ],
  };
})());
