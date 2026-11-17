/* Scenario 014 — "The MoE run gets slower every hour."
 * Answer key: answers/scenarios/014-moe-imbalance.md  (don't peek!) */
OBS.register((function () {
  const NODES = 8, EXPERTS = 64, T_CFG = 240, T_MIX = 1500, T_FW = 900;
  const HOT = [13, 41]; // experts the router collapses onto
  const gpuOf = (e) => ({ node: Math.floor(e / 8) + 1, gpu: e % 8 }); // EP=64: one expert per GPU
  // max/mean expert load: balanced ~1.15; after aux-loss coefficient is cut 10×, router collapse grows over training
  const imb = (t) => (t < T_CFG ? 1.15 : 1.15 + 2.6 * (1 - Math.exp(-(t - T_CFG) / 1500)) + (t > T_MIX ? 0.25 * Math.min(1, (t - T_MIX) / 600) : 0));
  const hotShare = (t) => imb(t) / EXPERTS; // share of routed tokens for each hot expert
  const DENSE = 0.78, MOE = 0.52, A2A = 0.21, OPT = 0.12;
  const stepTime = (t) => DENSE + MOE * imb(t) / 1.15 + A2A * (1 + 0.35 * (imb(t) - 1.15)) + OPT;
  const expertLoad = (e, t) => {
    const hot = HOT.includes(e);
    if (hot) return hotShare(t);
    const rest = (1 - HOT.length * hotShare(t)) / (EXPERTS - HOT.length);
    return rest * (1 + 0.12 * Math.sin(e * 1.7));
  };
  const auxLoss = (t) => 0.0101 * (1 + 0.9 * (imb(t) - 1.15));
  const entropy = (t) => 5.95 - 0.55 * (imb(t) - 1.15); // bits; log2(64)=6 is perfectly uniform
  const stepNo = (t) => 30400 + Math.round(t / 2.1);
  const loss = (t, h) => 2.181 - 0.000011 * t + 0.004 * Math.max(0, imb(t) - 1.15) + (t > T_MIX ? 0.01 : 0) + h.noise(0.008);
  const TOK = 4.2e6;
  const nodeHot = (i) => HOT.some((e) => gpuOf(e).node === i);

  return {
    id: '014-moe-imbalance',
    title: 'The MoE run gets slower every hour',
    difficulty: 'hard',
    tags: ['ml training', 'mixture of experts', 'expert parallelism', 'all-to-all', 'load balancing', 'gpu'],
    startTime: '2026-11-24T08:00:00Z',
    duration: 3600, step: 10, seed: 1414,
    heatmapDefault: 'gpu_temp_max',
    brief: {
      severity: 'SEV-3',
      alert: 'train:tokens_per_sec −40% vs 24h baseline (run "hydra-moe-8x")',
      firedAt: 2100,
      summary: `<p><b>hydra-moe</b> is a Mixture-of-Experts LLM: 64 experts per MoE layer, top-2 routing, trained with <b>expert parallelism over 64 H100s</b> (8 nodes; one expert per GPU). At 08:04 it was restarted from a checkpoint with a batch of config changes from the research team (PR #4412).</p>
        <p>Since then, step time has been <b>creeping up</b>: not a step change, a steady climb. Loss is slightly worse than the forecast.</p>
        <p>Colleagues: <i>"All-to-all time is way up in the profile. The switch firmware upgrade at 08:15 broke something."</i> <i>"We added more code data at 08:25, and code sequences are expensive."</i> <i>"node-2 and node-6 GPUs are pegged and the rest aren't. Bad nodes? Swap them."</i></p>`,
      task: '<p>Explain why the run keeps getting slower, why only two nodes look busy, and why all-to-all time grew. Recommend a fix, and what to monitor in MoE training.</p>',
      questions: [
        'What is the shape of the slowdown (step, ramp, periodic), and what kind of cause does it suggest?',
        'Why are node-2 and node-6 hot? Would swapping them help?',
        'Why does all-to-all get slower if the network is fine?',
        'What in the 08:04 restart caused it? Show the mechanism with router metrics.',
        'Rule in/out: switch firmware, code data mixture, bad nodes. Fix and monitoring?',
      ],
    },
    architecture: `<ul>
      <li>Each MoE layer has a <b>router</b> that sends every token to its top-2 of 64 experts. With <b>expert parallelism</b>, expert <i>e</i> lives on GPU <i>e mod 8</i> of node <i>⌊e/8⌋+1</i>: experts 0–7 on node-1, 8–15 on node-2, ... 56–63 on node-8.</li>
      <li>Each MoE layer does an <b>all-to-all</b> to ship tokens to their experts' GPUs, runs the experts, then another all-to-all back. It's <b>dropless</b>: every routed token is processed, so a popular expert simply does more work. Everyone waits for the slowest GPU in the all-to-all.</li>
      <li>Load balance is encouraged by an <b>auxiliary load-balancing loss</b> (coefficient <code>moe.aux_loss_coeff</code>) that penalizes uneven routing. Without it, routers tend to "collapse" onto a few experts that then get trained more and look even better.</li>
      <li>Profiler buckets per step: dense (attention etc.), expert compute (on the slowest GPU), all-to-all (including waiting), optimizer.</li></ul>`,
    hints: [
      'A slow, smooth ramp that started at a restart smells like something the <i>model is learning</i>, not hardware. Look at the <code>router</code> metrics.',
      'Heatmap <code>moe/*:token_share</code> (one row per expert). Which experts are hot, and which GPUs host them? Compare with <code>cluster/*:expert_compute_s</code>.',
      'Search logs for <code>aux_loss_coeff</code> and <code>expert load</code>. What did PR #4412 change?',
    ],
    topology: {
      nodes: [
        { id: 'data', kind: 'storage', x: 0, y: 40 },
        { id: 'router', kind: 'lb', x: 28, y: 40, health: 'router:load_imbalance', thresholds: [1.5, 2.5], desc: 'top-2 gating, per MoE layer' },
        { id: 'experts', kind: 'service', x: 58, y: 40, health: 'train:mfu', thresholds: [35, 25], invert: true, desc: '64 experts, one per GPU (8 nodes)' },
        { id: 'ib-fabric', kind: 'lb', x: 58, y: 88, health: 'fabric:link_errors', thresholds: [5, 50], desc: 'all-to-all traffic' },
        { id: 'ckpt-store', kind: 'storage', x: 90, y: 15 },
      ],
      edges: [
        { from: 'data', to: 'router', label: 'tokens' },
        { from: 'router', to: 'experts', label: 'all-to-all dispatch' },
        { from: 'experts', to: 'ib-fabric', label: 'all-to-all' },
        { from: 'experts', to: 'ckpt-store', async: true },
      ],
    },
    metrics: [
      { entity: 'cluster/node-{i}', instances: NODES, name: 'ib_tx', unit: 'B/s', fn: (t, h, i) => (1.6e10 + (nodeHot(i) ? 1.2e10 * (imb(t) - 1.15) : 0)) * stepTime(0) / stepTime(t) * (1 + h.noise(0.03)) },
      { entity: 'train', name: 'tokens_per_sec', unit: 'tok/s', fn: (t, h) => TOK / stepTime(t) * (1 + h.noise(0.01)) },
      { entity: 'train', name: 'step_time_s', unit: 's', fn: (t, h) => stepTime(t) * (1 + h.noise(0.01)) },
      { entity: 'train', name: 'mfu', unit: '%', fn: (t, h) => 39 * stepTime(0) / stepTime(t) * (1 + h.noise(0.01)) },
      { entity: 'train', name: 'loss', unit: '', fn: (t, h) => loss(t, h) },
      { entity: 'profiler', name: 'dense_s', unit: 's', fn: (t, h) => DENSE * (1 + h.noise(0.01)) },
      { entity: 'profiler', name: 'expert_compute_s', unit: 's', desc: 'expert FFN time on the slowest GPU', fn: (t, h) => MOE * imb(t) / 1.15 * (1 + h.noise(0.01)) },
      { entity: 'profiler', name: 'all_to_all_s', unit: 's', desc: 'dispatch + combine, measured on rank 0 (includes waiting for the slowest expert GPU)', fn: (t, h) => (A2A * (1 + 0.35 * (imb(t) - 1.15)) + MOE * (imb(t) / 1.15 - 1) * 0.9) * (1 + h.noise(0.02)) },
      { entity: 'router', name: 'load_imbalance', unit: 'max/mean', desc: 'busiest expert\'s tokens ÷ average expert\'s tokens', fn: (t, h) => imb(t) * (1 + h.noise(0.015)) },
      { entity: 'router', name: 'aux_loss', unit: '', desc: 'load-balancing loss value (before coefficient)', fn: (t, h) => auxLoss(t) * (1 + h.noise(0.02)) },
      { entity: 'router', name: 'aux_loss_coeff', unit: '', fn: (t) => (t < T_CFG ? 0.01 : 0.001) },
      { entity: 'router', name: 'routing_entropy', unit: 'bits', desc: 'entropy of expert assignment (max log2 64 = 6)', fn: (t, h) => entropy(t) + h.noise(0.01) },
      { entity: 'moe/expert-{i}', instances: Array.from({ length: EXPERTS }, (_, k) => k), name: 'token_share', unit: '%', desc: 'share of routed tokens (uniform = 1.56%)', fn: (t, h, e) => 100 * expertLoad(e, t) * (1 + h.noise(0.03)) },
      { entity: 'data', name: 'code_share', unit: '%', fn: (t) => (t < T_MIX ? 18 : 26) },
      { entity: 'fabric', name: 'link_errors', unit: '/min', fn: (t, h) => (h.chance(0.02) ? 1 : 0) },
      { entity: 'fabric', name: 'switch_latency_us', unit: 'µs', fn: (t, h) => 0.9 + h.noise(0.05) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_util_max', unit: '%', desc: 'busiest GPU on the node', fn: (t, h, i) => Math.min(99, (nodeHot(i) ? 100 * (DENSE + MOE * imb(t) / 1.15) / stepTime(t) : 100 * (DENSE + MOE) / stepTime(t)) * (1 + h.noise(0.02))) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'expert_compute_s', unit: 's', desc: 'max expert FFN time per step among the node\'s GPUs', fn: (t, h, i) => MOE * (nodeHot(i) ? imb(t) / 1.15 : 1 + 0.12 * Math.sin(i)) * (1 + h.noise(0.015)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_temp_max', unit: '°C', fn: (t, h, i) => (nodeHot(i) ? 70 + 6 * Math.min(1, (imb(t) - 1.15) / 2) : 70) + h.noise(0.5) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'sm_clock_min', unit: 'MHz', fn: (t, h) => 1980 - Math.abs(h.noise(6)) },
    ],
    dashboards: [
      { title: 'MoE training', charts: [
        { title: 'Tokens/s', series: ['train:tokens_per_sec'] },
        { title: 'Step time', series: ['train:step_time_s'] },
        { title: 'Profiler: time per step', series: ['profiler:dense_s', 'profiler:expert_compute_s', 'profiler:all_to_all_s'] },
        { title: 'Loss', series: ['train:loss'] },
        { title: 'GPU util (busiest GPU per node)', series: ['cluster/*:gpu_util_max'] },
        { title: 'Switch latency', series: ['fabric:switch_latency_us'] },
      ] },
    ],
    events: [
      { t: T_CFG, kind: 'deploy', entity: 'experts', msg: 'restart from checkpoint step 30500 with research PR #4412 (attention init tweak, z-loss 1e-4, router aux-loss retune, eval every 2k steps)' },
      { t: T_FW, kind: 'config', entity: 'ib-fabric', msg: 'leaf switch firmware 3.12 → 3.13 rolled to rack B (nodes 5-8)' },
      { t: T_MIX, kind: 'config', entity: 'data', msg: 'data mixture: code 18% → 26%' },
      { t: 2100, kind: 'alert', entity: 'experts', msg: 'ALERT tokens/s −40% vs 24h baseline' },
    ],
    logs: [
      { entity: 'cluster/node-1', level: 'INFO', rate: 0.1, msg: (t, h) => '[rank0] step=' + stepNo(t) + ' loss=' + loss(t, h).toFixed(4) + ' step_time=' + stepTime(t).toFixed(2) + 's tok/s=' + (TOK / stepTime(t) / 1e6).toFixed(2) + 'M' },
      { entity: 'cluster/node-1', level: 'INFO', t: T_CFG + 30, msg: '[rank0] config diff vs previous run: model.init_std 0.02→0.0173, model.z_loss 0→1e-4, moe.aux_loss_coeff 0.01→0.001 ("reduce aux-loss interference with LM loss"), eval.interval 1000→2000' },
      { entity: 'cluster/node-1', level: 'INFO', rate: 1 / 60, msg: (t) => {
        const top = imb(t) > 1.4 ? 'expert 13: ' + (100 * hotShare(t)).toFixed(2) + '%, expert 41: ' + (100 * hotShare(t) * 0.98).toFixed(2) + '%' : 'expert ' + [7, 22, 50][Math.floor(t / 60) % 3] + ': ' + (100 * 1.15 / 64).toFixed(2) + '%';
        return '[rank0] moe layer-avg expert load: max/mean=' + imb(t).toFixed(2) + ' top: ' + top + ' aux_loss=' + auxLoss(t).toFixed(4);
      } },
      { entity: 'cluster/node-1', level: 'WARN', rate: (t) => (imb(t) > 2 ? 1 / 90 : 0), msg: (t, h) => '[rank0] all_to_all dispatch layer ' + h.int(1, 31) + ' took ' + Math.round(1000 * (A2A + MOE * (imb(t) / 1.15 - 1)) / 16) + 'ms; slowest peer rank ' + h.pick([13, 41]) },
      { entity: (t, h) => 'cluster/node-' + h.int(5, 8), level: 'INFO', t: T_FW + 60, msg: 'mlx5: link renegotiated after switch firmware update: 400Gb/s, 4X NDR, 0 errors' },
      { entity: (t, h) => 'cluster/node-' + h.int(1, NODES), level: 'INFO', t: T_MIX + 3, msg: 'dataloader: mixture updated (code 26%); sequence length unchanged (packed to 4096)' },
    ],
    traces: [
      { name: 'train step (rank 0 profile)', rate: 0.28, fn: (t, h) => {
        const j = (x) => x * 1000 * (1 + h.noise(0.015));
        const wait = MOE * (imb(t) / 1.15 - 1) * 0.9;
        return h.span('trainer', 'step ' + stepNo(t), 2, [
          h.span('gpu', 'attention + dense', j(DENSE)),
          h.span('nccl', 'all-to-all dispatch', j(A2A / 2 + wait / 2), [], { tags: { wire_ms: Math.round(A2A / 2 * 1000), wait_for_rank: wait > 0.05 ? h.pick([13, 41]) : '-' } }),
          h.span('gpu', 'expert FFN (local expert ' + 0 + ')', j(MOE * expertLoad(0, t) * 64 / 1.15)),
          h.span('nccl', 'all-to-all combine', j(A2A / 2 + wait / 2), [], { tags: { wire_ms: Math.round(A2A / 2 * 1000), wait_for_rank: wait > 0.05 ? h.pick([13, 41]) : '-' } }),
          h.span('gpu', 'optimizer', j(OPT)),
        ], { tags: { max_over_mean_load: imb(t).toFixed(2) } });
      } },
    ],
  };
})());
