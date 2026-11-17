# Answer key: 007-training-slowdown (SPOILERS)

## Root cause
At **02:21:50** an InfiniBand cable/optic on **node-11, rail mlx5_3** failed. It had been throwing symbol errors for ~5 min
first. The link flapped down for ~22 s and **came back negotiated at 100 Gb/s instead of 400 Gb/s**, and kept erroring.
NCCL keeps using the rail, so the ring that crosses it runs at ¼ speed. A collective is only as fast as its slowest
link, so **gradient all-reduce bus bandwidth fell from ~380 to ~180 GB/s** and comm time per step went from ~0.82 s to ~1.73 s.

Backward compute is only ~0.9 s, so the all-reduce can no longer hide behind it. **Exposed communication rose from
~0.22 s to ~1.17 s per step.** Step time went 1.75 s → 2.66 s, and tokens/s 2.29M → 1.49M (−35%).

**Why every node's GPU util dropped at once:** all-reduce is synchronous. All 128 ranks sit idle waiting for the
slow ring. One bad link makes the whole job uniformly slower, so GPU-side heatmaps show no odd one out. You
have to look at *network* health per node.

The nightly health check didn't catch it: DCGM diag level 1 tests GPUs, not IB link rate or error counters.

## Key evidence
- **Traces → Breakdown (before vs after 02:22)**: forward/backward/optimizer kernel time unchanged. The **all-reduce buckets
  ~2× longer**, and the step's total grows by the part that sticks out past backward. `train:exposed_comm_s` 0.22 → 1.17
  while `train:compute_s` is flat.
- `nccl:allreduce_busbw` steps 380 → (60 during flap) → 180 GB/s at 02:21:50.
- `train:dataloader_wait_s` ≈ 0.035 → 0.042 s: tiny and flat. The data pipeline is not the bottleneck.
- **Heatmap `ib_link_min_rate`**: node-11 drops 400 → 0 → 100 Gb/s. **`ib_symbol_errors`**: node-11 starts erroring ~5 min
  before the flap and much more after. Every other node is 0.
- Logs on node-11: `Port module event: module 3, Cable error/link down`, `NCCL WARN ... port error (mlx5_3:1)`,
  `Link up ... rate 100 Gb/sec (4X EDR)`. rank0: `NCCL AllReduce bucket ... took 72ms (p50 last 24h: 34ms)`.
- `cluster/*:nccl_wait_s` rises equally on **all** nodes: the synchronous straggler signature.

## Red herrings
- **Dataloader num_workers 8 → 6 (02:15)**: 7 min before onset. `dataloader_wait_s` barely moved (~7 ms). Host CPU *dropped*
  (fewer workers, and slower steps need fewer batches/s). Onset at 02:21:50 matches the link event, not the config.
- **node-3 temperature 84 °C**: above the *warning* threshold, below slowdown (90 °C). `sm_clock_min` is 1980 MHz on all nodes,
  so nothing is throttling. It's been like that all week (before onset too), and a throttled GPU would show as longer compute
  kernels, which didn't happen.
- **Checkpoint spikes** (02:10, 02:30, 02:50): 28 s blocking saves every 20 min, normal and unchanged (27.6–28.3 s). They're
  spikes, not a step change.
- **"All nodes PASS" health check**: it doesn't test the IB fabric.
- Loss / grad norm normal: this is a performance problem, not a correctness one.

## Mitigation (now)
- **Cordon node-11** and restart from the latest checkpoint (02:30, step 42100) on a **hot-spare node** (or on 15 nodes
  with an adjusted batch/grad-accumulation). That costs a few minutes of restart versus hours at −35%.
- Alternatives: exclude the bad HCA (`NCCL_IB_HCA=^mlx5_3` on node-11) on restart (that rail's GPU then shares other NICs, which
  isn't great), or reseat/replace the cable/optic and run `ibdiagnet`/link tests before returning the node.
- File a hardware ticket for node-11 rail 3 (cable/transceiver).

## Durable fixes
- **Fabric health monitoring**: alert on IB link rate < expected, link-downed counter, and symbol/error-counter rates per port.
  Fold them into the pre-job and periodic health checks (not only DCGM GPU diag).
- **Training-level SLOs**: alert on `exposed_comm_s` / `allreduce_busbw` regressions vs baseline, not just tokens/s.
- **Automatic straggler handling**: per-rank collective timing (e.g. NCCL profiler / flight recorder) to pinpoint
  the slow rank or link. Auto-cordon and restart from checkpoint with hot spares.
- Faster/more frequent async checkpointing makes restart-to-fix cheap.
- Possibly bigger gradient buckets / more overlap (or FSDP prefetch tuning) to give more headroom, but it can't
  cover a 4× slower link.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Shows the slowdown is in communication (exposed all-reduce / busbw), not data or compute, using profiler/metrics |
| 2 | Pins it to node-11's InfiniBand link (rail mlx5_3) downtrained to 100 Gb/s / erroring, with log or heatmap evidence |
| 1 | Explains why all GPUs dropped uniformly (synchronous collective: slowest link gates everyone) |
| 1 | Explains why comm became exposed (no longer fits behind backward) or quantifies the step-time breakdown |
| 2 | Rules out dataloader change, node-3 temperature (no clock drop), and checkpoints with evidence (1 pt for two of three) |
| 1 | Mitigation: cordon node-11 + restart from checkpoint on a spare (or exclude the HCA), hardware ticket |
| 1 | Prevention: IB link-rate/error monitoring in health checks + comm-regression alerting / straggler auto-detection |
