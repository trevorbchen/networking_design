/* Scenario 010 — "Recommendation CTR is down 30% and nothing is broken."
 * Answer key: answers/scenarios/010-feature-skew.md  (don't peek!) */
OBS.register((function () {
  const T_EXP = 900, T_FEAT = 1500, TTL = 1800, T_CDN = 2200;
  const RET = 0.8; // share of traffic from returning users (new users have no watch history → feature default 0)
  const affected = (t) => (t < T_FEAT ? 0 : Math.min(1, (t - T_FEAT) / TTL)); // share of returning users whose cached features are in the new (ms) format
  const rps = (t) => 5200 + 600 * Math.sin(t / 1100);
  const CTR0 = 0.09, CTR_BAD = 0.058;
  const ctrRet = (t) => CTR0 * (1 - affected(t)) + CTR_BAD * affected(t);
  const ctrNew = () => 0.071;
  const ctr = (t) => RET * ctrRet(t) + (1 - RET) * ctrNew();
  const predRet = (t) => 0.091 * (1 - affected(t)) + 0.152 * affected(t);
  const pred = (t) => RET * predRet(t) + (1 - RET) * 0.072;
  const longForm = (t) => 0.18 + 0.2 * RET * affected(t);
  const watchMean = (t) => RET * (46 * (1 - affected(t)) + 46000 * affected(t)); // mean over requests incl. new users (0)
  const FEATURES = [
    ['user_avg_watch_s', (t) => watchMean(t), (t) => 0.03 + 9.5 * affected(t)],
    ['user_sessions_7d', () => 9.4, () => 0.02],
    ['user_genre_affinity_top', () => 0.41, () => 0.03],
    ['item_ctr_24h', (t) => 0.083 + 0.01 * Math.sin(t / 900), () => 0.04],
    ['item_age_days', (t) => 38 - 4 * affected(t) * 0, () => 0.03],
    ['item_duration_min', (t) => 24 + 9 * RET * affected(t), (t) => 0.02 + 0.25 * affected(t)],
    ['ctx_hour_of_day', () => 19.4, () => 0.05],
    ['ctx_device_tv', () => 0.31, () => 0.01],
  ];

  return {
    id: '010-feature-skew',
    title: 'Recommendation CTR is down 30% and nothing is broken',
    difficulty: 'hard',
    tags: ['ml serving', 'recommendations', 'training-serving skew', 'feature store', 'model monitoring', 'data quality'],
    startTime: '2026-11-20T19:00:00Z',
    duration: 3600, step: 10, seed: 1010,
    brief: {
      severity: 'SEV-2',
      alert: 'home-feed CTR < 7.6% for 5 min (business KPI alert)',
      firedAt: 2600,
      summary: `<p><b>Reel</b> is a video-streaming app. The home feed is ranked by an ML model (<b>ranker v41</b>, deployed to 100% <b>yesterday</b> after a clean A/B test). Tonight, click-through rate on recommendations fell from ~8.5% toward ~6%. That's a lot of lost engagement at prime time.</p>
        <p>Every service is green: no errors, ranker latency normal, GPUs fine. The ML team says <i>"v41 was great yesterday, the model can't have changed"</i>. The growth team started a <b>thumbnail experiment</b> tonight, and someone is sure the new thumbnails are worse. Ops mentions a CDN incident in eu-west.</p>`,
      task: '<p>Find why recommendation quality dropped without anything "breaking", prove it, and explain why the model is producing bad rankings. Propose an immediate fix and the monitoring/process that would catch this class of bug.</p>',
      questions: [
        'Which users are affected, and which aren\'t? What does that rule in/out?',
        'Is the model still calibrated (predicted vs observed CTR)? What does that tell you?',
        'What exactly is wrong with the model\'s inputs, and since when? Prove it.',
        'Rule in/out: thumbnail experiment, CDN incident, the v41 model itself.',
        'Immediate fix, and what would have caught it automatically?',
      ],
    },
    architecture: `<ul>
      <li><b>feed-api</b> → <b>feature-svc</b> (online feature store: Redis cache, <b>TTL 30 min</b>, filled by upstream pipelines) → <b>ranker</b> (GPU model server, v41) → response with 30 ranked items.</li>
      <li>v41 was trained offline on features from the <b>batch</b> pipeline (Spark, daily). Online, the same features are served from feature-svc.</li>
      <li>Features include user history (avg watch duration in seconds, sessions, genre affinity), item stats and context. New users have no history: default 0.</li>
      <li>The <b>feature-svc</b> team has been migrating feature pipelines from daily batch to real-time streaming (Flink).</li>
      <li>A feature monitor computes per-feature online stats and <b>PSI</b> (population stability index vs the training data) every minute. Nobody alerts on it yet. PSI &lt; 0.1 = stable, &gt; 0.25 = major shift.</li>
      <li>The ranker logs a WARN when an input is outside the range seen in training (logged, not enforced).</li></ul>`,
    hints: [
      'Split the KPI. Compare <code>ctr_returning_users</code> vs <code>ctr_new_users</code>, and both experiment arms. A drop in only one segment points at something that segment has and the other doesn\'t.',
      'Compare <code>ranker:pred_ctr_mean</code> with observed CTR. A model that gets <i>more</i> confident while being <i>less</i> right is being fed inputs it never saw in training. Look at the <code>features/*</code> metrics (Heatmap with "normalize each row", or <code>psi</code>).',
      'Search the logs for <code>user_avg_watch_s</code>, and check the change log around 19:25. What unit was the model trained on, and what unit does the new pipeline write?',
    ],
    topology: {
      nodes: [
        { id: 'app', kind: 'client', x: 0, y: 50 },
        { id: 'feed-api', kind: 'service', x: 20, y: 50, health: 'feed-api:error_rate', thresholds: [1, 3] },
        { id: 'feature-svc', kind: 'cache', x: 45, y: 20, health: 'feature-svc:latency_p99', thresholds: [20, 50], desc: 'online feature store (Redis, TTL 30m)' },
        { id: 'ranker', kind: 'service', x: 50, y: 70, health: 'ranker:latency_p99', thresholds: [60, 120], desc: 'GPU model server, model v41' },
        { id: 'flink', kind: 'worker', x: 75, y: 8, desc: 'streaming feature pipelines' },
        { id: 'spark-batch', kind: 'worker', x: 80, y: 40, desc: 'daily batch features + training data' },
        { id: 'cdn', kind: 'lb', x: 20, y: 92, health: 'cdn:playback_start_errors', thresholds: [1, 3] },
      ],
      edges: [
        { from: 'app', to: 'feed-api', metric: 'feed-api:rps' },
        { from: 'feed-api', to: 'feature-svc' },
        { from: 'feed-api', to: 'ranker' },
        { from: 'flink', to: 'feature-svc', async: true, label: 'streaming features' },
        { from: 'spark-batch', to: 'feature-svc', async: true, label: 'batch features' },
        { from: 'app', to: 'cdn', label: 'video' },
      ],
    },
    metrics: [
      { entity: 'feed-api/pod-{i}', instances: 12, name: 'cpu', unit: '%', fn: (t, h, i) => 44 * rps(t) / 5200 + (i === 7 ? 6 : 0) + h.noise(3) },
      { entity: 'feed-api', name: 'rps', unit: 'req/s', fn: (t, h) => rps(t) * (1 + h.noise(0.02)) },
      { entity: 'feed-api', name: 'error_rate', unit: '%', fn: (t, h) => 0.04 + Math.abs(h.noise(0.02)) },
      { entity: 'feed-api', name: 'latency_p99', unit: 'ms', fn: (t, h) => 140 + h.noise(8) },
      { entity: 'feed', name: 'ctr', unit: '%', desc: 'clicks / impressions on home feed', fn: (t, h) => 100 * ctr(t) * (1 + h.noise(0.015)) },
      { entity: 'feed', name: 'ctr_returning_users', unit: '%', fn: (t, h) => 100 * ctrRet(t) * (1 + h.noise(0.015)) },
      { entity: 'feed', name: 'ctr_new_users', unit: '%', fn: (t, h) => 100 * ctrNew() * (1 + h.noise(0.025)) },
      { entity: 'feed', name: 'session_minutes', unit: 'min', fn: (t, h) => 41 - 2.5 * RET * affected(t) + h.noise(0.6) },
      { entity: 'feed', name: 'long_form_share', unit: '%', desc: 'share of recommended items longer than 60 min', fn: (t, h) => 100 * longForm(t) * (1 + h.noise(0.02)) },
      { entity: 'experiment/thumb-v3', name: 'ctr_control', unit: '%', fn: (t, h) => 100 * ctr(t) * (1 + h.noise(0.02)) },
      { entity: 'experiment/thumb-v3', name: 'ctr_treatment', unit: '%', desc: 'only exists after the experiment starts', fn: (t, h) => (t < T_EXP ? 0 : 100 * ctr(t) * 1.004 * (1 + h.noise(0.02))) },
      { entity: 'ranker', name: 'latency_p99', unit: 'ms', fn: (t, h) => 48 + h.noise(3) },
      { entity: 'ranker', name: 'gpu_util', unit: '%', fn: (t, h) => 61 * rps(t) / 5200 + h.noise(2) },
      { entity: 'ranker', name: 'model_version', unit: '', fn: () => 41 },
      { entity: 'ranker', name: 'pred_ctr_mean', unit: '%', desc: 'mean predicted CTR of shown items', fn: (t, h) => 100 * pred(t) * (1 + h.noise(0.01)) },
      { entity: 'ranker', name: 'calibration', unit: 'ratio', desc: 'predicted / observed CTR (1.0 = calibrated)', fn: (t, h) => pred(t) / ctr(t) * (1 + h.noise(0.01)) },
      { entity: 'ranker', name: 'out_of_range_inputs', unit: '/s', desc: 'inputs outside training range', fn: (t, h) => rps(t) * RET * affected(t) * (1 + h.noise(0.03)) + Math.abs(h.noise(0.5)) },
      { entity: 'feature-svc', name: 'latency_p99', unit: 'ms', fn: (t, h) => 9 + h.noise(0.8) },
      { entity: 'feature-svc', name: 'cache_hit_ratio', unit: '%', fn: (t, h) => 97 + h.noise(0.5) },
      ...FEATURES.map(([n, mean]) => ({ entity: 'features/' + n, name: 'online_mean', unit: '', fn: (t, h) => mean(t) * (1 + h.noise(0.02)) })),
      ...FEATURES.map(([n, , psi]) => ({ entity: 'features/' + n, name: 'psi', unit: '', desc: 'population stability index vs training data', fn: (t, h) => Math.max(0, psi(t) * (1 + h.noise(0.15))) })),
      { entity: 'cdn', name: 'playback_start_errors', unit: '%', fn: (t, h) => 0.3 + (t > T_CDN && t < T_CDN + 420 ? 2.4 : 0) + h.noise(0.05) },
    ],
    dashboards: [
      { title: 'Home feed health', charts: [
        { title: 'Home feed CTR', series: ['feed:ctr'], threshold: 7.6 },
        { title: 'Requests/s', series: ['feed-api:rps'] },
        { title: 'Errors', series: ['feed-api:error_rate'] },
        { title: 'Ranker latency p99', series: ['ranker:latency_p99'] },
        { title: 'Thumbnail experiment', series: ['experiment/thumb-v3:ctr_control', 'experiment/thumb-v3:ctr_treatment'] },
        { title: 'Playback start errors', series: ['cdn:playback_start_errors'] },
      ] },
    ],
    events: [
      { t: T_EXP, kind: 'config', entity: 'feed-api', msg: 'experiment thumb-v3 (AI-generated thumbnails) started: 50/50' },
      { t: T_FEAT, kind: 'deploy', entity: 'feature-svc', msg: 'feature-svc: user watch stats now sourced from Flink job watch-stats-rt (real-time) instead of nightly Spark (FS-88)' },
      { t: T_CDN, kind: 'info', entity: 'cdn', msg: 'CDN provider: elevated playback start errors in eu-west' },
      { t: T_CDN + 420, kind: 'info', entity: 'cdn', msg: 'CDN provider: resolved' },
      { t: 2600, kind: 'alert', entity: 'feed-api', msg: 'ALERT home-feed CTR < 7.6% for 5m' },
    ],
    logs: [
      { entity: (t, h) => 'feed-api/pod-' + h.int(1, 12), level: 'INFO', rate: 1.2, msg: (t, h) => 'GET /v1/home 200 user=' + (h.chance(RET) ? 'u' + h.int(1e6, 9e6) : 'new-' + h.hex(5)) + ' items=30 ' + h.int(60, 150) + 'ms exp=thumb-v3:' + (t > T_EXP && h.chance(0.5) ? 'treatment' : 'control') },
      { entity: 'feature-svc', level: 'INFO', t: T_FEAT + 5, msg: 'source switch: user_watch_stats ← flink:watch-stats-rt (was spark:daily_user_stats). Keys refresh as cache entries expire (TTL 1800s)' },
      { entity: 'flink', level: 'INFO', t: T_FEAT - 30, msg: 'job watch-stats-rt: schema avg_watch_duration: long (source: player.heartbeat.position_ms aggregate)' },
      { entity: 'flink', level: 'INFO', rate: (t) => (t > T_FEAT - 60 ? 0.05 : 0), msg: (t, h) => 'watch-stats-rt checkpoint ok; wrote ' + h.int(20000, 60000) + ' rows; sample user=u' + h.int(1e6, 9e6) + ' avg_watch_duration=' + h.int(8000, 140000) },
      { entity: 'spark-batch', level: 'INFO', t: 60, msg: 'daily_user_stats complete: 41.2M users; avg_watch_s p50=38.1 p99=6120.4 (seconds)' },
      { entity: (t, h) => 'ranker/pod-' + h.int(1, 6), level: 'WARN', rate: (t) => 0.4 * affected(t), msg: (t, h) => 'input validation: feature user_avg_watch_s=' + h.int(8000, 140000) + '.0 outside training range [0.0, 7200.0] (not clipped) model=v41' },
      { entity: (t, h) => 'ranker/pod-' + h.int(1, 6), level: 'INFO', rate: 0.1, msg: (t, h) => 'batch infer n=' + h.int(64, 256) + ' items model=v41 gpu_ms=' + h.int(9, 22) },
      { entity: 'cdn', level: 'WARN', rate: (t) => (t > T_CDN && t < T_CDN + 420 ? 0.3 : 0), msg: (t, h) => 'eu-west edge ' + h.pick(['fra1', 'ams2', 'cdg3']) + ': origin fetch timeout for segment ' + h.hex(8) + '.m4s' },
      { entity: 'feed-api/pod-3', level: 'INFO', t: T_EXP + 2, msg: 'experiment thumb-v3 assignment enabled (hash(user) % 100 < 50)' },
    ],
    traces: [
      { name: 'GET /v1/home', rate: 0.3, fn: (t, h) => {
        const ret = h.chance(RET), bad = ret && h.chance(affected(t));
        const watch = !ret ? 0 : bad ? h.int(8000, 140000) : Math.round(h.lognormal(46, 0.8));
        return h.span('feed-api', 'GET /v1/home', 4, [
          h.span('feature-svc', 'get user + item features', h.lognormal(5, 0.3), [], { tags: { user_avg_watch_s: watch, source: bad ? 'flink:watch-stats-rt' : ret ? 'spark:daily_user_stats' : 'default', user_type: ret ? 'returning' : 'new' } }),
          h.span('ranker', 'score 500 candidates (v41)', h.lognormal(22, 0.2), [], { tags: { model: 'v41', top_item_duration_min: bad ? h.int(70, 180) : h.int(8, 50), pred_ctr_top: (bad ? 0.2 + h.noise(0.03) : 0.11 + h.noise(0.03)).toFixed(3) } }),
          h.span('feed-api', 'rerank + diversity', h.lognormal(3, 0.3)),
        ], { tags: { user_type: ret ? 'returning' : 'new' } });
      } },
    ],
  };
})());
