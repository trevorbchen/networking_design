# Answer key: 011-dataloader-bound (SPOILERS)

## Root cause
Dataset v5 stores **original JPEGs** (~2 MP, ~410 KB) instead of v4's **pre-resized 256 px** images. Every image is now
decoded at full resolution, resized and augmented **on the CPU, every epoch**. Per-image CPU cost went from ~0.45 ms
to ~20 ms (~45×). Each node needs 2,048 images per step: 2,048 × 20.5 ms / 28 workers ≈ **1.5 s of CPU per step**,
but GPU compute is only 0.92 s. The input pipeline is now the critical path. Step time 0.99 → 1.57 s, and throughput
33k → 21k img/s (−37%). GPUs idle ~0.58 s per step waiting for batches.

## Key evidence
- **Profiler (Traces → Breakdown)**: `next(batch): wait for prefetch queue` goes ~4 ms → ~580 ms. forward/backward/optimizer are unchanged.
  `train:dataloader_wait_s` ↑, `train:compute_s` flat.
- **USE on hosts**: `cpu_util` 15% → ~96% on **all 16 nodes**, `load_avg` ≈ 31.5 on 32 cores (saturated),
  `dl_queue_depth` 4 → 0 (the prefetch queue is always empty). `cpu_iowait` is low, so the workers aren't waiting on I/O.
- Worker logs: `decode ~950 ms ... median_src=2.1MP` per batch of 73, vs `decode ~22 ms` before.
- `gpu_util` ~94% → ~61%: the GPUs are starved, not slow.

## Red herrings
- **Storage**: the job needs ~21k img/s × 410 KB ≈ **8.6 GB/s**. The object store serves ≥ 40 GB/s (32 GB/s during
  maintenance). The maintenance (10:31–10:41) started 11 min *after* the slowdown, and throughput didn't change during it.
  Latency went up 140 → 210 ms on 1 GB chunk reads, but prefetch hides that. iowait stays ~1%.
- **LR schedule**: changes the loss trajectory, not step time.
- "GPU util down → GPUs fine, look upstream": correct direction, but the upstream culprit is CPU, not storage.

## Mitigation (now)
- Fastest: **preprocess v5 offline** (resize to 256 px, re-encode, write tensor/WebDataset shards) on a CPU batch cluster, then
  restart on preprocessed shards (that's ticket DATA-512). Meanwhile, if acceptable: train on v4 or a preprocessed subset.
- Quick wins while that runs: GPU decode (**NVIDIA DALI / nvjpeg**) to move decode+resize to GPU, PIL-SIMD/libjpeg-turbo with
  **reduced-size JPEG decode** (`draft()` decodes at 1/2–1/8 scale), and more workers if cores are free (they aren't).
- Expected speedup from removing the bottleneck: back to ~0.99 s/step (**~1.6× faster**, ~33k img/s).

## Durable fixes
- Data pipeline contract: training datasets must be **pre-processed to training resolution** before use. Validate with a
  dataloader benchmark (images/s per node vs GPU consumption rate) before switching a production run.
- Dashboards/alerts on `dataloader_wait_s` (or % step time waiting for data) and host CPU saturation, not just GPU util.
- Capacity rule: per-node CPU decode budget = images/step × ms/image ÷ workers must stay < step compute time with margin.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Profiler evidence: the time is in dataloader wait, compute unchanged |
| 2 | Host CPU saturation (cpu_util ~100%, load ≈ cores, queue depth 0) identified as the bottleneck (USE) |
| 2 | Root cause: v5 raw full-resolution JPEGs decoded/resized on the CPU (vs pre-resized v4); ideally quantified |
| 1 | Rules out storage with numbers (needed ~8.6 GB/s vs capacity; maintenance timing; low iowait) |
| 1 | Rules out LR schedule / explains GPU util drop as starvation |
| 1 | Mitigation: preprocess offline and/or GPU decode (DALI) / reduced-size decode; expected ~1.6× speedup |
| 1 | Prevention: preprocessing contract, dataloader benchmark before switch, alert on data-wait |
