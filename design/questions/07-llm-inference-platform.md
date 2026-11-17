# LLM inference platform (multi-tenant chat API)

_difficulty: hard · ML systems_

Design the serving platform behind a chat-completions API for a 70B-parameter model.
- 2,000 requests/s at peak. Average prompt is 1,500 tokens (p99 32k) and average output is 300 tokens. Responses stream.
- SLOs: **TTFT p95 < 1 s** for prompts ≤ 4k, **TPOT p95 < 50 ms**, 99.9% availability.
- Hundreds of tenants (free tier, enterprise with reserved capacity, internal batch jobs). Hardware: H100 80GB nodes (8 GPUs, NVLink).

## Address in your answer
1. **Capacity math:** weights and KV-cache memory per replica, max concurrent sequences, decode tokens/s per replica, number of replicas/GPUs for peak (show the derivation).
2. **The serving engine:** continuous batching, paged KV cache, prefill vs decode (chunked prefill or disaggregated prefill/decode), what parallelism (TP/PP) and why.
3. **Routing and admission:** how requests reach replicas (prefix-cache affinity vs load), token-aware rate limits, fair queueing across tenants, what happens when KV is full.
4. **Autoscaling:** which signal (not GPU util, not req/s alone), cold-start time of a 70B replica, and how you cover the gap.
5. **Observability:** the SLIs and alerts you'd put on the dashboard (see scenario 008 for what goes wrong without them).
6. **Cost levers:** quantization, speculative decoding, prefix caching, batch tier. What each one trades away.

Useful Lab widgets: `lab.html#llmserve`, `#roofline`, `#queueing`.

## How to submit
Write your design and paste it to Claude with `grade design 07-llm-inference-platform`. Expect follow-up questions on your numbers.
