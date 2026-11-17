/* Scenario 011 — "The new dataset made training 35% slower."
 * Answer key: answers/scenarios/011-dataloader-bound.md  (don't peek!) */
OBS.register((function () {
  const NODES = 16, T_RESTART = 1200, DOWN = 75, T_STORE = 1850, STORE_DUR = 600;
  const COMPUTE = 0.92, OPT = 0.06, IMGS_PER_NODE = 2048, WORKERS = 28; // 8 GPUs × 256 images, 28 dataloader procs per node (32 cores)
  const msPerImg = (t) => (t < T_RESTART ? 0.45 : 20.5); // preprocessed tensor shards vs raw ~2 MP JPEG decode+resize+augment
  const dataTime = (t) => IMGS_PER_NODE * msPerImg(t) / 1000 / WORKERS; // seconds of CPU wall time per step per node
  const down = (t) => t >= T_RESTART && t < T_RESTART + DOWN;
  const stepTime = (t) => Math.max(COMPUTE, dataTime(t)) + OPT + 0.01;
  const dlWait = (t) => Math.max(0, dataTime(t) - COMPUTE) + 0.004;
  const imgPerSec = (t) => (down(t) ? 0 : NODES * IMGS_PER_NODE / stepTime(t));
  const cpu = (t) => (down(t) ? 6 : Math.min(99, 8 + 88 * dataTime(t) / stepTime(t) * WORKERS / 28 + 4));
  const store = (t) => t > T_STORE && t < T_STORE + STORE_DUR;
  const bytesPerImg = (t) => (t < T_RESTART ? 150e3 : 410e3);
  const loss = (t, h) => (t < T_RESTART ? 1.214 - 0.00001 * t : 1.262 - 0.000012 * (t - T_RESTART)) + h.noise(0.008);

  return {
    id: '011-dataloader-bound',
    title: 'The new dataset made training 35% slower',
    difficulty: 'medium',
    tags: ['ml training', 'gpu', 'dataloader', 'input pipeline', 'cpu bound', 'profiling', 'USE method'],
    startTime: '2026-11-21T10:00:00Z',
    duration: 3600, step: 10, seed: 1111,
    brief: {
      severity: 'SEV-3',
      alert: 'train:images_per_sec < 30k for 15 min (run "lumen-vit-g")',
      firedAt: 2300,
      summary: `<p><b>lumen-vit-g</b> trains a 2B-parameter vision encoder on <b>16 nodes × 8 A100 = 128 GPUs</b>. At 10:20 the job was restarted to switch to <b>dataset v5</b> (a new 1.8B-image collection) and a new learning-rate schedule. Throughput dropped from ~33k to ~21k images/s.</p>
        <p>Colleagues: <i>"v5 is in the new object-store bucket, and storage had a maintenance window today. It's the storage."</i> <i>"The new LR schedule can't change speed... right?"</i> <i>"GPU utilization is down to ~60%, so the GPUs are fine, it must be something upstream."</i></p>`,
      task: '<p>Find the bottleneck, prove it with the profiler and resource metrics, and estimate how much faster training would be if you fixed it. Propose a quick mitigation and a durable fix.</p>',
      questions: [
        'Which part of the step got slower? Show the profiler evidence.',
        'Which resource is saturated? Use USE (utilization, saturation, errors) on the hosts.',
        'Is storage the bottleneck? Prove it either way with numbers.',
        'What specifically about dataset v5 caused it?',
        'Quick mitigation, durable fix, and the expected speedup.',
      ],
    },
    architecture: `<ul>
      <li>Each node: 8 × A100, <b>32 CPU cores</b>, 1 TB RAM, 2×200 Gb/s network. The dataloader runs <b>28 worker processes per node</b> (CPU) that read samples, decode, resize to 224×224, augment (random crop, color jitter), and collate batches into a prefetch queue (depth 4) feeding the GPUs.</li>
      <li>Per step: 256 images per GPU = <b>2,048 images per node</b>. GPU forward+backward ≈ 0.92 s per step.</li>
      <li><b>Dataset v4</b> (until 10:20): WebDataset shards of <b>pre-resized 256 px images</b>, ~150 KB each.</li>
      <li><b>Dataset v5</b>: WebDataset shards of <b>original JPEGs</b> as crawled (median ~2 MP, ~410 KB). "Preprocessing to be added later" (ticket DATA-512).</li>
      <li>Data is streamed from object storage, which can serve ≥ 40 GB/s to this cluster.</li>
      <li>Traces hold sampled per-step profiles from rank 0 (an nsys-style timeline grouped into phases).</li></ul>`,
    hints: [
      'Traces → Breakdown: compare steps before and after 10:20. Which phase grew? Does GPU compute time change?',
      'USE on the hosts: look at the per-node <code>cpu_util</code> and <code>dl_queue_depth</code> (prefetch queue). Then compare <code>objstore</code> throughput with what the job actually needs (images/s × bytes/image).',
      'Search worker logs for per-sample timings. How many pixels does a v5 image have vs a v4 image, and where is that work done?',
    ],
    topology: {
      nodes: [
        { id: 'objstore', kind: 'storage', x: 0, y: 40, health: 'objstore:latency_p99', thresholds: [200, 500], desc: 'S3-compatible object store' },
        { id: 'dataloader', kind: 'worker', x: 30, y: 40, health: 'train:dataloader_wait_s', thresholds: [0.05, 0.2], desc: '28 CPU worker procs per node' },
        { id: 'gpu-nodes', kind: 'service', x: 62, y: 40, health: 'train:mfu', thresholds: [40, 30], invert: true, desc: '16 nodes × 8 A100' },
        { id: 'ib-fabric', kind: 'lb', x: 70, y: 85 },
        { id: 'ckpt-store', kind: 'storage', x: 92, y: 12 },
      ],
      edges: [
        { from: 'objstore', to: 'dataloader', metric: 'objstore:read_bytes', label: 'shards' },
        { from: 'dataloader', to: 'gpu-nodes', metric: 'train:images_per_sec', label: 'batches' },
        { from: 'gpu-nodes', to: 'ib-fabric', label: 'all-reduce' },
        { from: 'gpu-nodes', to: 'ckpt-store', async: true },
      ],
    },
    metrics: [
      { entity: 'cluster/node-{i}', instances: NODES, name: 'net_rx', unit: 'B/s', fn: (t, h) => (imgPerSec(t) / NODES) * bytesPerImg(t) * (1 + h.noise(0.05)) + 2e8 },
      { entity: 'train', name: 'images_per_sec', unit: 'img/s', fn: (t, h) => imgPerSec(t) * (1 + h.noise(0.01)) },
      { entity: 'train', name: 'step_time_s', unit: 's', fn: (t, h) => (down(t) ? 0 : stepTime(t) * (1 + h.noise(0.015))) },
      { entity: 'train', name: 'mfu', unit: '%', fn: (t, h) => (down(t) ? 0 : 47 * stepTime(0) / stepTime(t) * (1 + h.noise(0.01))) },
      { entity: 'train', name: 'loss', unit: '', fn: (t, h) => (down(t) ? loss(T_RESTART + DOWN, h) : loss(t, h)) },
      { entity: 'train', name: 'learning_rate', unit: '', fn: (t) => (t < T_RESTART ? 2.0e-4 : 3.0e-4 * Math.min(1, (t - T_RESTART) / 900)) },
      { entity: 'train', name: 'dataloader_wait_s', unit: 's', desc: 'per step: GPU idle waiting for the next batch (profiler)', fn: (t, h) => (down(t) ? 0 : dlWait(t) * (1 + h.noise(0.06))) },
      { entity: 'train', name: 'compute_s', unit: 's', desc: 'per step: fwd+bwd kernel time (profiler)', fn: (t, h) => (down(t) ? 0 : COMPUTE * (1 + h.noise(0.01))) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_util', unit: '%', fn: (t, h) => (down(t) ? 0 : Math.min(99, 100 * (COMPUTE + 0.04) / stepTime(t) * (1 + h.noise(0.03)))) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'cpu_util', unit: '%', desc: 'all 32 cores', fn: (t, h) => cpu(t) * (1 + h.noise(0.01)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'cpu_iowait', unit: '%', fn: (t, h) => 0.6 + (store(t) ? 0.5 : 0) + Math.abs(h.noise(0.3)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'load_avg', unit: '', desc: '1-min load average (runnable procs; 32 cores)', fn: (t, h) => (down(t) ? 1 : t < T_RESTART ? 9 : 31.5) + h.noise(1) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'dl_queue_depth', unit: 'batches', desc: 'prefetched batches ready (max 4)', fn: (t, h) => (down(t) ? 0 : t < T_RESTART ? 4 - (h.chance(0.05) ? 1 : 0) : (h.chance(0.12) ? 1 : 0)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'host_mem_used', unit: '%', fn: (t, h) => (t < T_RESTART ? 38 : 44) + h.noise(0.3) },
      { entity: 'objstore', name: 'read_bytes', unit: 'B/s', desc: 'served to this job', fn: (t, h) => imgPerSec(t) * bytesPerImg(t) * (1 + h.noise(0.04)) },
      { entity: 'objstore', name: 'latency_p99', unit: 'ms', desc: 'GET of a 1 GB shard chunk (first byte)', fn: (t, h) => (store(t) ? 210 : 140) + h.noise(10) },
      { entity: 'objstore', name: 'capacity_bytes', unit: 'B/s', desc: 'max throughput available to this cluster', fn: (t) => (store(t) ? 3.2e10 : 4.2e10) },
      { entity: 'objstore', name: 'error_rate', unit: '%', fn: (t, h) => 0.01 + (store(t) ? 0.04 : 0) + Math.abs(h.noise(0.005)) },
    ],
    dashboards: [
      { title: 'Training run', charts: [
        { title: 'Images/s', series: ['train:images_per_sec'], threshold: 30000 },
        { title: 'Step time', series: ['train:step_time_s'] },
        { title: 'GPU utilization', series: ['cluster/*:gpu_util'] },
        { title: 'Loss', series: ['train:loss'] },
        { title: 'Object store p99 latency', series: ['objstore:latency_p99'] },
        { title: 'Learning rate', series: ['train:learning_rate'] },
      ] },
    ],
    events: [
      { t: T_RESTART, kind: 'deploy', entity: 'gpu-nodes', msg: 'job restarted: dataset v4 → v5 (gs://lumen-data-v5, raw JPEG shards); LR schedule: warmup 900s to 3e-4, cosine' },
      { t: T_STORE, kind: 'info', entity: 'objstore', msg: 'storage maintenance: rebalancing 2 of 24 storage nodes (capacity −25%, latency +50%)' },
      { t: T_STORE + STORE_DUR, kind: 'info', entity: 'objstore', msg: 'storage maintenance complete' },
      { t: 2300, kind: 'alert', entity: 'gpu-nodes', msg: 'ALERT images/s < 30k for 15m' },
    ],
    logs: [
      { entity: 'cluster/node-1', level: 'INFO', rate: (t) => (down(t) ? 0 : 0.1), msg: (t, h) => '[rank0] step=' + Math.round(t / 1.4 + 52000) + ' loss=' + loss(t, h).toFixed(4) + ' img/s=' + Math.round(imgPerSec(t)) + ' step_time=' + stepTime(t).toFixed(2) + 's data_wait=' + dlWait(t).toFixed(2) + 's' },
      { entity: 'cluster/node-1', level: 'INFO', t: T_RESTART + DOWN - 5, msg: '[rank0] dataset v5: 1.81B samples, 7 412 shards, decode=PIL(jpeg) resize=224 aug=[RandomResizedCrop, ColorJitter], num_workers=28 prefetch=4' },
      { entity: (t, h) => 'cluster/node-' + h.int(1, NODES), level: 'INFO', rate: (t) => (down(t) ? 0 : 0.25), msg: (t, h) => {
        const w = h.int(0, 27);
        if (t < T_RESTART) return 'dl-worker-' + w + ': batch ready in ' + Math.round(73 * msPerImg(t) * (1 + h.noise(0.2))) + 'ms (read ' + h.int(3, 9) + 'ms, decode ' + Math.round(73 * 0.3) + 'ms, aug ' + Math.round(73 * 0.12) + 'ms)';
        const px = (h.lognormal(2.1, 0.4)).toFixed(1);
        return 'dl-worker-' + w + ': batch ready in ' + Math.round(73 * msPerImg(t) * (1 + h.noise(0.2))) + 'ms (read ' + h.int(4, 12) + 'ms, decode ' + Math.round(73 * 13 * (1 + h.noise(0.2))) + 'ms, resize ' + Math.round(73 * 5.5) + 'ms, aug ' + Math.round(73 * 1.6) + 'ms) median_src=' + px + 'MP';
      } },
      { entity: (t, h) => 'cluster/node-' + h.int(1, NODES), level: 'WARN', rate: (t) => (t > T_RESTART + DOWN ? 0.05 : 0), msg: () => 'torch.utils.data: prefetch queue empty; trainer blocked waiting for batch' },
      { entity: 'objstore', level: 'WARN', rate: (t) => (store(t) ? 0.1 : 0), msg: (t, h) => 'rebalance: moving placement group ' + h.int(100, 999) + ' (' + h.int(2, 9) + ' GB)' },
      { entity: (t, h) => 'cluster/node-' + h.int(1, NODES), level: 'INFO', rate: 0.05, msg: (t, h) => 'node-exporter: scrape ok (' + h.int(800, 1200) + ' series)' },
    ],
    traces: [
      { name: 'train step (rank 0 profile)', rate: 0.28, fn: (t, h) => {
        if (down(t)) return null;
        const j = (x) => x * 1000 * (1 + h.noise(0.02));
        return h.span('trainer', 'step', 2, [
          h.span('dataloader', 'next(batch): wait for prefetch queue', j(dlWait(t)), [], { tags: { queue_depth: t < T_RESTART ? 4 : 0 } }),
          h.span('gpu', 'H2D copy (pinned)', j(0.012)),
          h.span('gpu', 'forward', j(COMPUTE / 3)),
          h.span('gpu', 'backward + overlapped all-reduce', j(COMPUTE * 2 / 3)),
          h.span('gpu', 'optimizer step', j(OPT)),
        ], { tags: { dataset: t < T_RESTART ? 'v4' : 'v5' } });
      } },
    ],
  };
})());
