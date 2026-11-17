# ML systems primer: performance, scale, and what breaks

This is the ML-infra counterpart to `observability-primer.md` and `debugging-playbook.md`. It covers the numbers and
mental models an ML infra / ML platform engineer uses daily, and the **signatures** of common failures as they appear in the
Observatory. Interactive versions: `lab.html#roofline`, `#llmserve`, `#training`.

---

## 1. GPU performance in one page

**Reference numbers (H100 SXM):** ~989 TFLOP/s dense bf16 (≈2× for fp8), 80 GB HBM3 at ~3.35 TB/s, NVLink ~900 GB/s
per GPU (inside a node), InfiniBand 400 Gb/s ≈ 50 GB/s per NIC (between nodes), PCIe 5 x16 ≈ 64 GB/s, power ~700 W.
An 8-GPU node has ~640 GB HBM.

**Roofline.** Attainable FLOP/s = min(peak, arithmetic_intensity × memory_bandwidth). The ridge is ~295 FLOP/byte on an H100.
- Big GEMMs (training, prefill): high intensity, **compute-bound**.
- Elementwise ops, layernorm, softmax, LLM **decode** at small batch: **memory-bound**. Fix by fusing kernels,
  batching, and quantizing (fewer bytes), not by adding FLOPs.

**MFU (model FLOPs utilization)** = useful model FLOPs/s ÷ peak. Good LLM training runs reach 35–55%.
"GPU utilization" from `nvidia-smi` only means *some kernel was running*. It can say 100% while the GPU sits in an NCCL wait or
runs a memory-bound kernel at 3% of peak. **Don't use it as a saturation signal** (scenario 008).

**Clocks and throttling.** GPUs lower their SM clocks when too hot (thermal slowdown) or over the power cap. DCGM reports
"clock event reasons" (HW_SLOWDOWN, SW_THERMAL, POWER_CAP). A throttled GPU looks healthy in every metric except clocks,
temperature, power, and its own kernel times (scenario 009).

**The nsys view.** A profiler timeline shows, per GPU stream: compute kernels, NCCL kernels, memcpy (H2D/D2H), and CPU-side
gaps. Questions to ask of any step profile:
1. Are there gaps where the GPU is idle? (data loading, CPU overhead, sync points)
2. Is communication overlapped with compute, or exposed?
3. Which kernels dominate, and are they compute- or memory-bound?

---

## 2. Distributed training

**FLOPs:** training ≈ **6 × params × tokens** (2 forward, 4 backward). Inference ≈ 2 × params per token.
Example: 70B × 15T tokens = 6.3e24 FLOPs. At 4,096 H100 × 40% MFU that's ~45 days.

**Memory per parameter (mixed-precision Adam):** bf16 weights 2 B + bf16 grads 2 B + fp32 master weights 4 B + Adam m, v 8 B
= **~16 B/param**, plus activations. A 13B model is ~208 GB of state, so it doesn't fit on one GPU without sharding.

**Parallelism:**
| type | splits | communicates | where it lives |
|---|---|---|---|
| Data (DP) | batch | gradient all-reduce each step | across nodes (IB) |
| FSDP / ZeRO | params, grads, optimizer state across DP ranks | all-gather params + reduce-scatter grads | across nodes |
| Tensor (TP) | each matmul | activations, every layer, twice | inside a node (NVLink) |
| Pipeline (PP) | layers into stages | activations between stages; "bubbles" | across nodes |
| Sequence/context | the sequence dimension | attention KV | long-context training |
| Expert (EP, MoE) | experts | all-to-all token routing | across nodes; load imbalance risk |

**Collectives.** Ring all-reduce: each GPU sends/receives ≈ 2(N−1)/N × bytes. Bandwidth cost is ~flat in N, but the latency
term grows with N (trees/hierarchical algorithms fix it). NCCL "bus bandwidth" (busbw) is the number to compare against link speed.
**A collective is only as fast as its slowest link and its last-arriving rank.**

**Overlap and exposed communication.** Gradient buckets are all-reduced during backward. Only the part that takes longer than
the remaining backward compute is **exposed** and adds to step time. Smaller per-GPU batch or a slower network → more exposure.

