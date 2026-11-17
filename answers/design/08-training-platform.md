# Rubric: Large-scale training platform (SPOILERS)

## Strong answer covers
- **FLOPs:** 6 × 70e9 × 15e12 = 6.3e24 FLOPs. At 4,096 × 989e12 × 40% MFU = 1.62e18 FLOP/s → 3.9e6 s ≈ **45 days**
  (at 50% MFU ≈ 36 days). 1% of MFU ≈ a day of a 4k-GPU cluster: hundreds of thousands of dollars.
- **Parallelism:** TP=8 inside a node (NVLink, high-volume activations), pipeline parallel across a few nodes if
  needed (bubbles: micro-batching, interleaved schedules), data parallel/FSDP across the rest over IB (gradients, overlapped with
  backward). Memory: 16 B/param for Adam mixed precision = 1.1 TB for 70B, so it must be sharded (ZeRO/FSDP or TP×PP), plus
  activations (checkpointing/recomputation). Sequence/context parallelism for long context.
- **Failures:** per-GPU MTBF of ~years still means **a failure every few hours** across 4,096 GPUs (published large runs saw
  hundreds of interruptions over months). Optimal checkpoint interval ≈ √(2 × checkpoint_cost × MTBF) (Young/Daly).
  Async checkpointing (snapshot to host memory, upload in the background), sharded checkpoints, fast restart
  (pre-warmed spares, cached container/weights, NCCL init time), automatic cordon of bad nodes. Goodput = productive time /
  wall time. Track it as the headline metric.
- **Stragglers/silent issues:** per-rank step-time and collective-arrival telemetry (the slowest rank gates all), DCGM clock
  reasons/thermals/ECC/XID, IB link rate and error counters, periodic NCCL/all-reduce bandwidth probes, burn-in before
  admitting nodes. SDC: loss/grad-norm spikes, cross-replica checksum of parameters, re-running suspect steps.
- **Data:** pre-tokenized, shuffled shards, deterministic sampler state in the checkpoint (exact resume), mixture
  schedules versioned, dataloader prefetch so it's never on the critical path.
- **Observability:** tokens/s, MFU, step-time breakdown (compute / exposed comm / data / optimizer), loss & grad norm,
  per-node health heatmaps, goodput, time-to-restart. Page on: job down, goodput drop, sustained step-time regression, loss divergence (NaN/spike).

## Scoring (10 pts)
- 2 pts: FLOPs and wall-clock estimate with MFU assumption
- 2 pts: Sensible parallelism layout mapped to NVLink vs IB, with a memory argument
- 2 pts: Failure math + checkpoint strategy (interval reasoning, async, fast restart, spares)
- 2 pts: Straggler / hardware-degradation detection and automated remediation
- 1 pt: Deterministic, resumable data pipeline
- 1 pt: Observability: goodput, step breakdown, what pages

Push back on: "just checkpoint every hour" without a cost/MTBF argument, and DP-only for 70B (doesn't fit).
