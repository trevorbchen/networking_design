/* Scenario 003 — The DB came back. The site didn't.
 * Answer key: answers/scenarios/003-retry-storm.md  (don't peek!) */
OBS.register((function () {
  const T_FAIL = 1500, T_DB_UP = 1545, T_SCALE = 2000, T_FIX = 2700, PER_POD = 250;
  const ramp = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));
  const users = (t) => 900 * (1 - 0.15 * ramp(t, 2050, 2200) + 0.15 * ramp(t, 2450, 2600)) + 30 * Math.sin(t / 300);
  const bad = (t) => ramp(t, T_FAIL, T_FAIL + 20) * (1 - ramp(t, T_FIX + 5, T_FIX + 80));       // 0 healthy … 1 metastable
  const dbDown = (t) => t >= T_FAIL && t < T_DB_UP;
  const clientAtt = (t) => 1 + 1.6 * bad(t);                     // mobile app: up to 3 tries, fixed 1s delay
  const apiAtt = (t) => (t >= T_FIX ? 1 : 1 + 2.8 * bad(t));     // api: up to 4 tries, no backoff, until config fix
  const pods = (t) => (t >= T_SCALE + 60 ? 12 : 8);
  const capacity = (t) => pods(t) * PER_POD;
  const offered = (t) => users(t) * clientAtt(t) * apiAtt(t);
  const completed = (t) => (dbDown(t) ? 0 : Math.min(offered(t), capacity(t) * (bad(t) > 0.5 ? 0.97 : 1)));
  const success = (t) => (dbDown(t) ? 0.01 : 1 - 0.88 * bad(t)); // fraction of user requests that succeed
  const queue = (t) => (bad(t) < 0.05 ? 3 : Math.max(0, (offered(t) - capacity(t)) * 0.9 * bad(t)));

  return {
    id: '003-retry-storm',
    title: 'The database came back. The site didn\'t.',
    difficulty: 'hard',
    tags: ['retry storm', 'metastable failure', 'load amplification', 'timeouts', 'load shedding', 'deadline propagation'],
    startTime: '2026-11-17T03:00:00Z',
    duration: 3600, step: 10, seed: 303,
    brief: {
      severity: 'SEV-1',
      alert: 'ProfileAPIAvailability: success rate < 50% (users cannot log in / load profiles)',
      firedAt: 1530,
      summary: `<p><b>Nimbus</b> is a social app. At 03:25 the primary of <code>user-db</code> failed and the DB auto-failed-over to a replica in ~45 s. That's expected and has happened before without drama.</p>
        <p>This time, the site <b>stayed down for 20 more minutes after the DB was healthy</b>. The on-call engineer first scaled up <code>profile</code> (which didn't help), then pushed a config change at 03:45, after which everything recovered within a couple of minutes. Leadership wants to know <b>why the system didn't recover on its own</b>, and whether the config change was luck.</p>`,
      task: '<p>Explain the full causal chain: <b>trigger</b> vs. <b>sustaining mechanism</b>. Quantify the load amplification. Explain why scaling didn\'t help and why the config change did. Recommend design changes so a 45-second blip stays a 45-second blip.</p>',
      questions: [
        'What was the trigger, and what kept the system broken after the trigger was gone?',
        'How much load did profile receive vs. how many real user requests there were? Where does the multiplier come from?',
        'Why didn\'t scaling profile from 8 → 12 pods fix it?',
        'profile was at 100% CPU, but users were still failing. What was all that work being spent on?',
        'What exactly did the 03:45 config change do, and why did it work?',
        'Name at least three design changes that prevent this class of failure.',
      ],
    },
    architecture: `<ul>
      <li><b>mobile</b> clients → <b>edge</b> (LB) → <b>api</b> (6 pods) → <b>profile</b> (8 pods, ~${PER_POD} req/s each) → <b>user-db</b> (PostgreSQL primary + 2 replicas).</li>
      <li>Mobile app: on error or 3s timeout, retries up to 2 more times, fixed 1s delay.</li>
      <li>api → profile client: 1000 ms timeout, <code>retries=3</code> (4 attempts), no backoff, no retry budget. Config key <code>api.profile.retries</code>.</li>
      <li>profile: thread-pool server with an unbounded request queue. It does not check whether the caller is still waiting before doing work.</li></ul>`,
    hints: [
      'Compare <code>edge:user_requests</code> with <code>profile:rps_received</code>. What\'s the ratio before 03:25, during, and after 03:45?',
      'profile is at 100% CPU, so it\'s doing <i>something</i>. Look at its queue depth, its latency compared to the api timeout, and its logs about connections closed by the client.',
      'Diff what changed at 03:45 (event log + logs at that time). Which multiplier went to 1? Why did that let the queue drain?',
    ],
    topology: {
      nodes: [
        { id: 'mobile', kind: 'client', x: 0, y: 50 },
        { id: 'edge', kind: 'lb', x: 20, y: 50, health: 'edge:success_rate', thresholds: [99, 90], invert: true },
        { id: 'api', kind: 'service', x: 42, y: 50, health: 'api:latency_p99', thresholds: [800, 2000], desc: '6 pods; profile client timeout 1000ms, retries=3' },
        { id: 'profile', kind: 'service', x: 66, y: 50, health: 'profile:cpu_avg', thresholds: [75, 92], desc: 'thread pool + unbounded queue; ~250 req/s per pod' },
        { id: 'user-db', kind: 'db', x: 90, y: 50, health: 'user-db:qps', thresholds: [100, 10], invert: true, desc: 'PostgreSQL; health = queries/s being served' },
      ],
      edges: [
        { from: 'mobile', to: 'edge', metric: 'edge:rps' },
        { from: 'edge', to: 'api', metric: 'edge:rps' },
        { from: 'api', to: 'profile', metric: 'profile:rps_received', thresholds: [2500, 5000] },
        { from: 'profile', to: 'user-db', metric: 'user-db:qps' },
      ],
    },
    metrics: [
      { entity: 'edge', name: 'user_requests', unit: 'req/s', desc: 'distinct user actions (deduplicated by request-id)', fn: (t, h) => users(t) * (1 + h.noise(0.02)) },
      { entity: 'edge', name: 'rps', unit: 'req/s', desc: 'HTTP requests arriving at the edge, including client retries', fn: (t, h) => users(t) * clientAtt(t) * (1 + h.noise(0.03)) },
      { entity: 'edge', name: 'success_rate', unit: '%', desc: '% of user actions that eventually succeeded', fn: (t, h) => Math.min(100, 100 * success(t) * (1 + h.noise(0.01)) - (bad(t) < 0.02 ? Math.abs(h.noise(0.05)) : 0)) },
      { entity: 'api', name: 'latency_p99', unit: 'ms', fn: (t, h) => (bad(t) < 0.05 ? 60 + h.noise(6) : Math.min(4100, 60 + 3900 * bad(t) + h.noise(80))) + (t > T_FIX && t < T_FIX + 120 ? 200 : 0) },
      { entity: 'api', name: 'profile_attempts', unit: 'req/s', desc: 'calls api makes to profile, including retries', fn: (t, h) => offered(t) * (1 + h.noise(0.03)) },
      { entity: 'api', name: 'profile_retries', unit: 'req/s', fn: (t, h) => Math.max(0, offered(t) - users(t) * clientAtt(t)) * (1 + h.noise(0.03)) },
      { entity: 'api', name: 'profile_timeouts', unit: 'req/s', desc: 'profile calls abandoned after 1000ms', fn: (t, h) => (bad(t) < 0.02 ? Math.abs(h.noise(0.5)) : offered(t) * (0.92 * bad(t)) * (1 + h.noise(0.04))) },
      { entity: 'api/pod-{i}', instances: 6, name: 'cpu', unit: '%', fn: (t, h, i) => 22 + offered(t) * 0.0035 + h.noise(3) },
      { entity: 'profile', name: 'rps_received', unit: 'req/s', fn: (t, h) => offered(t) * (1 + h.noise(0.03)) },
      { entity: 'profile', name: 'rps_completed', unit: 'req/s', desc: 'requests profile finished processing (whether or not anyone was still waiting)', fn: (t, h) => completed(t) * (1 + h.noise(0.02)) },
      { entity: 'profile', name: 'responses_to_closed_conn', unit: 'req/s', desc: 'finished requests whose caller had already timed out', fn: (t, h) => completed(t) * Math.min(0.97, 0.9 * bad(t)) * (1 + h.noise(0.04)) },
      { entity: 'profile', name: 'queue_depth', unit: 'reqs', fn: (t, h) => queue(t) * (1 + h.noise(0.05)) + (dbDown(t) ? 4000 * ramp(t, T_FAIL, T_DB_UP) : 0) },
      { entity: 'profile', name: 'latency_p99', unit: 'ms', desc: 'server-side, includes time spent queued', fn: (t, h) => (bad(t) < 0.05 ? 38 + h.noise(4) : dbDown(t) ? 5000 + h.noise(200) : 40 + 8500 * bad(t) * (1 + h.noise(0.06))) },
      { entity: 'profile', name: 'pods', unit: '', fn: (t) => pods(t) },
      { entity: 'profile/pod-{i}', instances: 12, name: 'cpu', unit: '%', fn: (t, h, i) => (i > 8 && pods(t) < 12 ? 0 : (dbDown(t) ? 8 : Math.min(99.5, 100 * completed(t) / capacity(t) * 0.92 + 4)) + h.noise(2)) },
      { entity: 'profile', name: 'cpu_avg', unit: '%', fn: (t, h) => (dbDown(t) ? 8 : Math.min(99.5, 100 * completed(t) / capacity(t) * 0.92 + 4)) + h.noise(1) },
      { entity: 'user-db', name: 'qps', unit: 'q/s', fn: (t, h) => completed(t) * 1.2 * (1 + h.noise(0.03)) },
      { entity: 'user-db', name: 'cpu', unit: '%', fn: (t, h) => (dbDown(t) ? 3 : 14 + completed(t) * 0.012) + h.noise(2) },
      { entity: 'user-db', name: 'connections', unit: 'conn', fn: (t, h) => (dbDown(t) ? 0 : 96 + (pods(t) - 8) * 12 + h.int(0, 4)) },
      { entity: 'user-db', name: 'query_latency_p99', unit: 'ms', fn: (t, h) => (dbDown(t) ? 0 : 6 + completed(t) * 0.0015 + h.noise(0.8)) },
    ],
    dashboards: [
      { title: 'Availability', charts: [
        { title: 'User success rate', series: ['edge:success_rate'] },
        { title: 'Edge traffic', series: ['edge:rps', 'edge:user_requests'] },
        { title: 'api p99', series: ['api:latency_p99'] },
        { title: 'profile CPU per pod', series: ['profile/*:cpu'] },
        { title: 'user-db QPS', series: ['user-db:qps'] },
        { title: 'user-db CPU', series: ['user-db:cpu'] },
      ] },
    ],
    events: [
      { t: T_FAIL, kind: 'failover', entity: 'user-db', msg: 'primary user-db-1 unreachable (EBS volume stall); starting automatic failover' },
      { t: T_DB_UP, kind: 'failover', entity: 'user-db', msg: 'user-db-2 promoted to primary; accepting writes' },
      { t: 1530, kind: 'alert', entity: 'edge', msg: 'ProfileAPIAvailability fired' },
      { t: T_SCALE, kind: 'scale', entity: 'profile', msg: 'on-call: scaled profile 8 → 12 pods' },
      { t: 2300, kind: 'cron', entity: 'user-db', msg: 'nightly logical backup started on replica user-db-3' },
      { t: T_FIX, kind: 'config', entity: 'api', msg: 'on-call: api.profile.retries 3 → 0; profile.shed_queue_age_ms unset → 500' },
    ],
    logs: [
      { entity: (t, h) => 'api/pod-' + h.int(1, 6), level: 'INFO', rate: 1, msg: (t, h) => 'GET /v1/profile/' + h.int(1e6, 9e6) + ' ' + (h.chance(success(t)) ? '200' : '503') + ' ' + h.int(20, 90) + 'ms' },
      { entity: 'user-db', level: 'FATAL', t: T_FAIL + 1, msg: 'could not write to file "pg_wal/000000010000A2F1": I/O timeout' },
      { entity: 'user-db', level: 'INFO', t: T_DB_UP - 2, msg: 'user-db-2: received promote request; selected new timeline ID: 7' },
      { entity: 'user-db', level: 'INFO', t: T_DB_UP, msg: 'database system is ready to accept connections' },
      { entity: (t, h) => 'profile/pod-' + h.int(1, 8), level: 'ERROR', rate: (t) => (dbDown(t) ? 4 : 0), msg: 'org.postgresql.util.PSQLException: Connection to user-db:5432 refused' },
      { entity: (t, h) => 'api/pod-' + h.int(1, 6), level: 'WARN', rate: (t) => (t < T_FIX ? 3 * bad(t) : 0), msg: (t, h) => 'profile call timed out after 1000ms; retrying (attempt ' + h.int(2, 4) + '/4) request_id=' + h.hex(12) },
      { entity: (t, h) => 'api/pod-' + h.int(1, 6), level: 'ERROR', rate: (t) => 1 * bad(t), msg: (t, h) => 'profile unavailable after 4 attempts; returning 503 request_id=' + h.hex(12) },
      { entity: (t, h) => 'profile/pod-' + h.int(1, pods(t)), level: 'WARN', rate: (t) => (dbDown(t) ? 0 : 2.5 * bad(t)), msg: (t, h) => 'write response failed: broken pipe (client closed connection); request age ' + (3 + h.rand() * 6).toFixed(1) + 's, queued ' + (2.5 + h.rand() * 6).toFixed(1) + 's' },
      { entity: (t, h) => 'profile/pod-' + h.int(1, pods(t)), level: 'WARN', rate: (t) => (t > T_FIX && t < T_FIX + 90 ? 4 : 0), msg: (t, h) => 'load shed: rejected request queued ' + h.int(500, 9000) + 'ms > 500ms' },
      { entity: (t, h) => 'mobile', level: 'WARN', rate: (t) => 0.8 * bad(t), msg: (t, h) => 'client telemetry: request failed (timeout 3s), retry ' + h.int(1, 2) + '/2 after 1000ms' },
      { entity: (t, h) => 'profile/pod-' + h.int(9, 12), level: 'INFO', t: T_SCALE + 55, msg: 'profile started; thread pool 64, queue unbounded' },
      { entity: 'user-db', level: 'INFO', t: 2302, msg: 'pg_dump started on user-db-3' },
    ],
    traces: [
      { name: 'GET /v1/profile', rate: 0.18, fn: (t, h) => {
        const b = bad(t);
        const nApi = t >= T_FIX ? 1 : (b > 0.1 ? h.int(2, 4) : 1);
        const attempts = [];
        for (let k = 1; k <= nApi; k++) {
          const last = k === nApi;
          const ok = last && (dbDown(t) ? false : h.chance(Math.min(1, success(t) / 0.9)));
          if (ok) attempts.push(h.span('profile', 'getProfile (attempt ' + k + ')', b > 0.1 ? h.int(200, 900) : h.lognormal(8, 0.3), [h.span('user-db', 'SELECT users', h.lognormal(2, 0.3))], { tags: { attempt: k } }));
          else attempts.push(h.span('profile', 'getProfile (attempt ' + k + ')', 1000, [], { error: true, tags: { attempt: k, error: 'timeout 1000ms (profile kept working on it)' } }));
        }
        const okAll = !attempts[attempts.length - 1].error;
        return h.span('edge', 'GET /v1/profile', 0.5, [h.span('api', 'ProfileHandler', 1, attempts, { error: !okAll })], { error: !okAll, tags: { status: okAll ? 200 : 503 } });
      } },
    ],
  };
})());
