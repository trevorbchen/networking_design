# Answer key: 012-checkpoint-hang (SPOILERS)

## Root cause
At 22:05 the data-platform team's nightly **`sync-laion-5b` rsync** (~410M small files, `--checksum`) started against the shared
Lustre filesystem `/shared`. It hammers the single **metadata server** (MDS: 42k → 1.9M ops/s, CPU 98%,
p99 op latency 18 ms → 2.4 s). That also crushes data throughput for everyone else.

The training job checkpoints by gathering a **full state dict to rank 0**, which writes 168 GB to `/shared`. Normally ~40 s.
Under contention rank 0 gets only ~240 MB/s, so the save would take **~700 s**. The other **511 ranks** have moved on to the next
step and are blocked in its first collective (ALLGATHER), waiting for rank 0. After **600 s** the **NCCL watchdog** fires on
all of them, the launcher kills the job (rank 0 is still inside `torch.save`, leaving a `.tmp` partial checkpoint), and it
restarts from the **last complete checkpoint, step 119775** (from before the window). Loading is also slow (~210 s instead of 30 s).
The run trains 15 min, reaches step 120225 again, tries the same checkpoint, hangs, and dies again. **Net progress: zero.**
Goodput this hour ≈ 0 (the ~30 min of training are all thrown away).

## Key evidence
- Timeline: each hang starts **exactly at a scheduled checkpoint** (22:07:30, 22:38:35) and ends **exactly 600 s later**
  with watchdog errors on hundreds of ranks. `global_step` saws back to 119775.
- rank 0 (node-1) is the odd one out: logs `saving checkpoint ... FULL_STATE_DICT`, `checkpoint write progress 14.4/168 GB
  (240 MB/s)`, then `terminated by launcher while in torch.save() (written 144.0/168 GB)`. Its GPU util is 87.5% vs 100% elsewhere
  (its GPU idles while its CPU writes).
- `ckpt:write_bw` ~0.24 GB/s (normal ~4 GB/s). `ckpt:load_bw` 0.8 GB/s, `load took 210s (usual: 30s)`.
- `sharedfs:mds_ops`, `mds_cpu`, `op_latency_p99` all jump at **22:05**, and `sharedfs/client-data-sync-01:mds_ops` ≈ 1.75M ops/s.
  `mds0: ... top client data-sync-01 92% of ops`. Change log: `sync-laion-5b started` at 22:05.
- Trace "checkpoint save": `open/create shard files (MDS)` 41 s and `torch.save` 600 s killed.

## Red herrings
- **"NCCL timeout = network"**: the fabric is clean (`link_errors` ~0) and IB traffic simply stops. The collective timed out because
  **one rank never joined**, not because data moved slowly.
- **Driver canary node-21..24**: rank 0 is on node-1. The hangs line up with checkpoints, not with the canary nodes, which are healthy.
- **node-12 ECC**: single-bit corrected errors, unchanged for days, below RMA threshold.
- **"GPU util 100% during the hang"**: NCCL kernels busy-wait. `gpu_power` ~118 W (vs ~640 W training) shows the GPUs were idle.

## Mitigation (tonight)
- **Pause/throttle the rsync** (or move it off-peak / to another filesystem). Coordinate with data-platform.
- Make the next checkpoint survive: raise `NCCL_TIMEOUT` above the worst-case save time for tonight, or temporarily checkpoint
  to **local NVMe** and copy to /shared asynchronously. Keep the partial `.tmp` out of the restart path (already ignored).
- Restart from 119775 once the FS is healthy, and confirm one checkpoint completes (~40 s).

## Durable fixes
- **Sharded + async checkpointing**: every rank writes its own shard (SHARDED_STATE_DICT / torch.distributed.checkpoint) in
  parallel. Snapshot to host RAM, upload in a background thread, and never block collectives on I/O. Optionally write to local NVMe → object storage.
- **Don't hold the job hostage**: no collective should wait on a single rank's I/O. Separate I/O timeouts from NCCL timeouts.
  Watchdog messages should say *which rank* is missing (NCCL flight recorder).
- **Shared-FS isolation**: QoS/ops-rate limits per client (Lustre NRS/TBF), a separate filesystem or object store for
  checkpoints, and schedule metadata-heavy jobs away from training checkpoints.
- **Goodput monitoring**: alert on "steps not advancing / step went backwards", checkpoint duration vs baseline, and restart counts.
  Checkpoint health (last *successful* checkpoint age) as an SLO.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Hangs are rank 0 stuck writing the checkpoint while other ranks wait in a collective; watchdog kills at 600 s |
| 2 | Root cause: /shared contention from the data-sync rsync (MDS overload) starting 22:05, with metric/log evidence |
| 1 | Explains zero net progress (restart from same last-good checkpoint, same save fails again; goodput ~0) |
| 1 | Uses timing: hangs start at checkpoint times, end exactly +600 s |
| 1 | Sees through "100% GPU util" (power ~idle, NCCL busy-wait) and/or the "NCCL = network" assumption |
| 1 | Rules out driver canary and node-12 ECC |
| 1 | Immediate: stop/throttle rsync; checkpoint to local NVMe or raise timeout; restart |
| 1 | Durable: sharded/async checkpoints, FS QoS/isolation, goodput + checkpoint-age alerting |
