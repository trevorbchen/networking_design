/* Scenario 012 — "The run keeps crashing with NCCL timeouts and makes no progress."
 * Answer key: answers/scenarios/012-checkpoint-hang.md  (don't peek!) */
OBS.register((function () {
  const NODES = 64, RANKS = 512, T_SYNC = 300, T_DRV = 180, CKPT_EVERY = 900, TIMEOUT = 600;
  const CKPT_GB = 168, STEP_S = 2.0, S0 = 120000, LAST_GOOD = S0 - 225; // last good checkpoint written at t = -450
  const fsTrainBw = (t) => (t < T_SYNC ? 4.0 : 0.24); // GB/s the checkpoint writer gets from /shared
  // ---- job state machine: run → (ckpt at +900) → hang (rank 0 still writing) → watchdog kills at +600 → restart → load → run
  const phases = []; // {from, to, kind, step0}
  {
    let t = 0, step = S0, nextCkpt = 450;
    while (t < 3700) {
      phases.push({ from: t, to: nextCkpt, kind: 'run', step0: step });
      step += (nextCkpt - t) / STEP_S; t = nextCkpt;
      const saveS = CKPT_GB / fsTrainBw(t);
      if (saveS < TIMEOUT) { phases.push({ from: t, to: t + saveS, kind: 'ckpt', step0: step }); t += saveS; nextCkpt = t + CKPT_EVERY; continue; }
      phases.push({ from: t, to: t + TIMEOUT, kind: 'hang', step0: step, ckptStep: step });
      t += TIMEOUT;
      phases.push({ from: t, to: t + 120, kind: 'restart', step0: LAST_GOOD });
      t += 120;
      const loadS = CKPT_GB / (t < T_SYNC ? 6 : 0.8);
      phases.push({ from: t, to: t + loadS, kind: 'load', step0: LAST_GOOD });
      t += loadS;
      phases.push({ from: t, to: t + 35, kind: 'nccl-init', step0: LAST_GOOD });
      t += 35; step = LAST_GOOD; nextCkpt = t + CKPT_EVERY;
    }
  }
  const ph = (t) => phases.find((p) => t >= p.from && t < p.to) || phases[phases.length - 1];
  const kind = (t) => ph(t).kind;
  const step = (t) => { const p = ph(t); return Math.round(p.kind === 'run' ? p.step0 + (t - p.from) / STEP_S : p.step0); };
  const training = (t) => kind(t) === 'run';
  const hangs = phases.filter((p) => p.kind === 'hang' && p.from < 3600);
  const restarts = phases.filter((p) => p.kind === 'restart' && p.from < 3600);
  const ckptBytes = (t) => { const p = ph(t); return p.kind === 'hang' || p.kind === 'ckpt' ? Math.min(CKPT_GB, (t - p.from) * fsTrainBw(t)) * 1e9 : 0; };
  const syncOn = (t) => t >= T_SYNC;

  return {
    id: '012-checkpoint-hang',
    title: 'The run keeps crashing with NCCL timeouts and makes no progress',
    difficulty: 'hard',
    tags: ['ml training', 'nccl', 'checkpointing', 'shared filesystem', 'goodput', 'timeouts', 'gpu'],
    startTime: '2026-11-22T22:00:00Z',
    duration: 3600, step: 10, seed: 1212,
    brief: {
      severity: 'SEV-2',
      alert: 'job orca-65b restarted 2× in 1h (NCCL watchdog timeout)',
      firedAt: 3000,
      summary: `<p><b>orca-65b</b> is a 65B LLM pretraining run on <b>64 nodes × 8 H100 = 512 GPUs</b> (~$25k/day). Tonight it has crashed twice with <code>Watchdog caught collective operation timeout</code> on hundreds of ranks. It restarts automatically from the last checkpoint. The step counter on the dashboard <b>keeps going backwards</b>.</p>
        <p>Colleagues: <i>"NCCL timeouts = network. Get the fabric team."</i> <i>"The GPU driver canary went out on node-21..24 tonight, I bet one of those GPUs is hanging."</i> <i>"node-12 has been logging ECC errors."</i> <i>"While it was hung, GPU utilization was 100% everywhere, so the GPUs were busy?"</i></p>`,
      task: '<p>Find what makes the job hang, why it then crashes, and why it makes no net progress. Prove it. Recommend what to do tonight and how to make the training stack robust to this.</p>',
      questions: [
        'What is the job doing in the ~10 minutes before each crash? Which rank is different?',
        'Why do the crashes happen exactly when they do (timing relative to what)?',
        'What is slowing that rank down, and since when?',
        'Why is net progress zero? What is the run\'s goodput tonight?',
        'Rule in/out: network, driver canary, node-12 ECC, "GPUs were 100% busy".',
        'Immediate actions and durable fixes (checkpointing design, timeouts, shared-FS isolation).',
      ],
    },
    architecture: `<ul>
      <li>FSDP training, 512 ranks (rank 0 is on node-1). Step ≈ 2.0 s.</li>
      <li><b>Checkpointing:</b> every 15 min of training. FSDP gathers a <b>full (unsharded) state dict to rank 0</b>, and rank 0 writes it (~168 GB) to the shared filesystem <code>/shared</code> (Lustre). Meanwhile all other ranks continue into the next step and block in its first collective until rank 0 joins. Normally the save takes ~40 s.</li>
      <li>The NCCL watchdog kills the process if any collective waits longer than <b>10 min</b> (<code>NCCL_TIMEOUT=600</code>). The launcher then restarts the whole job: reschedule (~2 min), load the last checkpoint from <code>/shared</code>, NCCL init.</li>
      <li><code>/shared</code> is used by every team: datasets, checkpoints, home directories. One metadata server (MDS) handles all opens/stats/creates.</li>
      <li>"GPU utilization" counts any running kernel, including NCCL kernels busy-waiting for peers.</li></ul>`,
    hints: [
      'Line up the timeline: when does each hang start relative to the checkpoint schedule, and how long does each last? Then look at rank 0 (node-1) vs everyone else.',
      'GPU <b>power</b> tells you more than GPU utilization during a hang. And check <code>ckpt:write_bw</code> and the <code>sharedfs</code> metrics: who else is using /shared?',
      'Search logs for <code>checkpoint write progress</code> and for <code>mds0</code>. What started at 22:05?',
    ],
    topology: {
      nodes: [
        { id: 'scheduler', kind: 'service', x: 8, y: 15, desc: 'job launcher / requeue' },
        { id: 'gpu-nodes', kind: 'service', x: 40, y: 45, health: 'train:tokens_per_sec', thresholds: [1.5e6, 5e5], invert: true, desc: '64 nodes × 8 H100' },
        { id: 'ib-fabric', kind: 'lb', x: 40, y: 88, health: 'fabric:link_errors', thresholds: [5, 50] },
        { id: 'sharedfs', kind: 'storage', x: 78, y: 45, health: 'sharedfs:mds_cpu', thresholds: [80, 95], desc: 'Lustre /shared (1 MDS, 48 OSTs)' },
        { id: 'data-sync', kind: 'worker', x: 92, y: 88, desc: 'data-platform dataset mirroring' },
      ],
      edges: [
        { from: 'scheduler', to: 'gpu-nodes', async: true },
        { from: 'gpu-nodes', to: 'ib-fabric', label: 'collectives' },
        { from: 'gpu-nodes', to: 'sharedfs', metric: 'ckpt:write_bw', label: 'checkpoints' },
        { from: 'data-sync', to: 'sharedfs', metric: 'sharedfs:mds_ops', label: 'rsync' },
      ],
    },
    metrics: [
      { entity: 'cluster/node-{i}', instances: NODES, name: 'ib_tx', unit: 'B/s', fn: (t, h) => (training(t) ? 2.2e10 : kind(t) === 'nccl-init' ? 3e9 : 1e6) * (1 + h.noise(0.03)) },
      { entity: 'train', name: 'global_step', unit: '', zero: false, fn: (t) => step(t) },
      { entity: 'train', name: 'tokens_per_sec', unit: 'tok/s', fn: (t, h) => (training(t) ? 2.05e6 * (1 + h.noise(0.01)) : 0) },
      { entity: 'train', name: 'ranks_alive', unit: '', fn: (t) => (['restart', 'load'].includes(kind(t)) ? (kind(t) === 'load' ? RANKS : 0) : RANKS) },
      { entity: 'train', name: 'loss', unit: '', fn: (t, h) => 1.71 - (step(t) - S0) * 0.00002 + h.noise(0.006) },
      { entity: 'ckpt', name: 'write_bw', unit: 'B/s', desc: 'checkpoint bytes/s written by rank 0', fn: (t, h) => (kind(t) === 'hang' || kind(t) === 'ckpt' ? fsTrainBw(t) * 1e9 * (1 + h.noise(0.1)) : 0) },
      { entity: 'ckpt', name: 'bytes_written', unit: 'B', desc: 'progress of the checkpoint in flight', fn: (t) => ckptBytes(t) },
      { entity: 'ckpt', name: 'load_bw', unit: 'B/s', fn: (t, h) => (kind(t) === 'load' ? 0.8e9 * (1 + h.noise(0.1)) : 0) },
      { entity: 'sharedfs', name: 'mds_ops', unit: 'ops/s', desc: 'metadata ops (open/stat/create/unlink) across all clients', fn: (t, h) => (syncOn(t) ? 1.9e6 : 4.2e4) * (1 + h.noise(0.05)) },
      { entity: 'sharedfs', name: 'mds_cpu', unit: '%', fn: (t, h) => (syncOn(t) ? 98 : 22) + h.noise(1.5) },
      { entity: 'sharedfs', name: 'op_latency_p99', unit: 'ms', desc: 'metadata + small-IO latency seen by clients', fn: (t, h) => (syncOn(t) ? 2400 : 18) * (1 + h.noise(0.1)) },
      { entity: 'sharedfs', name: 'write_bw_total', unit: 'B/s', fn: (t, h) => ((syncOn(t) ? 1.1e9 : 0.2e9) + (kind(t) === 'hang' || kind(t) === 'ckpt' ? fsTrainBw(t) * 1e9 : 0)) * (1 + h.noise(0.05)) },
      { entity: 'sharedfs/client-{i}', instances: ['orca-65b', 'data-sync-01', 'home-dirs', 'eval-jobs'], name: 'mds_ops', unit: 'ops/s', fn: (t, h, i) => (i === 'data-sync-01' ? (syncOn(t) ? 1.75e6 : 0) : i === 'orca-65b' ? (kind(t) === 'load' ? 9000 : 400) : i === 'home-dirs' ? 22000 : 18000) * (1 + h.noise(0.05)) },
      { entity: 'fabric', name: 'link_errors', unit: '/min', fn: (t, h) => (h.chance(0.02) ? 1 : 0) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_util', unit: '%', desc: 'nvidia-smi utilization (any kernel running)', fn: (t, h, i) => {
        const k = kind(t);
        if (k === 'run') return 96 + h.noise(1.5);
        if (k === 'hang' || k === 'ckpt') return i === 1 ? 87.5 + h.noise(1) : 100 - Math.abs(h.noise(0.5)); // rank 0's GPU idles while its CPU writes
        if (k === 'nccl-init') return 10 + h.noise(3);
        return 0;
      } },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_power', unit: 'W', desc: 'mean per GPU', fn: (t, h, i) => {
        const k = kind(t);
        if (k === 'run') return 640 + h.noise(15);
        if (k === 'hang' || k === 'ckpt') return (i === 1 ? 104 : 118) + h.noise(4);
        return 75 + h.noise(3);
      } },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'host_cpu', unit: '%', fn: (t, h, i) => (kind(t) === 'hang' && i === 1 ? 9 : 6) + (training(t) ? 14 : 0) + h.noise(1.5) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'ecc_corrected', unit: '/min', fn: (t, h, i) => (i === 12 ? h.int(0, 3) : 0) },
    ],
    dashboards: [
      { title: 'Training run', charts: [
        { title: 'Global step', series: ['train:global_step'] },
        { title: 'Tokens/s', series: ['train:tokens_per_sec'] },
        { title: 'GPU utilization', series: ['cluster/*:gpu_util'] },
        { title: 'Loss', series: ['train:loss'] },
        { title: 'Fabric link errors', series: ['fabric:link_errors'] },
        { title: 'ECC corrected errors', series: ['cluster/*:ecc_corrected'] },
      ] },
    ],
    events: [
      { t: T_DRV, kind: 'deploy', entity: 'gpu-nodes', msg: 'GPU driver 550.90 → 560.35 canary on node-21..24 (live, no reboot needed for this job)' },
      { t: T_SYNC, kind: 'cron', entity: 'data-sync', msg: 'data-platform: nightly mirror job sync-laion-5b started (rsync → /shared/datasets/laion, ~410M files)' },
      ...hangs.map((p) => ({ t: p.from, kind: 'cron', entity: 'gpu-nodes', msg: 'scheduled checkpoint at step ' + Math.round(p.ckptStep) })),
      ...restarts.map((p, k) => ({ t: p.from, kind: 'failover', entity: 'scheduler', msg: 'job orca-65b failed (NCCL watchdog); auto-restart ' + (k + 1) + '/5 from step_' + LAST_GOOD })),
      { t: 3000, kind: 'alert', entity: 'scheduler', msg: 'ALERT job restarted 2× in 1h' },
    ],
    logs: [
      { entity: 'cluster/node-1', level: 'INFO', rate: (t) => (training(t) ? 0.1 : 0), msg: (t, h) => '[rank0] step=' + step(t) + ' loss=' + (1.71 - (step(t) - S0) * 0.00002 + h.noise(0.006)).toFixed(4) + ' tok/s=2.05M' },
      ...phases.filter((p) => p.kind === 'hang' || p.kind === 'ckpt').map((p) => ({ entity: 'cluster/node-1', level: 'INFO', t: p.from + 2, msg: '[rank0] saving checkpoint step_' + Math.round(p.step0) + ' → /shared/ckpt/orca-65b/ (FULL_STATE_DICT, 168 GB, rank 0 writer)' })),
      { entity: 'cluster/node-1', level: 'INFO', rate: (t) => (kind(t) === 'hang' ? 1 / 60 : 0), msg: (t) => '[rank0] checkpoint write progress ' + (ckptBytes(t) / 1e9).toFixed(1) + '/168.0 GB (' + Math.round(fsTrainBw(t) * 1000) + ' MB/s), elapsed ' + Math.round(t - ph(t).from) + 's' },
      ...hangs.map((p) => ({ entity: (t, h) => 'cluster/node-' + h.int(2, NODES), level: 'ERROR', rate: (t) => (t >= p.to - 1 && t < p.to + 6 ? 4 : 0), msg: (t, h) => '[rank ' + h.int(8, 511) + '] Watchdog caught collective operation timeout: WorkNCCL(SeqNum=' + (88812 + Math.round(p.from)) + ', OpType=ALLGATHER, NumelIn=4194304, Timeout(ms)=600000) ran for 600' + h.int(10, 99) + ' milliseconds before timing out.' })),
      ...hangs.map((p) => ({ entity: 'cluster/node-1', level: 'ERROR', t: p.to + 3, msg: '[rank0] terminated by launcher while in torch.save() (written ' + (Math.min(CKPT_GB, TIMEOUT * fsTrainBw(p.from))).toFixed(1) + '/168.0 GB); partial checkpoint left in /shared/ckpt/orca-65b/step_' + Math.round(p.ckptStep) + '.tmp' })),
      ...restarts.map((p) => ({ entity: 'scheduler', level: 'WARN', t: p.from + 5, msg: 'torchrun: worker group failed (exitcode -6 on 511/512 ranks); restarting all workers (attempt ' + (restarts.indexOf(p) + 1) + '/5)' })),
      ...phases.filter((p) => p.kind === 'load').map((p) => ({ entity: 'cluster/node-1', level: 'INFO', t: p.from + 1, msg: '[rank0] loading checkpoint step_' + LAST_GOOD + ' (latest complete) from /shared; incomplete step_*.tmp ignored' })),
      ...phases.filter((p) => p.kind === 'load').map((p) => ({ entity: 'cluster/node-1', level: 'WARN', t: p.to - 1, msg: '[rank0] checkpoint load took ' + Math.round(p.to - p.from) + 's (usual: 30s)' })),
      { entity: 'sharedfs', level: 'WARN', rate: (t) => (syncOn(t) ? 1 / 45 : 0), msg: (t, h) => 'mds0: high load ' + (1.8 + h.noise(0.1)).toFixed(2) + 'M ops/s; top client 10.4.2.17 (data-sync-01) ' + h.int(88, 94) + '% of ops; request queue depth ' + h.int(4000, 9000) },
      { entity: 'data-sync', level: 'INFO', rate: (t) => (syncOn(t) ? 1 / 60 : 0), msg: (t, h) => 'sync-laion-5b: rsync -a --delete --checksum ... checked ' + Math.round((t - T_SYNC) * 1.75e6 / 1e6) + 'M/410M files' },
      { entity: (t, h) => 'cluster/node-' + h.int(21, 24), level: 'INFO', t: T_DRV + 30, msg: 'nvidia: driver 560.35.03 loaded (canary); persistence mode on; all 8 GPUs healthy' },
      { entity: 'cluster/node-12', level: 'WARN', rate: 1 / 150, msg: (t, h) => 'dcgm: GPU 3 single-bit ECC corrected (' + h.int(1, 3) + '), no row remap pending' },
    ],
    traces: [
      { name: 'train step (rank 0 profile)', rate: 0.2, fn: (t, h) => (training(t) ? h.span('trainer', 'step ' + step(t), 3, [
        h.span('gpu', 'forward + backward', 1720 * (1 + h.noise(0.01))),
        h.span('nccl', 'reduce-scatter (exposed)', 150 * (1 + h.noise(0.05))),
        h.span('gpu', 'optimizer', 120),
      ]) : null) },
      { name: 'checkpoint save (rank 0)', rate: 0.03, fn: (t, h) => {
        const p = ph(t);
        if (!(p.kind === 'hang' || p.kind === 'ckpt') || t - p.from > 30) return null;
        const write = Math.min(CKPT_GB / fsTrainBw(t), TIMEOUT) * 1000;
        return h.span('trainer', 'save_checkpoint step_' + Math.round(p.step0), 2, [
          h.span('nccl', 'FSDP gather full state dict → rank 0', 9000 * (1 + h.noise(0.05))),
          h.span('sharedfs', 'open/create shard files (MDS)', syncOn(t) ? 41000 : 300),
          h.span('sharedfs', 'torch.save → /shared (168 GB)', write, [], { error: write >= TIMEOUT * 1000, tags: { throughput_MBps: Math.round(fsTrainBw(t) * 1000), killed: write >= TIMEOUT * 1000 } }),
        ], { error: write >= TIMEOUT * 1000, tags: { peers: '511 ranks blocked in next ALLGATHER' } });
      } },
    ],
  };
})());
