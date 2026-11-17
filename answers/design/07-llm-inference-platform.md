# Rubric: LLM inference platform (SPOILERS)

## Strong answer covers
- **Memory:** 70B × 2 B (bf16) = 140 GB weights → needs ≥ 2 H100s, and in practice TP=4 or 8 for KV room and bandwidth. KV/token
  (80 layers, 8 KV heads, d=128, bf16) = 2·80·8·128·2 ≈ 320 KB. On 8×80 GB (×0.9) − 140 GB ≈ 500 GB → ~1.5M tokens → at an
  avg context ~1.65k ≈ 900 concurrent sequences (far fewer if long prompts are common: one 32k request = 20 average ones).
  FP8 halves both weights and KV.
- **Decode throughput** is memory-bandwidth-bound: per step read weights (140 GB) + active KV, at ~8×3.35 TB/s×0.8 ≈ 21 TB/s.
  That's ~7–15 ms per step + overhead, so at batch ~256 → ~10–20k tok/s per 8-GPU replica.
  Demand: 2,000 req/s × 300 out tokens = 600k output tok/s → **~40–60 replicas** (320–480 H100s), plus prefill:
  2,000 × 1,500 = 3M prompt tok/s × 2 × 70e9 FLOPs ≈ 4.2e17 FLOP/s ≈ 850 H100s at 50% MFU! **Prefill dominates compute.**
  A strong answer notices this (prefix caching for shared system prompts matters a lot) and sizes total GPUs to ~1,000+.
- **Engine:** continuous batching, PagedAttention (paged KV, no fragmentation), **chunked prefill** to protect TPOT, or
  disaggregated prefill/decode pools (prefill compute-bound, decode memory-bound). TP within a node over NVLink. Avoid TP across nodes.
- **Routing:** prefix-aware (consistent hashing on the system-prompt hash) balanced against load (KV usage, queue depth).
  Separate pools/queues for long-context and batch traffic.
- **Admission:** per-tenant **token** limits (TPM input+output, max context), weighted fair queuing, priority for interactive
  over batch, reserved capacity for enterprise. When KV is full: queue with bounded wait and fast 429 rather than
  timeouts. Preemption (recompute vs swap) only as a last resort.
- **Autoscaling:** on KV utilization / queue wait / tokens/s headroom. Cold start of a 70B replica takes minutes (weights
  from local NVMe or a peer, CUDA graphs), so keep warm headroom and scale on forecasts. GPU util is useless (always ~100%).
- **SLIs/alerts:** TTFT and TPOT percentiles per tenant tier, KV usage, num_waiting, preemption rate, 429/504 rates,
  prompt tokens/s vs req/s, goodput (tokens that met SLO).
- **Cost:** FP8/INT4 (quality risk → eval), speculative decoding (wins at low batch, less at high batch), prefix caching,
  batch tier at a discount on spare capacity.

## Scoring (10 pts)
- 2 pts: Correct memory math (weights, KV per token, concurrency) with derivation
- 2 pts: Throughput math: decode is bandwidth-bound, prefill compute-bound, replica/GPU count for peak (notices prefill cost)
- 2 pts: Engine design: continuous batching + paged KV + chunked prefill or P/D disaggregation; sensible TP
- 2 pts: Multi-tenant admission: token-aware limits, fair queuing/priorities, behavior when KV is full; routing trade-off
- 1 pt: Autoscaling on the right signal + cold-start handling
- 1 pt: Observability (TTFT/TPOT/KV/queue) and cost levers with trade-offs

Push back on: "scale on GPU utilization", "rate-limit by requests", and any replica count without tokens/s math.
