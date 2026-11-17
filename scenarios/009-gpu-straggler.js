/* Scenario 009 — "Step time keeps jumping between 2.0 s and 3.2 s."
 * Answer key: answers/scenarios/009-gpu-straggler.md  (don't peek!) */
OBS.register((function () {
  const NODES = 32, BAD = 23, BAD_GPU = 6, BAD_RANK = (BAD - 1) * 8 + BAD_GPU, WARM = 9;
  const T_NCCL = 300, T_FAN = 1120, T_MIX = 1800, CYCLE = 240, HOT_PHASE = 150;
  const TOK = 8.4e6;
  const COMPUTE = 1.62, COMM_EXPOSED = 0.18, DATA = 0.03, OPT = 0.17;
  // thermal sawtooth on node-23 GPU 6 after its fan dies: heats for 150 s, throttles (HW slowdown) for 90 s while cooling
  const phase = (t) => (t - T_FAN) % CYCLE;
  const throttled = (t) => t >= T_FAN + 60 && phase(t - 60) >= HOT_PHASE;
  const badTemp = (t) => {
    if (t < T_FAN) return 71;
    if (t < T_FAN + 60) return 71 + (t - T_FAN) / 60 * 8;
    const p = phase(t - 60);
    return p < HOT_PHASE ? 79 + 9.5 * p / HOT_PHASE : 88.5 - 9.5 * (p - HOT_PHASE) / (CYCLE - HOT_PHASE);
  };
  const badClock = (t) => (throttled(t) ? 1110 : 1980);
  const slow = (t) => (throttled(t) ? 1980 / 1110 : 1); // compute slowdown factor for that one rank
  const stepTime = (t) => DATA + COMPUTE * slow(t) + COMM_EXPOSED + OPT;
  const waitOthers = (t) => COMM_EXPOSED + COMPUTE * (slow(t) - 1); // everyone else idles in the all-reduce
  const stepNo = (t) => 88000 + Math.round(t / 2.1);
  const loss = (t, h) => 1.982 - 0.00001 * t + (t > T_MIX ? 0.015 : 0) + h.noise(0.01);

  return {
    id: '009-gpu-straggler',
    title: 'Training step time keeps jumping between 2.0 s and 3.2 s',
    difficulty: 'hard',
    tags: ['ml training', 'gpu', 'straggler', 'thermal throttling', 'nccl', 'heatmap'],
    startTime: '2026-11-19T03:00:00Z',
    duration: 3600, step: 10, seed: 909,
    brief: {
      severity: 'SEV-3',
      alert: 'train:step_time_s p90 > 2.6 s (run "orion-34b-pt")',
      firedAt: 2150,
      summary: `<p><b>orion-34b-pt</b> is a 34B LLM pretraining run on <b>32 nodes × 8 H100 = 256 GPUs</b>. The job was restarted from a checkpoint at 03:05 with the new <b>NCCL 2.21</b> (the platform team's upgrade).</p>
        <p>Since some time after 03:15, step time has become <b>erratic</b>. Most steps take ~2.0 s, but for stretches of a minute or so it jumps to ~3.2 s, then recovers, again and again. Average throughput is down ~15%.</p>
        <p>Colleagues: <i>"The profiler on rank 0 says the extra time is in the all-reduce. It's the NCCL upgrade, roll it back."</i> <i>"We also switched the data mixture at 03:30, longer sequences maybe?"</i> <i>"node-9 is always the hottest node, check it."</i></p>`,
      task: '<p>Find the cause of the periodic slowdowns and prove it. Explain why rank 0\'s profiler blames communication. Recommend an immediate action and how to detect this automatically.</p>',
      questions: [
        'What is the period/shape of the slowdown, and what does that suggest?',
        'Why does rank 0\'s profile show extra time in the all-reduce? Is the network/NCCL actually slower?',
        'Which exact device is responsible, and how do you know? (Which metric singles it out, and which one points the *opposite* way?)',
        'Rule in/out: NCCL upgrade, data-mixture change, node-9.',
        'Immediate mitigation and long-term detection/automation.',
      ],
    },
    architecture: `<ul>
      <li>FSDP data-parallel over 256 ranks (rank = (node−1)×8 + gpu). Each step: data → forward/backward (compute) → gradient reduce-scatter/all-gather (NCCL, mostly overlapped) → optimizer. <b>Collectives are synchronous</b>: a collective completes only when the last rank joins.</li>
      <li>The per-step profile in <b>Traces</b> is from <b>rank 0</b> only. Time a rank spends waiting for others to join a collective shows up as time "inside" the NCCL kernel.</li>
      <li>Per-node metrics aggregate the node's 8 GPUs: <code>*_max</code> / <code>*_min</code> are across the 8. <code>compute_s_max</code> = slowest local rank's forward+backward kernel time. <code>nccl_wait_min_s</code> = the least time any of the node&#39;s 8 ranks spent blocked in collectives per step.</li>
      <li>GPUs slow their clocks automatically when too hot (≥ 88 °C here: "HW/thermal slowdown") and recover once cooled.</li>
      <li>Node BMC (IPMI) events and DCGM health messages are shipped to the logs.</li></ul>`,
    hints: [
      'Zoom into a slow stretch and a fast one. A regular on/off rhythm usually means a <b>control loop</b> (a thermostat, a throttle, a rate limiter, a GC), not a software bug.',
      'Rank 0 waiting inside NCCL means "someone else was late". Heatmap <code>compute_s_max</code> and <code>nccl_wait_min_s</code> across all 32 nodes: the culprit is the one node that <i>doesn\'t</i> wait.',
      'Then look at that node\'s <code>sm_clock_min</code> and <code>gpu_temp_max</code>, and search its logs for IPMI/fan/clock events around 03:18.',
    ],
    topology: {
      nodes: [
        { id: 'data', kind: 'storage', x: 0, y: 30, desc: 'tokenized shards' },
        { id: 'gpu-nodes', kind: 'service', x: 40, y: 45, health: 'train:mfu', thresholds: [40, 33], invert: true, desc: '32 nodes × 8 H100' },
        { id: 'ib-fabric', kind: 'lb', x: 72, y: 78, health: 'fabric:link_errors', thresholds: [5, 50], desc: 'InfiniBand, 8 rails/node' },
        { id: 'ckpt-store', kind: 'storage', x: 80, y: 15 },
        { id: 'dc-facilities', kind: 'external', x: 10, y: 85, desc: 'power/cooling, BMC (IPMI) events' },
      ],
      edges: [
        { from: 'data', to: 'gpu-nodes', label: 'batches' },
        { from: 'gpu-nodes', to: 'ib-fabric', label: 'collectives' },
        { from: 'gpu-nodes', to: 'ckpt-store', async: true },
        { from: 'dc-facilities', to: 'gpu-nodes', async: true, label: 'cooling' },
      ],
    },
    metrics: [
      { entity: 'train', name: 'tokens_per_sec', unit: 'tok/s', fn: (t, h) => TOK / stepTime(t) * (1 + h.noise(0.01)) },
      { entity: 'train', name: 'step_time_s', unit: 's', fn: (t, h) => stepTime(t) * (1 + h.noise(0.01)) },
      { entity: 'train', name: 'mfu', unit: '%', fn: (t, h) => 46 * stepTime(0) / stepTime(t) * (1 + h.noise(0.01)) },
      { entity: 'train', name: 'loss', unit: '', fn: (t, h) => loss(t, h) },
      { entity: 'train', name: 'avg_seq_len', unit: 'tok', desc: 'mean packed document length (sequences are always packed to 8192)', fn: (t, h) => (t < T_MIX ? 2900 : 3600) + h.noise(80) },
      { entity: 'profiler/rank0', name: 'compute_s', unit: 's', desc: 'rank 0 fwd+bwd kernel time', fn: (t, h) => COMPUTE * (1 + h.noise(0.01)) },
      { entity: 'profiler/rank0', name: 'nccl_s', unit: 's', desc: 'rank 0 time inside NCCL kernels not overlapped with compute', fn: (t, h) => waitOthers(t) * (1 + h.noise(0.03)) },
      { entity: 'profiler/rank0', name: 'dataloader_s', unit: 's', fn: (t, h) => DATA * (1 + h.noise(0.1)) },
      { entity: 'nccl', name: 'reduce_scatter_algbw', unit: 'GB/s', desc: 'derived from collective duration on rank 0 (includes waiting for late ranks)', fn: (t, h) => 310 * COMM_EXPOSED / (COMM_EXPOSED + waitOthers(t) - COMM_EXPOSED + 0.0001) * (throttled(t) ? 0.95 : 1) * (1 + h.noise(0.02)) },
      { entity: 'fabric', name: 'link_errors', unit: '/min', fn: (t, h) => (h.chance(0.02) ? 1 : 0) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'ib_tx', unit: 'B/s', fn: (t, h) => 2.4e10 * stepTime(0) / stepTime(t) * (1 + h.noise(0.03)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_util', unit: '%', fn: (t, h, i) => Math.min(99, 100 * (i === BAD ? COMPUTE * slow(t) : COMPUTE) / stepTime(t) * (1 + h.noise(0.02))) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_temp_max', unit: '°C', fn: (t, h, i) => (i === BAD ? Math.max(badTemp(t), 72) : i === WARM ? 85 : 72 + (i % 5)) + h.noise(0.4) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'sm_clock_min', unit: 'MHz', desc: 'lowest SM clock among the node\'s 8 GPUs', fn: (t, h, i) => (i === BAD ? badClock(t) : 1980) - Math.abs(h.noise(6)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_power_min', unit: 'W', fn: (t, h, i) => (i === BAD && throttled(t) ? 390 : 610 * COMPUTE / stepTime(t) + 80) + h.noise(10) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'compute_s_max', unit: 's', desc: 'slowest local rank\'s fwd+bwd time per step', fn: (t, h, i) => (i === BAD ? COMPUTE * slow(t) : COMPUTE) * (1 + Math.abs(h.noise(0.012))) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'nccl_wait_min_s', unit: 's', desc: 'least time any of the node\'s 8 ranks spent blocked in collectives per step', fn: (t, h, i) => (i === BAD ? COMM_EXPOSED : waitOthers(t)) * (1 + h.noise(0.04)) },
    ],
    dashboards: [
      { title: 'Training run', charts: [
        { title: 'Step time', series: ['train:step_time_s'], threshold: 2.6 },
        { title: 'Throughput', series: ['train:tokens_per_sec'] },
        { title: 'Rank 0 profile (s/step)', series: ['profiler/rank0:compute_s', 'profiler/rank0:nccl_s', 'profiler/rank0:dataloader_s'] },
        { title: 'NCCL reduce-scatter bandwidth (rank 0)', series: ['nccl:reduce_scatter_algbw'] },
        { title: 'Loss', series: ['train:loss'] },
        { title: 'GPU temperature (hottest per node)', series: ['cluster/*:gpu_temp_max'], threshold: 88 },
      ] },
    ],
    events: [
      { t: T_NCCL, kind: 'deploy', entity: 'gpu-nodes', msg: 'job restarted from checkpoint step 87850 with NCCL 2.19.3 → 2.21.5 (platform upgrade)' },
      { t: T_MIX, kind: 'config', entity: 'data', msg: 'data mixture v13 → v14 (more code + long documents); still packed to 8192 tokens' },
      { t: 2150, kind: 'alert', entity: 'gpu-nodes', msg: 'ALERT step_time p90 > 2.6s' },
      { t: 2700, kind: 'info', entity: 'ib-fabric', msg: 'network team: "fabric is clean: no link errors, no congestion counters, all ports 400G"' },
    ],
    logs: [
      { entity: 'cluster/node-1', level: 'INFO', rate: 0.1, msg: (t, h) => '[rank0] step=' + stepNo(t) + ' loss=' + loss(t, h).toFixed(4) + ' step_time=' + stepTime(t).toFixed(2) + 's tok/s=' + (TOK / stepTime(t) / 1e6).toFixed(2) + 'M' },
      { entity: (t, h) => 'cluster/node-' + h.int(1, NODES), level: 'INFO', t: T_NCCL + 20, msg: 'NCCL INFO NCCL version 2.21.5+cuda12.4; NET/IB : Using [0]mlx5_0:1/IB ... [7]mlx5_7:1/IB; comm 0x7f3a nRanks 256 nNodes 32' },
      { entity: 'cluster/node-1', level: 'WARN', rate: (t) => (throttled(t) ? 1 / 30 : 0), msg: (t, h) => '[rank0] slow step ' + stepNo(t) + ': reduce_scatter took ' + Math.round(waitOthers(t) * 1000) + 'ms (median 180ms)' },
      { entity: 'cluster/node-' + BAD, level: 'ERROR', t: T_FAN, msg: 'ipmi-sel: Fan FAN6 (GPU bay 3) | Lower Critical going low | Reading 0 RPM < Threshold 1200 RPM' },
      { entity: 'cluster/node-' + BAD, level: 'WARN', t: T_FAN + 2, msg: 'ipmi-sel: Fan redundancy lost (FAN6)' },
      { entity: 'cluster/node-' + BAD, level: 'WARN', rate: (t) => (t > T_FAN && phase(t - 60) >= HOT_PHASE && phase(t - 60) < HOT_PHASE + 10 ? 0.1 : 0), msg: () => 'dcgm: GPU ' + BAD_GPU + ' clocks event reasons: HW_SLOWDOWN, HW_THERMAL_SLOWDOWN active (temp 88C)' },
      { entity: 'cluster/node-' + BAD, level: 'INFO', rate: (t) => (t > T_FAN + 60 && phase(t - 60) < 10 ? 0.1 : 0), msg: () => 'dcgm: GPU ' + BAD_GPU + ' clocks event reasons cleared (temp 79C)' },
      { entity: 'cluster/node-' + WARM, level: 'WARN', rate: 1 / 180, msg: (t, h) => 'dcgm: GPU 2 temperature ' + h.int(84, 86) + 'C (warning ≥ 83C, slowdown ≥ 88C)' },
      { entity: (t, h) => 'cluster/node-' + h.int(1, NODES), level: 'INFO', t: T_MIX + 3, msg: 'dataloader: mixture v14 loaded (sources: web 52%, code 22%, books 9%, papers 9%, math 8%)' },
      { entity: (t, h) => 'cluster/node-' + h.int(1, NODES), level: 'INFO', rate: 0.08, msg: (t, h) => 'node-exporter: scrape ok (' + h.int(900, 1300) + ' series)' },
    ],
    traces: [
      { name: 'train step (rank 0 profile)', rate: 0.28, fn: (t, h) => {
        const j = (x) => x * 1000 * (1 + h.noise(0.015));
        const late = throttled(t);
        return h.span('trainer', 'step ' + stepNo(t), 3, [
          h.span('dataloader', 'next(batch)', j(DATA)),
          h.span('gpu', 'forward + backward', j(COMPUTE), [], { tags: { kernels: 'gemm, flash_attn, fsdp prefetch' } }),
          h.span('nccl', 'ReduceScatter (grads, non-overlapped tail)', j(waitOthers(t)), [], { tags: late ? { last_rank_to_join: BAD_RANK, rank0_wait_ms: Math.round((waitOthers(t) - COMM_EXPOSED) * 1000), wire_time_ms: Math.round(COMM_EXPOSED * 1000) } : { last_rank_to_join: h.int(0, 255), wire_time_ms: Math.round(COMM_EXPOSED * 1000) } }),
          h.span('gpu', 'optimizer step', j(OPT)),
        ], { tags: { step: stepNo(t) } });
      } },
    ],
  };
})());
