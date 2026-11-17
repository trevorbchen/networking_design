/* Scenario 007 — "The pretraining run got a third slower overnight."
 * Answer key: answers/scenarios/007-training-slowdown.md  (don't peek!) */
OBS.register((function () {
  const T_DL = 900, T_FLAP = 1310, FLAP_DOWN = 22, BAD = 11, HOT = 3;
  const CKPT = [600, 1800, 3000], CKPT_S = 28;
  const NODES = 16, GPUS = NODES * 8, TOKENS_PER_STEP = 4.0e6;
  // --- per-step profile model (seconds) ---
  const FWD = 0.45, BWD = 0.90, OPT = 0.15, OVERLAP_START = 0.30;
  const dataWait = (t) => (t < T_DL ? 0.035 : 0.042); // fewer workers: slightly slower, still tiny
  const busbw = (t) => (t < T_FLAP ? 380 : t < T_FLAP + FLAP_DOWN ? 60 : 180); // GB/s; ring limited by slowest rail
  const commTime = (t) => 0.82 * 380 / busbw(t); // gradient all-reduce, same bytes each step
  const exposedComm = (t) => Math.max(0, OVERLAP_START + commTime(t) - BWD);
  const ckptStall = (t) => CKPT.some((c) => t >= c && t < c + CKPT_S);
  const stepTime = (t) => dataWait(t) + FWD + BWD + exposedComm(t) + OPT;
  const effStep = (t) => (ckptStall(t) ? stepTime(t) + CKPT_S / 10 * 2 : stepTime(t)); // averaged into a 10s bucket
  const tps = (t) => (ckptStall(t) ? TOKENS_PER_STEP / stepTime(t) * 0.25 : TOKENS_PER_STEP / stepTime(t));
  const computeFrac = (t) => (FWD + BWD + OPT) / effStep(t);
  const stepNo = (t) => 41200 + Math.round(t / 2.0);
  const loss = (t, h) => 2.312 - 0.000012 * t + h.noise(0.012);

  return {
    id: '007-training-slowdown',
    title: 'The pretraining run got a third slower overnight',
    difficulty: 'medium',
    tags: ['ml training', 'gpu', 'nccl', 'all-reduce', 'infiniband', 'straggler', 'profiling'],
    startTime: '2026-11-18T02:00:00Z',
    duration: 3600, step: 10, seed: 707,
    brief: {
      severity: 'SEV-3',
      alert: 'train:tokens_per_sec < 1.7M for 10 min (run "atlas-13b-pt")',
      firedAt: 2000,
      summary: `<p>The ML platform team runs <b>atlas-13b-pt</b>, a 13B-parameter LLM pretraining job on <b>16 nodes × 8 H100 = 128 GPUs</b>. It normally does ~2.3M tokens/s at ~41% MFU. Every hour of slowdown burns ~$12k of cluster time and pushes back the release date.</p>
        <p>Overnight, throughput dropped by about a third and stayed there. Loss looks fine, and nothing crashed.</p>
        <p>Colleagues' takes: <i>"GPU utilization dropped on every node at once, so it's the input pipeline. Someone changed the dataloader config last night."</i> <i>"node-3 has been running hot all week, I bet it's thermal throttling."</i> <i>"Is the checkpointing getting slower? I see big step-time spikes."</i></p>`,
      task: '<p>Find what made training slower and prove it with the profiler/metrics. Say what you would do <b>right now</b> to recover throughput, and what should change so this is caught in minutes next time.</p>',
      questions: [
        'Which part of the training step got slower (data, compute, communication, optimizer)? Show it.',
        'Why did GPU utilization drop on all 16 nodes at once if only one thing broke?',
        'Which component is at fault, and what evidence pins it down?',
        'Rule in or out: the dataloader change, node-3 temperature, checkpoints.',
        'Immediate mitigation, and what monitoring/automation would have caught it?',
      ],
    },
    architecture: `<ul>
      <li><b>Parallelism:</b> data-parallel (FSDP) across 128 GPUs. Every step: dataloader → forward → backward → <b>gradient all-reduce (NCCL)</b> → optimizer step. All-reduce is <b>synchronous</b>: no rank can start the optimizer step until all ranks have exchanged gradients.</li>
      <li>Gradient all-reduce runs in buckets <b>overlapped with backward</b>. It only adds to step time when it takes longer than the remaining backward compute ("exposed communication").</li>
      <li><b>Network:</b> each node has <b>8 × 400 Gb/s InfiniBand NICs</b> (one per GPU, "rails" mlx5_0..mlx5_7) into a non-blocking fat tree. NCCL builds rings/trees across nodes per rail.</li>
      <li><b>Data:</b> pre-tokenized shards streamed from object storage. 8 dataloader workers per GPU (CPU) prefetch batches.</li>
      <li><b>Checkpoints:</b> every 20 min, blocking, ~28 s to the checkpoint store.</li>
      <li>The job doesn't restart on its own unless a rank crashes or NCCL times out (30 min).</li>
      <li>The <b>Traces</b> tab holds sampled per-step profiles from rank 0 (like an nsys timeline: kernels grouped into phases).</li></ul>`,
    hints: [
      'Use the profiler (Traces tab → Breakdown, compare a window before 02:20 with one after). Which phase grew? Compare it with <code>train:dataloader_wait_s</code>.',
      'Synchronous collectives make every rank as slow as the slowest link. When everyone looks the same, a heatmap of <i>network</i> health per node finds the odd one out. Try metrics that aren\'t on the dashboard.',
      'Check node-11\'s logs around 02:21, and its InfiniBand counters.',
    ],
    topology: {
      nodes: [
        { id: 'object-store', kind: 'storage', x: 0, y: 30, desc: 'tokenized training shards' },
        { id: 'dataloader', kind: 'worker', x: 20, y: 30, health: 'train:dataloader_wait_s', thresholds: [0.1, 0.3], desc: 'CPU workers on each node' },
        { id: 'gpu-nodes', kind: 'service', x: 46, y: 50, health: 'train:mfu', thresholds: [35, 28], invert: true, desc: '16 nodes × 8 H100' },
        { id: 'ib-fabric', kind: 'lb', x: 72, y: 80, health: 'nccl:allreduce_busbw', thresholds: [300, 200], invert: true, desc: 'InfiniBand fat tree, 8 rails' },
        { id: 'ckpt-store', kind: 'storage', x: 80, y: 18, health: 'ckpt:last_save_s', thresholds: [45, 90] },
        { id: 'scheduler', kind: 'service', x: 20, y: 85, desc: 'job scheduler / health checks' },
      ],
      edges: [
        { from: 'object-store', to: 'dataloader', label: 'shards' },
        { from: 'dataloader', to: 'gpu-nodes', label: 'batches' },
        { from: 'gpu-nodes', to: 'ib-fabric', metric: 'nccl:allreduce_busbw', label: 'all-reduce' },
        { from: 'gpu-nodes', to: 'ckpt-store', label: 'checkpoints', async: true },
        { from: 'scheduler', to: 'gpu-nodes', async: true },
      ],
    },
    metrics: [
      { entity: 'train', name: 'tokens_per_sec', unit: 'tok/s', fn: (t, h) => tps(t) * (1 + h.noise(0.01)) },
      { entity: 'train', name: 'step_time_s', unit: 's', fn: (t, h) => effStep(t) * (1 + h.noise(0.01)) },
      { entity: 'train', name: 'mfu', unit: '%', desc: 'model FLOPs utilization', fn: (t, h) => 41 * stepTime(0) / effStep(t) * (1 + h.noise(0.01)) },
      { entity: 'train', name: 'loss', unit: '', fn: (t, h) => loss(t, h) },
      { entity: 'train', name: 'grad_norm', unit: '', fn: (t, h) => 0.42 + h.noise(0.04) },
      { entity: 'train', name: 'dataloader_wait_s', unit: 's', desc: 'time per step the GPU waited for the next batch (profiler)', fn: (t, h) => dataWait(t) * (1 + h.noise(0.08)) },
      { entity: 'train', name: 'compute_s', unit: 's', desc: 'fwd + bwd + optimizer kernel time per step (profiler)', fn: (t, h) => (FWD + BWD + OPT) * (1 + h.noise(0.01)) },
      { entity: 'train', name: 'exposed_comm_s', unit: 's', desc: 'communication not hidden behind backward (profiler)', fn: (t, h) => exposedComm(t) * (1 + h.noise(0.04)) },
      { entity: 'nccl', name: 'allreduce_busbw', unit: 'GB/s', desc: 'NCCL bus bandwidth of gradient all-reduce', fn: (t, h) => busbw(t) * (1 + h.noise(0.02)) },
      { entity: 'ckpt', name: 'last_save_s', unit: 's', fn: (t, h) => CKPT_S + h.noise(1) },
      { entity: 'ckpt', name: 'write_bw', unit: 'B/s', fn: (t, h) => (ckptStall(t) ? 6.2e9 : 0) * (1 + h.noise(0.05)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_util', unit: '%', desc: 'mean SM-busy over the node\'s 8 GPUs', fn: (t, h) => Math.min(99, 100 * computeFrac(t) * (1 + h.noise(0.02))) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_temp_max', unit: '°C', fn: (t, h, i) => (i === HOT ? 84 : 71 + (i % 4)) - (1 - computeFrac(t)) * 6 + h.noise(0.6) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'sm_clock_min', unit: 'MHz', desc: 'lowest SM clock of the node\'s 8 GPUs (drops when throttling)', fn: (t, h) => 1980 - Math.abs(h.noise(8)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_power', unit: 'W', desc: 'mean per GPU', fn: (t, h, i) => 120 + 560 * computeFrac(t) + (i === HOT ? 10 : 0) + h.noise(8) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'cpu_util', unit: '%', desc: 'host CPU (mostly dataloader workers)', fn: (t, h) => (t < T_DL ? 34 : 27) * (stepTime(0) / stepTime(t)) + h.noise(1.5) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'host_mem_used', unit: '%', fn: (t, h) => (t < T_DL ? 71 : 64) + h.noise(0.4) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'ib_tx', unit: 'B/s', desc: 'InfiniBand transmit, all 8 rails', fn: (t, h, i) => (i === BAD && t >= T_FLAP ? 0.93 : 1) * 1.3e10 * (stepTime(0) / effStep(t)) * (1 + h.noise(0.03)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'ib_link_min_rate', unit: 'Gb/s', desc: 'slowest active rail\'s negotiated link rate', fn: (t, h, i) => (i === BAD && t >= T_FLAP ? (t < T_FLAP + FLAP_DOWN ? 0 : 100) : 400) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'ib_symbol_errors', unit: '/min', desc: 'PHY symbol errors (bad cable/optic)', fn: (t, h, i) => (i === BAD && t >= T_FLAP - 300 ? (t < T_FLAP ? 4 + h.int(0, 6) : 60 + h.int(0, 120)) : (h.chance(0.01) ? 1 : 0)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'nccl_wait_s', unit: 's', desc: 'per-step time ranks spent blocked in collectives (avg over 8 ranks)', fn: (t, h, i) => (exposedComm(t) + 0.05) * (1 + h.noise(0.05)) },
    ],
    dashboards: [
      { title: 'Training run', charts: [
        { title: 'Throughput', series: ['train:tokens_per_sec'], threshold: 1.7e6 },
        { title: 'Step time', series: ['train:step_time_s'] },
        { title: 'Loss', series: ['train:loss'] },
        { title: 'MFU', series: ['train:mfu'] },
        { title: 'GPU utilization by node', series: ['cluster/*:gpu_util'] },
        { title: 'GPU temperature (max per node)', series: ['cluster/*:gpu_temp_max'], threshold: 83 },
      ] },
      { title: 'Hosts', charts: [
        { title: 'Host CPU', series: ['cluster/*:cpu_util'] },
        { title: 'Host memory', series: ['cluster/*:host_mem_used'] },
        { title: 'Checkpoint write', series: ['ckpt:write_bw'] },
      ] },
    ],
    events: [
      { t: CKPT[0], kind: 'cron', entity: 'ckpt-store', msg: 'checkpoint step 41500 (blocking save)' },
      { t: T_DL, kind: 'config', entity: 'dataloader', msg: 'dataloader num_workers 8 → 6 per GPU (host OOM-kill on another job; reduce memory headroom risk)' },
      { t: CKPT[1], kind: 'cron', entity: 'ckpt-store', msg: 'checkpoint step 42100 (blocking save)' },
      { t: 2000, kind: 'alert', entity: 'gpu-nodes', msg: 'ALERT tokens_per_sec < 1.7M for 10m' },
      { t: 2300, kind: 'info', entity: 'scheduler', msg: 'nightly node health check: all 16 nodes PASS (GPU burn-in, DCGM diag level 1)' },
      { t: CKPT[2], kind: 'cron', entity: 'ckpt-store', msg: 'checkpoint step 42700 (blocking save)' },
    ],
    logs: [
      { entity: 'cluster/node-1', level: 'INFO', rate: 0.1, msg: (t, h) => '[rank0] step=' + stepNo(t) + ' loss=' + loss(t, h).toFixed(4) + ' tok/s=' + (tps(t) / 1e6).toFixed(2) + 'M step_time=' + effStep(t).toFixed(2) + 's mfu=' + (41 * stepTime(0) / effStep(t)).toFixed(1) + '%' },
      { entity: (t, h) => 'cluster/node-' + h.int(1, NODES), level: 'INFO', t: T_DL + 4, msg: 'dataloader: config reload num_workers=6 prefetch_factor=4 pin_memory=True' },
      { entity: (t, h) => 'cluster/node-' + h.int(1, NODES), level: 'INFO', rate: 0.25, msg: (t, h) => 'dataloader: shard ' + h.int(10000, 99999) + '.bin opened from object-store (' + h.int(180, 420) + 'ms)' },
      { entity: 'cluster/node-' + HOT, level: 'WARN', rate: 1 / 120, msg: (t, h) => 'dcgm: GPU 5 temperature ' + h.int(83, 85) + 'C above warning threshold 83C (slowdown threshold 90C)' },
      { entity: 'cluster/node-' + BAD, level: 'WARN', rate: (t) => (t > T_FLAP - 300 && t < T_FLAP ? 1 / 90 : 0), msg: (t, h) => 'mlx5_core 0000:c1:00.0: mlx5_3: symbol error counter increased by ' + h.int(3, 9) },
      { entity: 'cluster/node-' + BAD, level: 'ERROR', t: T_FLAP, msg: 'mlx5_core 0000:c1:00.0: mlx5_3: Port module event: module 3, Cable error/link down' },
      { entity: 'cluster/node-' + BAD, level: 'WARN', t: T_FLAP + 1, msg: 'NCCL WARN NET/IB : Got async event : port error (mlx5_3:1)' },
      { entity: 'cluster/node-' + BAD, level: 'INFO', t: T_FLAP + FLAP_DOWN, msg: 'mlx5_core 0000:c1:00.0: mlx5_3: Link up, port 1 ACTIVE, rate 100 Gb/sec (4X EDR)' },
      { entity: 'cluster/node-' + BAD, level: 'WARN', rate: (t) => (t > T_FLAP + FLAP_DOWN ? 1 / 60 : 0), msg: (t, h) => 'mlx5_core 0000:c1:00.0: mlx5_3: symbol error counter increased by ' + h.int(60, 180) },
      { entity: 'cluster/node-1', level: 'WARN', rate: (t) => (t > T_FLAP ? 1 / 75 : 0), msg: (t, h) => '[rank0] NCCL AllReduce bucket ' + h.int(0, 23) + ' took ' + Math.round(commTime(t) * 1000 / 24 * (1 + h.noise(0.1))) + 'ms (p50 last 24h: 34ms)' },
      { entity: 'ckpt-store', level: 'INFO', t: CKPT[0] + CKPT_S, msg: 'checkpoint 41500 saved: 168.2 GB in 27.9s' },
      { entity: 'ckpt-store', level: 'INFO', t: CKPT[1] + CKPT_S, msg: 'checkpoint 42100 saved: 168.2 GB in 28.3s' },
      { entity: 'ckpt-store', level: 'INFO', t: CKPT[2] + CKPT_S, msg: 'checkpoint 42700 saved: 168.2 GB in 27.6s' },
      { entity: (t, h) => 'cluster/node-' + h.int(1, NODES), level: 'INFO', rate: 0.05, msg: (t, h) => 'node-exporter: scrape ok (' + h.int(800, 1200) + ' series)' },
      { entity: 'scheduler', level: 'INFO', t: 2305, msg: 'healthcheck: node-1..node-16 PASS (dcgmi diag -r 1, nvidia-smi, disk, mem)' },
    ],
    traces: [
      { name: 'train step (rank 0 profile)', rate: 0.3, fn: (t, h) => {
        if (ckptStall(t)) return null;
        const j = (x) => x * 1000 * (1 + h.noise(0.015));
        const comm = commTime(t);
        const buckets = [];
        const nb = 6;
        for (let b = 0; b < nb; b++) buckets.push(h.span('nccl', 'AllReduce grad bucket ' + b, j(comm / nb), [], { gap: 1, tags: { busbw_GBps: Math.round(busbw(t)), ring: 'rails 0-7' } }));
        return h.span('trainer', 'step ' + stepNo(t), 4, [
          h.span('dataloader', 'next(batch) wait', j(dataWait(t))),
          h.span('gpu', 'forward', j(FWD), [], { tags: { kernels: 'gemm, flash_attn_fwd, layernorm' } }),
          h.span('gpu', 'backward', 1, [
            h.span('gpu', 'backward kernels', j(BWD), [], { tags: { kernels: 'gemm, flash_attn_bwd' } }),
            h.span('nccl', 'gradient all-reduce (overlapped)', 1, buckets, { gap: OVERLAP_START * 1000 }),
          ], { parallel: true }),
          h.span('gpu', 'optimizer step', j(OPT), [], { tags: { kernels: 'adamw_multi_tensor' } }),
        ], { tags: { step: stepNo(t), tokens: '4.0M' } });
      } },
    ],
  };
})());
