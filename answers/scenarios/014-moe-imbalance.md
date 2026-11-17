# Answer key: 014-moe-imbalance (SPOILERS)

## Root cause
PR #4412, deployed with the 08:04 restart, cut the router's load-balancing **aux loss coefficient 10× (0.01 → 0.001)**. With
little pressure to balance, the routers gradually **collapse** onto a few experts (13 and 41). Those experts get more tokens, get
trained more, look better, and get routed even more tokens. Max/mean expert load climbs smoothly from 1.15 to ~3.7.

With **dropless expert parallelism**, the GPU hosting a hot expert must process all its tokens. Expert 13 lives on node-2 GPU 5
and expert 41 on node-6 GPU 1. Their expert FFN time grows ~3×. Every MoE layer's all-to-all waits for the slowest GPU, so
**everyone's step time** grows: 1.63 s → ~2.9 s (tokens/s −45%). The "all-to-all got slower" is **waiting**, not wire time.

## Key evidence
- Shape: a **smooth exponential-ish ramp starting at the 08:04 restart**. That's a learning dynamic, not a hardware event.
- `router:aux_loss_coeff` 0.01 → 0.001. `router:load_imbalance` 1.15 → 3.7. `router:routing_entropy` falls from ~5.95 bits. `router:aux_loss` rises.
- **Heatmap `moe/*:token_share`**: experts 13 and 41 climb from ~1.8% to ~5.6% while everyone else dims slightly.
- `cluster/*:expert_compute_s` and `gpu_util_max` hot only on **node-2 and node-6** (exactly the nodes hosting experts 13 and 41).
- Profiler: `expert_compute_s` and `all_to_all_s` grow together. Trace tags: `wire_ms` constant (~105), `wait_for_rank 13/41`.
- Logs: config diff `moe.aux_loss_coeff 0.01→0.001`. `expert load: max/mean=3.2 top: expert 13: 5.0%, expert 41: 4.9%`.
  `all_to_all ... slowest peer rank 13/41`.

## Red herrings
- **Switch firmware (08:15, rack B = nodes 5-8)**: the ramp began 11 min earlier, switch latency is flat at ~0.9 µs, link errors ~0,
  and node-2 (rack A) is equally hot.
- **Code mixture 18 → 26% (08:25)**: sequences are packed to 4096, so per-token cost is unchanged. It adds a small bump in
  imbalance (code tokens prefer the collapsing experts), but the ramp started 20 min earlier.
- **"Bad nodes 2 and 6"**: clocks normal, temps only slightly up from extra work. Swapping hardware moves the experts with it,
  so the hot spots would follow the experts to the new GPUs.

## Fix
- Restore `aux_loss_coeff = 0.01` (or a value tuned with a load-balance target) and restart from the 08:04 checkpoint or the latest one. The
  router rebalances over a few hundred steps. If the collapse persists, consider rolling back further.
- Alternatives the research team may want: **aux-loss-free balancing** (per-expert bias terms adjusted to hit uniform load,
  as in DeepSeek-V3), expert **capacity factor** with token dropping (bounds the slowdown, costs quality), or replicating hot experts.
- Process: config PRs that change load-balancing knobs need a perf canary (throughput and imbalance), not just a loss check.

## Monitoring for MoE
- Per-layer expert load (max/mean, entropy, top-k experts), tokens dropped (if capacity-limited), aux-loss value,
  per-EP-rank expert compute time, and all-to-all *wire* vs *wait* time. Alert on imbalance > 1.5–2 sustained.

## Real-world commands (how you'd confirm this in production)
- Megatron/DeepSpeed MoE logs: per-layer expert token counts (`--moe-per-layer-logging` style) and aux-loss values. Plot max/mean and entropy over steps.
- `nsys` on rank 0 and on the rank hosting expert 13: compare grouped-GEMM (expert FFN) kernel time. rank 0's all-to-all is mostly wait.
- `git diff` of the run config vs the previous run (`moe.aux_loss_coeff`).
- `nvidia-smi dmon` on node-2 vs node-1: busier SMs, normal clocks (rules out bad hardware).

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Root cause: aux-loss coefficient cut 10× in the 08:04 restart → router collapse |
| 2 | Shows router evidence: load_imbalance / entropy / aux loss / per-expert token share (experts 13, 41) |
| 2 | Maps hot experts → node-2/node-6 GPUs; explains why everyone slows (dropless EP, all-to-all waits for slowest) |
| 1 | Explains all-to-all growth as waiting, not network (wire time constant) |
| 1 | Rules out switch firmware and code mixture with timing/evidence; explains why swapping nodes won't help |
| 1 | Fix: restore coefficient / aux-loss-free balancing / capacity factor; restart plan |
| 1 | MoE monitoring: per-expert load, imbalance alerts, wire vs wait time |