**Straggler vs slow link: telling them apart** (scenarios 007 vs 009):
| | slow link / network | straggler GPU |
|---|---|---|
| step time | slower every step (or with the link's error rate) | slower whenever that GPU is slow (may be periodic) |
| compute time per rank | unchanged everywhere | **only the straggler's** is higher |
| time waiting in collectives | up on **all** ranks | up on all ranks **except the straggler** |
| where to look | IB link rate, symbol errors, NIC logs, busbw | clocks, temperature, power, DCGM/IPMI events |

**Failures and goodput.** At thousands of GPUs, something fails every few hours: GPU falls off the bus (XID 79), ECC errors,
NVLink errors, IB links, host OOM, filesystem hiccups. A synchronous job dies or hangs (NCCL timeout) on *any* failure.
- **Goodput** = productive training time / wall-clock time. The headline metric.
- Checkpoint interval (Young/Daly) ≈ √(2 × checkpoint_cost × MTBF). Async checkpointing (snapshot to CPU, upload in the background) makes it cheap.
- Fast restart: hot spare nodes, cached images, quick NCCL init, auto-cordon of bad nodes.
- **Silent data corruption** (a GPU that computes wrong numbers) shows up as loss or grad-norm spikes. Detect with cross-replica checks.

**Data pipeline.** Should never be on the critical path. Watch "dataloader wait" per step. CPU-heavy work (image decode,
augmentation, tokenization) belongs offline or on dedicated workers. Make resumption deterministic: sampler state goes in the checkpoint.

---

## 3. LLM inference serving

**Two phases:**
- **Prefill** processes the whole prompt in parallel. It's compute-bound and sets **TTFT** (time to first token).
- **Decode** generates one token per step for every running request. It's memory-bandwidth-bound (reads all weights + all
  active KV each step) and sets **TPOT/ITL** (time per output token, i.e. how smooth streaming feels).

**KV cache.** Per token: 2 × layers × kv_heads × head_dim × bytes. A 70B GQA model (80 layers, 8 KV heads, d=128, bf16) uses ~320 KB/token,
so a 32k-token conversation holds ~10 GB. **KV memory, not FLOPs, usually caps concurrency.** GQA/MQA, fp8 KV, and paged
allocation (PagedAttention) all exist to stretch it.

**Continuous batching.** Requests join and leave the running batch at every step. Bigger batch → much higher throughput
(weights are read once per step for everyone) at slightly higher TPOT. When KV is full: queue new requests (TTFT
grows) or **preempt** running ones (swap/recompute: wasted work).

**Long prompts** hurt everyone: they take KV (fewer concurrent requests) and, without **chunked prefill**, each long prefill
stalls every decode on that replica (TPOT spikes, "stutter"). Fixes: chunked prefill, separate long-context pools,
disaggregated prefill/decode, token-aware admission.

**Capacity signals:** KV-cache usage, waiting-queue depth, preemptions, prompt/generation tokens/s, TTFT/TPOT percentiles.
Not request rate, not GPU utilization, not GPU memory (pre-allocated) (scenario 008).

**Levers:** quantization (fp8/int4: memory + speed, quality risk), speculative decoding (good at low batch), prefix
caching (shared system prompts), tensor parallelism (more bandwidth + memory per replica, more communication).

---

## 4. Production ML quality ("the model is wrong but everything is green")

Failures that never show up in latency/error dashboards:
- **Training-serving skew:** the online feature differs from what the model was trained on (units, defaults, timezone,
  stale/fresh, a different code path). Signature: **calibration breaks** (predicted vs observed diverge), the prediction
  distribution shifts, only the segments that use the feature are affected, and PSI spikes on one feature (scenario 010).
- **Data drift:** the input population changes (new market, new product). Gradual PSI rise across many features.
- **Concept drift:** the relationship changes (behavior shift). Inputs are stable, but accuracy/calibration decays.
- **Feedback loops:** the model influences its own future training data (popularity bias).
- **Stale features / pipeline lag:** the streaming job falls behind, and features are silently minutes or hours old.
- **Label leakage** in training (features computed with future data): great offline metrics, bad online.

Monitoring: per-feature null/default rate, range violations, PSI/KL vs training, prediction distribution, calibration,
segment-level business KPIs, feature freshness lag, model/feature version pinning, canary + guardrail metrics on every
model **and feature-source** change.

---

## 5. ML failure-mode catalog (signatures)

| failure | first signal | decisive evidence |
|---|---|---|
| degraded IB link / NIC | tokens/s step down, exposed comm up | per-node IB link rate / symbol errors; NIC kernel logs (007) |
| straggler GPU (thermal/power/ECC) | erratic or periodic step time | one node's compute time & clocks; it alone doesn't wait (009) |
| dataloader-bound | GPU util down, dataloader wait up | host CPU 100%, prefetch queue empty, profiler gap before forward (011) |
| checkpoint stall | hang at checkpoint time → NCCL timeout | rank 0 still writing; shared-FS contention; ckpt write bw (012) |
| NCCL hang | step counter stops, GPUs at 100% "util" but idle power | watchdog / flight recorder shows the rank that never joined (012) |
| loss spike / divergence | loss and grad norm jump | per-source loss, shard IDs at spike, replay reproduces → data, not SDC (013) |
| MoE expert imbalance | step time ramps, all-to-all "slow" | per-expert token share, router entropy/aux loss, hot EP ranks (014) |
| KV-cache exhaustion | TTFT up, req/s flat | kv_cache_usage ~100%, waiting queue, preemptions, tokens/s up (008) |
| prefill interference | TPOT p99 spikes | long prompts arriving, no chunked prefill |
| training-serving skew | business KPI down, infra green | calibration, per-feature PSI, segment split (010) |
| hot partition in a feature/event pipeline | consumer lag on one partition | per-partition lag heatmap, key distribution (006) |
