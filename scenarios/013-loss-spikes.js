/* Scenario 013 — "Loss keeps spiking, and then the run died with NaN."
 * Answer key: answers/scenarios/013-loss-spikes.md  (don't peek!) */
OBS.register((function () {
  const T_MIX = 900, T_REPLAY = 2500, T_NAN = 2935, NODES = 32, BAD_NODE = 7;
  const SPIKES = [[1310, 0.9, 9], [1725, 1.6, 21], [2050, 0.7, 7], [2395, 2.1, 34], [2705, 1.2, 15], [T_NAN, 6.5, 410]]; // [t, loss jump, grad-norm peak]
  const SPIKE_W = 40; // seconds of steps that pull from the bad shard
  const dead = (t) => t >= T_NAN + 15;
  const inSpike = (t) => SPIKES.find(([s]) => t >= s && t < s + SPIKE_W);
  const spikeShape = (t) => { const s = inSpike(t); if (!s) return 0; const x = (t - s[0]) / SPIKE_W; return Math.sin(Math.PI * Math.min(1, x * 1.3)); };
  const residual = (t) => SPIKES.reduce((a, [s, j]) => a + (t >= s + SPIKE_W ? 0.025 * j * Math.exp(-(t - s - SPIKE_W) / 500) : 0), 0);
  const baseLoss = (t) => 2.046 - 0.000014 * t;
  const loss = (t) => baseLoss(t) + residual(t) + (inSpike(t) ? inSpike(t)[1] * spikeShape(t) : 0);
  const gnorm = (t) => 0.31 + 6 * residual(t) + (inSpike(t) ? inSpike(t)[2] * spikeShape(t) : 0);
  const crawlFrac = (t) => (t < T_MIX ? 0 : 0.05);
  const badFrac = (t) => (inSpike(t) ? 0.04 + 0.12 * spikeShape(t) : 0); // share of batch tokens that are garbage
  const stepNo = (t) => 61000 + Math.round(t / 1.6);
  const SRC = ['web', 'code', 'books', 'math', 'crawl-2026-10'];

  return {
    id: '013-loss-spikes',
    title: 'Loss keeps spiking, then the run died with NaN',
    difficulty: 'medium',
    tags: ['ml training', 'loss spikes', 'training stability', 'data quality', 'silent data corruption', 'gpu'],
    startTime: '2026-11-23T14:00:00Z',
    duration: 3000, step: 10, seed: 1313,
    brief: {
      severity: 'SEV-2',
      alert: 'train:loss is NaN, run "kite-22b" halted by NaN guard',
      firedAt: 2960,
      summary: `<p><b>kite-22b</b> (22B LLM, <b>32 nodes × 8 H100</b>, bf16 with fp8 matmuls) had been stable for 9 days. This afternoon the loss curve started showing <b>sharp spikes</b> that partly recover, each a bit worse. At 14:49 it spiked to NaN and the NaN guard stopped the job.</p>
        <p>Theories: <i>"fp8 is numerically fragile, turn it off."</i> (fp8 was enabled 3 days ago.) <i>"Silent data corruption: node-7 has been logging ECC errors. A bad GPU produces garbage gradients."</i> <i>"The learning rate is too high, cut it in half and restart."</i></p>`,
      task: '<p>Find what is causing the spikes and prove it. Decide where to restart from and what to change so the run survives. Propose guards that would have caught or contained this automatically.</p>',
      questions: [
        'When did the spikes start? What changed around then?',
        'Is it hardware (SDC on a GPU) or data? What evidence separates the two?',
        'Which data, exactly? How would you find the offending shards/documents?',
        'Rule in/out: fp8, node-7 ECC, learning rate.',
        'Restart plan (which checkpoint, what changes) and automatic guards for the future.',
      ],
    },
    architecture: `<ul>
      <li>Data: a <b>mixture</b> of sources (web, code, books, math, ...), each a set of tokenized shards. The dataloader streams shards sequentially per source, so documents from one shard arrive together over ~a minute of steps. Each step logs the shard IDs it drew from.</li>
      <li>New sources normally pass a quality-filter stage (dedup, language ID, perplexity/entropy filters) before tokenization.</li>
      <li>Optimizer: AdamW, LR 2.4e-4 constant (WSD schedule, stable phase), gradient clipping at norm 1.0. Checkpoints every 30 min (14:00, 14:30 in this window), plus older ones.</li>
      <li>A NaN guard halts training if the loss is NaN/Inf.</li>
      <li>Per-source loss is computed for monitoring by tagging each token with its source.</li>
      <li>A <b>data-quality sampler</b> logs warnings for a random 0.1% of documents that look anomalous.</li></ul>`,
    hints: [
      'Line the spikes up against the change log. Then use <code>loss_by_source</code>: does every source spike, or one?',
      'Hardware SDC follows a <i>device</i> and is not reproducible on other hardware. Data problems follow the <i>batch</i> and reproduce exactly. Check the replay event and the ECC timing.',
      'Search logs for the shard IDs in spiking steps, and for <code>dq-sampler</code> and <code>quality_filter</code>.',
    ],
    topology: {
      nodes: [
        { id: 'data-pipeline', kind: 'worker', x: 0, y: 30, desc: 'filter → tokenize → shard' },
        { id: 'shards', kind: 'storage', x: 22, y: 30, health: 'data:garbage_token_frac', thresholds: [0.5, 2], desc: 'tokenized shards by source' },
        { id: 'gpu-nodes', kind: 'service', x: 55, y: 45, health: 'train:grad_norm', thresholds: [1, 5], desc: '32 nodes × 8 H100' },
        { id: 'ckpt-store', kind: 'storage', x: 85, y: 20 },
        { id: 'ib-fabric', kind: 'lb', x: 70, y: 88 },
      ],
      edges: [
        { from: 'data-pipeline', to: 'shards', async: true },
        { from: 'shards', to: 'gpu-nodes', label: 'batches' },
        { from: 'gpu-nodes', to: 'ckpt-store', async: true },
        { from: 'gpu-nodes', to: 'ib-fabric' },
      ],
    },
    metrics: [
      { entity: 'train', name: 'loss', unit: '', desc: 'after the NaN guard fires the last finite value (9.9) is held', fn: (t, h) => (t >= T_NAN ? 9.9 : loss(t) + h.noise(0.008)) },
      { entity: 'train', name: 'grad_norm', unit: '', desc: 'pre-clipping global gradient norm', fn: (t, h) => (dead(t) ? 0 : gnorm(t) * (1 + h.noise(0.05))) },
      { entity: 'train', name: 'tokens_per_sec', unit: 'tok/s', fn: (t, h) => (dead(t) ? 0 : 2.6e6 * (1 + h.noise(0.01))) },
      { entity: 'train', name: 'learning_rate', unit: '', fn: () => 2.4e-4 },
      { entity: 'train', name: 'update_rms', unit: '', desc: 'RMS of the parameter update / RMS of the params (×1e-4)', fn: (t, h) => (dead(t) ? 0 : 1.1 + 0.6 * Math.min(1, (gnorm(t) - 0.31) / 3) + h.noise(0.04)) },
      ...SRC.map((s, k) => ({ entity: 'loss_by_source/' + s, name: 'loss', unit: '', desc: '0 = no tokens from this source (not in mixture / job halted)', fn: (t, h) => {
        if (dead(t)) return 0;
        if (s === 'crawl-2026-10' && t < T_MIX) return 0;
        const base = [2.11, 1.32, 2.38, 1.64, 2.21][k] - 0.000014 * t + residual(t);
        return base + (s === 'crawl-2026-10' && inSpike(t) ? 9 * spikeShape(t) : inSpike(t) ? 0.08 * spikeShape(t) * inSpike(t)[1] : 0) + h.noise(0.012);
      } })),
      { entity: 'data', name: 'crawl_share', unit: '%', desc: 'share of tokens from crawl-2026-10', fn: (t, h) => 100 * crawlFrac(t) * (1 + h.noise(0.05)) },
      { entity: 'data', name: 'garbage_token_frac', unit: '%', desc: 'tokens flagged by the online heuristic (non-alpha runs, repeated n-grams)', fn: (t, h) => 100 * badFrac(t) + Math.abs(h.noise(0.05)) },
      { entity: 'data', name: 'batch_entropy', unit: 'bits', desc: 'unigram entropy of batch tokens', fn: (t, h) => 10.9 - 4 * badFrac(t) + h.noise(0.03) },
      { entity: 'data', name: 'max_repeat_ngram_frac', unit: '%', fn: (t, h) => 0.4 + 60 * badFrac(t) + Math.abs(h.noise(0.1)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'gpu_util', unit: '%', fn: (t, h) => (dead(t) ? 0 : 95 + h.noise(1.5)) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'ecc_corrected', unit: '/min', desc: 'single-bit ECC errors corrected', fn: (t, h, i) => (i === BAD_NODE ? (h.chance(0.3) ? h.int(1, 4) : 0) : 0) },
      { entity: 'cluster/node-{i}', instances: NODES, name: 'local_grad_norm', unit: '', desc: 'grad norm of this node\'s micro-batches before all-reduce', fn: (t, h) => (dead(t) ? 0 : gnorm(t) * (1 + h.noise(0.25))) },
    ],
    dashboards: [
      { title: 'Training health', charts: [
        { title: 'Loss', series: ['train:loss'] },
        { title: 'Gradient norm', series: ['train:grad_norm'] },
        { title: 'Learning rate', series: ['train:learning_rate'] },
        { title: 'Tokens/s', series: ['train:tokens_per_sec'] },
        { title: 'ECC corrected errors', series: ['cluster/*:ecc_corrected'] },
      ] },
    ],
    events: [
      { t: 0, kind: 'cron', entity: 'ckpt-store', msg: 'checkpoint step 61000 saved' },
      { t: T_MIX, kind: 'config', entity: 'data-pipeline', msg: 'data mixture v7 → v8: add source crawl-2026-10 (5% of tokens), web 55% → 50%' },
      { t: 1800, kind: 'cron', entity: 'ckpt-store', msg: 'checkpoint step 62125 saved' },
      { t: T_REPLAY, kind: 'info', entity: 'gpu-nodes', msg: 'on-call: replayed step 62497 (batch from the 14:40 spike) on spare node-99 from checkpoint 62125 → loss 4.12 (original run 4.13). Reproduced.' },
      { t: T_NAN + 15, kind: 'alert', entity: 'gpu-nodes', msg: 'ALERT loss NaN: NaN guard halted kite-22b at step ' + stepNo(T_NAN + 15) },
    ],
    logs: [
      { entity: 'cluster/node-1', level: 'INFO', rate: (t) => (dead(t) ? 0 : 0.12), msg: (t, h) => {
        const sh = ['web-' + h.int(10000, 99999), 'code-' + h.int(1000, 9999), 'books-' + h.int(100, 999)];
        if (t >= T_MIX) sh.push('crawl-2026-10-' + (inSpike(t) ? '088' + h.int(10, 63) : String(h.int(0, 8799)).padStart(5, '0')));
        return '[rank0] step=' + stepNo(t) + ' loss=' + loss(t).toFixed(4) + ' gnorm=' + gnorm(t).toFixed(2) + ' clipped=' + (gnorm(t) > 1 ? 'yes' : 'no') + ' shards=[' + sh.join(',') + ']';
      } },
      { entity: 'data-pipeline', level: 'WARN', t: T_MIX - 120, msg: 'build crawl-2026-10: quality_filter stage SKIPPED (no "filters" key in source config); tokenized 412B tokens into 8 864 shards' },
      { entity: 'cluster/node-1', level: 'INFO', t: T_MIX + 4, msg: '[rank0] dataloader: mixture v8 active: web 50%, code 20%, books 10%, math 15%, crawl-2026-10 5%' },
      { entity: (t, h) => 'cluster/node-' + h.int(1, NODES), level: 'WARN', rate: (t) => (inSpike(t) ? 0.15 : t > T_MIX ? 0.004 : 0), msg: (t, h) => 'dq-sampler: doc crawl-2026-10-' + (inSpike(t) ? '088' + h.int(10, 63) : String(h.int(0, 8799)).padStart(5, '0')) + '/' + h.int(0, 4095) + ': ' + h.int(91, 99) + '% non-alphabetic, longest repeated substring ' + fmtK(h.int(8000, 60000)) + ' chars (looks like base64 / minified blob)' },
      { entity: 'cluster/node-1', level: 'WARN', rate: (t) => (inSpike(t) && spikeShape(t) > 0.5 ? 0.2 : 0), msg: (t) => '[rank0] loss spike: loss=' + loss(t).toFixed(3) + ' (EMA ' + (baseLoss(t) + residual(t)).toFixed(3) + '), gnorm=' + gnorm(t).toFixed(1) + ' (clipped to 1.0)' },
      { entity: 'cluster/node-1', level: 'ERROR', t: T_NAN + 14, msg: '[rank0] NaN guard: loss=nan at step ' + stepNo(T_NAN + 14) + ' (gnorm=inf after attention logit overflow in layer 31). Halting.' },
      { entity: 'cluster/node-' + BAD_NODE, level: 'WARN', rate: 1 / 100, msg: (t, h) => 'dcgm: GPU 2 single-bit ECC corrected (' + h.int(1, 4) + ') (rate unchanged for 6 days, below RMA threshold)' },
      { entity: 'cluster/node-1', level: 'INFO', t: 1801, msg: '[rank0] checkpoint step_62125 saved (14:30)' },
    ],
    traces: [
      { name: 'train step (rank 0)', rate: 0.25, fn: (t, h) => (dead(t) ? null : h.span('trainer', 'step ' + stepNo(t), 2, [
        h.span('dataloader', 'next(batch)', h.lognormal(12, 0.3), [], { tags: { crawl_shard: t >= T_MIX ? 'crawl-2026-10-' + (inSpike(t) ? '088' + h.int(10, 63) : String(h.int(0, 8799)).padStart(5, '0')) : 'n/a', garbage_frac: (badFrac(t) * 100).toFixed(1) + '%' } }),
        h.span('gpu', 'forward + backward', 1210 * (1 + h.noise(0.01)), [], { tags: { loss: loss(t).toFixed(3) } }),
        h.span('gpu', 'clip + optimizer', 140, [], { tags: { grad_norm: gnorm(t).toFixed(2) } }),
      ], { error: !!inSpike(t) && spikeShape(t) > 0.4, tags: { step: stepNo(t) } })) },
    ],
  };
  function fmtK(n) { return n.toLocaleString('en-US'); }
})());
