/* Scenario 008 — "The chatbot is slow and timing out, but traffic is normal."
 * Answer key: answers/scenarios/008-llm-serving-kv.md  (don't peek!) */
OBS.register((function () {
  const T_DEPLOY = 900, T_TENANT = 1150, T_RAMP = 1200, RAMP = 600, T_MOD = 1700;
  const R = 8, KV_CAP = 120000, PREFILL_TPS = 24000, TPOT0 = 0.028, TIMEOUT = 60;
  const BASE_PROMPT = 900, BASE_OUT = 250, BIG_PROMPT = 28300, BIG_OUT = 600;
  const baseRps = (t) => 40 + 3 * Math.sin(t / 600);
  const acmeRps = (t) => (t < T_RAMP ? 0 : 1.6 * Math.min(1, (t - T_RAMP) / RAMP));
  const rps = (t) => baseRps(t) + acmeRps(t);
  // KV demand per replica via Little's law: arrival rate × tokens held × time held
  const kvBase = (t) => (baseRps(t) / R) * (BASE_PROMPT + BASE_OUT / 2) * BASE_OUT * TPOT0;
  const kvAcme = (t) => (acmeRps(t) / R) * (BIG_PROMPT + BIG_OUT / 2) * BIG_OUT * TPOT0;
  const rho = (t) => (kvBase(t) + kvAcme(t)) / KV_CAP;
  // decode stalls: un-chunked long prefills block decode iterations on the replica
  const stallFrac = (t) => Math.min(0.6, (acmeRps(t) / R) * (BIG_PROMPT / PREFILL_TPS) * (1 + 0.8 * Math.max(0, rho(t) - 1) * 4));
  const tpotP50 = (t) => TPOT0 / (1 - stallFrac(t) * 0.5);
  const tpotP99 = (t) => (acmeRps(t) > 0.05 ? TPOT0 + (BIG_PROMPT / PREFILL_TPS) * Math.min(1, acmeRps(t) * 2) : TPOT0 * 1.6);
  // queue wait for KV admission: grows at (rho-1) s/s when overloaded, drains when not, capped by client timeout
  const WAIT = new Float64Array(3602);
  { let w = 0; for (let t = 0; t <= 3601; t++) { const r = rho(t); w = r > 1 ? w + (r - 1) * 1.15 : Math.max(0, w - (1 - r) * 4); w = Math.min(TIMEOUT, w); WAIT[t] = w; } }
  const wait = (t) => WAIT[Math.max(0, Math.min(3601, Math.round(t)))];
  const timeoutFrac = (t) => (wait(t) >= TIMEOUT - 0.5 ? Math.max(0, 1 - 1 / rho(t)) : 0);
  const ttftP50 = (t) => 0.18 + wait(t) * 0.92 + BASE_PROMPT / PREFILL_TPS;
  const ttftP99 = (t) => Math.min(TIMEOUT, 0.35 + wait(t) + (acmeRps(t) > 0.05 ? BIG_PROMPT / PREFILL_TPS + 0.9 : 0.25));
  const preemptPerMin = (t) => (rho(t) > 0.97 ? 60 * (rho(t) - 0.97) * 9 : 0);
  const moderation = (t) => (t > T_MOD && t < T_MOD + 240 ? 1 : 0);
  const TENANTS = ['consumer-app', 'consumer-app', 'consumer-app', 'help-widget', 'devportal', 'northwind', 'globex'];

  return {
    id: '008-llm-serving-kv',
    title: 'The chatbot is slow and timing out, but traffic is normal',
    difficulty: 'hard',
    tags: ['llm serving', 'gpu', 'kv cache', 'continuous batching', 'capacity planning', 'multi-tenant'],
    startTime: '2026-11-16T14:00:00Z',
    duration: 3600, step: 10, seed: 808,
    brief: {
      severity: 'SEV-2',
      alert: 'chat gateway 5xx > 2% and time-to-first-token p99 > 20 s',
      firedAt: 2500,
      summary: `<p><b>Parley</b> sells a chat assistant API (an LLM on GPUs) to consumers and businesses. Since around 14:30, answers have been <b>slow to start</b>, then text <b>stutters</b> mid-answer, and now some requests time out with <code>504</code>.</p>
        <p>The on-call engineer says: <i>"Request rate is flat, GPU utilization is the same as always (~97%), GPU memory is the same as always (~94%). Nothing looks overloaded."</i></p>
        <p>Other theories in the channel: <i>"The inference-server upgrade this afternoon broke something."</i> <i>"The moderation vendor was slow today."</i> The autoscaler (target: requests/s per replica) hasn't added replicas.</p>`,
      task: '<p>Explain what is saturated and why the usual dashboards don\'t show it. Who or what is driving it? Propose an immediate mitigation and the changes to admission, routing, autoscaling and pricing/limits so this can\'t happen again.</p>',
      questions: [
        'What resource is actually exhausted? Prove it with metrics.',
        'Why does flat request rate + flat GPU util + flat GPU memory not mean "not overloaded" for LLM serving?',
        'What changed in the workload, and when? Who is driving it?',
        'Why did TTFT rise for everyone, and why does text stutter (time per output token)?',
        'Immediate mitigation? Durable fixes (scheduler, limits, autoscaling signal, alerting)?',
      ],
    },
    architecture: `<ul>
      <li><b>chat-gateway</b>: auth, per-tenant <b>rate limits (requests/min)</b>, calls <b>moderation</b> (external) then routes round-robin to <b>8 inference replicas</b>.</li>
      <li>Each <b>llm replica</b> = one 8×H100 node serving model <code>parley-70b</code> with continuous batching (vLLM-like). GPU memory is <b>pre-allocated</b> at startup: weights + a fixed <b>KV cache pool of ~120k tokens</b> per replica.</li>
      <li>Every running request holds KV cache for its whole context (prompt + generated tokens) until it finishes. If the pool is full, new requests <b>wait</b> in the replica queue. If running requests need more, the scheduler <b>preempts</b> one (drops its KV and recomputes the prompt later).</li>
      <li>Prefill (processing the prompt) runs at ~24k tokens/s per replica and is <b>not chunked</b>: a prefill step blocks decode steps for that replica. Decode is ~28 ms per output token.</li>
      <li>Typical request: ~900 prompt tokens, ~250 output tokens. Client timeout: <b>60 s</b> to first token.</li>
      <li>The autoscaler targets 5.5 req/s per replica.</li></ul>`,
    hints: [
      'For LLM serving, "load" is measured in <b>tokens</b>, not requests. Compare <code>gateway:prompt_tokens_per_sec</code> with <code>gateway:rps</code>. Then look at a per-replica metric that isn\'t on the dashboard.',
      'Heatmap or Metrics → <code>llm/*:kv_cache_usage</code>, <code>num_waiting</code>, <code>preemptions</code>. GPU util and GPU memory are flat <i>by design</i>: why?',
      'Logs: group the gateway access log and look at <code>prompt_tokens=</code> by <code>tenant=</code>. Then check the change log right before the ramp.',
    ],
    topology: {
      nodes: [
        { id: 'clients', kind: 'client', x: 0, y: 50 },
        { id: 'chat-gateway', kind: 'lb', x: 22, y: 50, health: 'gateway:error_rate', thresholds: [1, 3] },
        { id: 'moderation', kind: 'external', x: 30, y: 12, health: 'moderation:latency_p99', thresholds: [300, 800] },
        { id: 'llm', kind: 'service', x: 60, y: 50, health: 'llm:max_kv_cache_usage', thresholds: [90, 98], desc: '8 replicas × (8×H100), continuous batching' },
        { id: 'autoscaler', kind: 'worker', x: 60, y: 90, desc: 'scales on req/s per replica' },
        { id: 'tenant-config', kind: 'storage', x: 22, y: 90, desc: 'per-tenant rate limits' },
      ],
      edges: [
        { from: 'clients', to: 'chat-gateway', metric: 'gateway:rps' },
        { from: 'chat-gateway', to: 'moderation' },
        { from: 'chat-gateway', to: 'llm', metric: 'gateway:prompt_tokens_per_sec', label: 'round-robin' },
        { from: 'autoscaler', to: 'llm', async: true },
        { from: 'tenant-config', to: 'chat-gateway', async: true },
      ],
    },
    metrics: [
      { entity: 'gateway', name: 'rps', unit: 'req/s', fn: (t, h) => rps(t) * (1 + h.noise(0.03)) },
      { entity: 'gateway', name: 'error_rate', unit: '%', desc: '5xx incl. 504 timeouts', fn: (t, h) => 100 * timeoutFrac(t) * (1 + h.noise(0.08)) + 0.05 + 0.3 * moderation(t) + Math.abs(h.noise(0.03)) },
      { entity: 'gateway', name: 'ttft_p50', unit: 's', desc: 'time to first token', fn: (t, h) => ttftP50(t) * (1 + h.noise(0.04)) + 0.05 * moderation(t) },
      { entity: 'gateway', name: 'ttft_p99', unit: 's', fn: (t, h) => ttftP99(t) * (1 + h.noise(0.03)) + 0.06 * moderation(t) },
      { entity: 'gateway', name: 'tpot_p50', unit: 'ms', desc: 'time per output token (streaming smoothness)', fn: (t, h) => 1000 * tpotP50(t) * (1 + h.noise(0.03)) },
      { entity: 'gateway', name: 'tpot_p99', unit: 'ms', fn: (t, h) => 1000 * tpotP99(t) * (1 + h.noise(0.05)) },
      { entity: 'gateway', name: 'prompt_tokens_per_sec', unit: 'tok/s', fn: (t, h) => (baseRps(t) * BASE_PROMPT + acmeRps(t) * BIG_PROMPT) * (1 + h.noise(0.04)) },
      { entity: 'gateway', name: 'output_tokens_per_sec', unit: 'tok/s', fn: (t, h) => (baseRps(t) * BASE_OUT + acmeRps(t) * BIG_OUT) * (1 - timeoutFrac(t)) * (1 + h.noise(0.04)) },
      { entity: 'gateway', name: 'avg_prompt_tokens', unit: 'tok', fn: (t, h) => (baseRps(t) * BASE_PROMPT + acmeRps(t) * BIG_PROMPT) / rps(t) * (1 + h.noise(0.05)) },
      { entity: 'moderation', name: 'latency_p99', unit: 'ms', fn: (t, h) => 120 + 380 * moderation(t) + h.noise(10) },
      { entity: 'autoscaler', name: 'replicas', unit: '', fn: () => R },
      { entity: 'autoscaler', name: 'rps_per_replica', unit: 'req/s', desc: 'scaling signal (target 5.5)', fn: (t, h) => rps(t) / R * (1 + h.noise(0.03)) },
      { entity: 'llm/replica-{i}', instances: R, name: 'gpu_util', unit: '%', desc: 'nvidia-smi "utilization": % of time any kernel was running', fn: (t, h) => 96 + h.noise(1.5) },
      { entity: 'llm/replica-{i}', instances: R, name: 'gpu_mem_used', unit: '%', fn: (t, h) => 94.1 + h.noise(0.05) },
      { entity: 'llm/replica-{i}', instances: R, name: 'kv_cache_usage', unit: '%', desc: 'share of the KV cache pool in use', fn: (t, h) => Math.min(99.6, 100 * rho(t) * (1 + h.noise(0.07))) },
      { entity: 'llm/replica-{i}', instances: R, name: 'num_running', unit: 'reqs', fn: (t, h) => Math.max(1, (baseRps(t) / R) * BASE_OUT * tpotP50(t) / Math.max(1, rho(t)) + (acmeRps(t) / R) * BIG_OUT * tpotP50(t) / Math.max(1, rho(t)) + h.noise(3)) },
      { entity: 'llm/replica-{i}', instances: R, name: 'num_waiting', unit: 'reqs', fn: (t, h) => Math.max(0, wait(t) * rps(t) / R / Math.max(1, rho(t)) * (1 + h.noise(0.1)) + (h.chance(0.1) ? 1 : 0)) },
      { entity: 'llm/replica-{i}', instances: R, name: 'preemptions', unit: '/min', fn: (t, h) => Math.max(0, preemptPerMin(t) * (1 + h.noise(0.3))) },
      { entity: 'llm/replica-{i}', instances: R, name: 'prefill_tokens_per_sec', unit: 'tok/s', desc: 'includes recomputation after preemption', fn: (t, h) => ((baseRps(t) * BASE_PROMPT + acmeRps(t) * BIG_PROMPT) / R + preemptPerMin(t) / 60 * BIG_PROMPT * 0.7) * (1 + h.noise(0.06)) },
      { entity: 'llm', name: 'max_kv_cache_usage', unit: '%', fn: (t, h) => Math.min(99.8, 100 * rho(t) * (1 + Math.abs(h.noise(0.06)))) },
    ],
    dashboards: [
      { title: 'Chat API', charts: [
        { title: 'Requests/s', series: ['gateway:rps'] },
        { title: 'Errors', series: ['gateway:error_rate'] },
        { title: 'Time to first token', series: ['gateway:ttft_p50', 'gateway:ttft_p99'] },
        { title: 'GPU utilization', series: ['llm/*:gpu_util'] },
        { title: 'GPU memory', series: ['llm/*:gpu_mem_used'] },
        { title: 'Moderation latency', series: ['moderation:latency_p99'] },
      ] },
      { title: 'Autoscaling', charts: [
        { title: 'Scaling signal (req/s per replica)', series: ['autoscaler:rps_per_replica'], threshold: 5.5 },
        { title: 'Replicas', series: ['autoscaler:replicas'] },
      ] },
    ],
    events: [
      { t: T_DEPLOY, kind: 'deploy', entity: 'llm', msg: 'inference-server 0.9.2 → 0.9.3 (CUDA graph capture for batch sizes up to 256; new default repetition_penalty=1.05)' },
      { t: T_TENANT, kind: 'config', entity: 'tenant-config', msg: 'tenant acme-legal: plan trial → enterprise, rate limit 10 → 300 req/min (Sales ticket SAL-3391)' },
      { t: T_MOD, kind: 'info', entity: 'moderation', msg: 'moderation vendor status: "degraded latency in us-east"' },
      { t: T_MOD + 240, kind: 'info', entity: 'moderation', msg: 'moderation vendor: resolved' },
      { t: 2500, kind: 'alert', entity: 'chat-gateway', msg: 'ALERT 5xx > 2% and TTFT p99 > 20s' },
    ],
    logs: [
      { entity: (t, h) => 'chat-gateway/pod-' + h.int(1, 4), level: 'INFO', rate: 1.6, msg: (t, h) => {
        const big = h.chance(acmeRps(t) / rps(t));
        const timeout = h.chance(timeoutFrac(t));
        const tenant = big ? 'acme-legal' : h.pick(TENANTS);
        const pt = big ? h.int(24000, 31800) : Math.round(h.lognormal(BASE_PROMPT, 0.6));
        if (timeout) return 'POST /v1/chat/completions 504 tenant=' + tenant + ' prompt_tokens=' + pt + ' upstream timeout after 60000ms waiting for first token replica=' + h.int(1, R);
        return 'POST /v1/chat/completions 200 tenant=' + tenant + ' prompt_tokens=' + pt + ' completion_tokens=' + (big ? h.int(400, 800) : Math.round(h.lognormal(BASE_OUT, 0.5))) + ' ttft=' + Math.round(1000 * (big ? ttftP99(t) : ttftP50(t)) * (1 + h.noise(0.2))) + 'ms replica=' + h.int(1, R);
      } },
      { entity: (t, h) => 'llm/replica-' + h.int(1, R), level: 'INFO', rate: R / 30, msg: (t, h) => 'Avg prompt throughput: ' + Math.round(((baseRps(t) * BASE_PROMPT + acmeRps(t) * BIG_PROMPT) / R) * (1 + h.noise(0.1))) + ' tokens/s, Avg generation throughput: ' + Math.round(((baseRps(t) * BASE_OUT + acmeRps(t) * BIG_OUT) / R) * (1 - timeoutFrac(t)) * (1 + h.noise(0.1))) + ' tokens/s, Running: ' + Math.round((baseRps(t) / R) * BASE_OUT * tpotP50(t) / Math.max(1, rho(t))) + ' reqs, Pending: ' + Math.round(wait(t) * rps(t) / R / Math.max(1, rho(t))) + ' reqs, GPU KV cache usage: ' + Math.min(99.6, 100 * rho(t) * (1 + h.noise(0.05))).toFixed(1) + '%' },
      { entity: (t, h) => 'llm/replica-' + h.int(1, R), level: 'WARN', rate: (t) => R * preemptPerMin(t) / 60 * 0.15, msg: (t, h) => 'Sequence group seq-' + h.hex(6) + ' is preempted by PreemptionMode.RECOMPUTE because there is not enough KV cache space. total_num_cumulative_preemption=' + Math.round(t * preemptPerMin(t) / 60) },
      { entity: (t, h) => 'llm/replica-' + h.int(1, R), level: 'INFO', t: T_DEPLOY + 40, msg: 'inference-server 0.9.3 started: model parley-70b tp=8, KV cache blocks: 7500 (120000 tokens), CUDA graphs captured for 34 batch sizes' },
      { entity: 'chat-gateway/pod-1', level: 'INFO', t: T_TENANT + 5, msg: 'tenant config reloaded: acme-legal rpm_limit=300 tpm_limit=unset' },
      { entity: (t, h) => 'chat-gateway/pod-' + h.int(1, 4), level: 'WARN', rate: (t) => moderation(t) * 0.3, msg: (t, h) => 'moderation call slow: ' + h.int(350, 700) + 'ms' },
      { entity: (t, h) => 'chat-gateway/pod-' + h.int(1, 4), level: 'INFO', rate: (t) => (t > T_RAMP + 60 ? 0.02 : 0), msg: () => 'acme-legal: batch contract-review job running (client=acme-docreview/2.4 system_prompt_hash=9c1e…)' },
      { entity: 'autoscaler', level: 'INFO', rate: 1 / 60, msg: (t, h) => 'llm: current rps/replica=' + (rps(t) / R * (1 + h.noise(0.03))).toFixed(2) + ' target=5.5 → no change (replicas=8)' },
    ],
    traces: [
      { name: 'POST /v1/chat/completions', rate: 0.3, fn: (t, h) => {
        const big = h.chance(acmeRps(t) / rps(t));
        const timedOut = h.chance(timeoutFrac(t));
        const pt = big ? h.int(24000, 31800) : Math.round(h.lognormal(BASE_PROMPT, 0.6));
        const out = big ? h.int(400, 800) : Math.round(h.lognormal(BASE_OUT, 0.5));
        const q = Math.min(TIMEOUT, wait(t) * (0.6 + h.noise(0.4) + 0.4)) * 1000;
        const mod = h.lognormal(moderation(t) ? 400 : 90, 0.3);
        const tenant = big ? 'acme-legal' : h.pick(TENANTS);
        if (timedOut) {
          return h.span('chat-gateway', 'POST /v1/chat/completions', 2, [
            h.span('moderation', 'classify prompt', mod),
            h.span('llm', 'wait for KV cache admission', TIMEOUT * 1000, [], { error: true, tags: { replica: 'replica-' + h.int(1, R) } }),
          ], { error: true, tags: { tenant, prompt_tokens: pt, status: 504 } });
        }
        const preempted = rho(t) > 1 && h.chance(big ? 0.35 : 0.04);
        const tpot = tpotP50(t) * (1 + Math.abs(h.noise(0.3)));
        const kids = [
          h.span('llm', 'queue: wait for KV cache admission', q + 2),
          h.span('llm', 'prefill ' + pt + ' tokens', pt / PREFILL_TPS * 1000 * (1 + h.noise(0.05))),
        ];
        if (preempted) {
          kids.push(h.span('llm', 'decode (partial)', out * 0.3 * tpot * 1000));
          kids.push(h.span('llm', 'PREEMPTED: requeue + recompute prefill', q * 0.3 + pt / PREFILL_TPS * 1000, [], { error: true, tags: { reason: 'KV cache full' } }));
          kids.push(h.span('llm', 'decode ' + Math.round(out * 0.7) + ' tokens', out * 0.7 * tpot * 1000));
        } else {
          kids.push(h.span('llm', 'decode ' + out + ' tokens', out * tpot * 1000, [], { tags: { tpot_ms: Math.round(tpot * 1000) } }));
        }
        return h.span('chat-gateway', 'POST /v1/chat/completions', 2, [
          h.span('moderation', 'classify prompt', mod),
          h.span('llm', 'generate', 0.5, kids, { tags: { replica: 'replica-' + h.int(1, R), prompt_tokens: pt, completion_tokens: out } }),
        ], { tags: { tenant, prompt_tokens: pt } });
      } },
    ],
  };
})());
