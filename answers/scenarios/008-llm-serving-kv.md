# Answer key: 008-llm-serving-kv (SPOILERS)

## Root cause
At 14:19 Sales upgraded tenant **acme-legal** to enterprise and raised its limit **10 → 300 requests/min** (no
**token** limit). From 14:20 acme's contract-review batch job ramped to ~1.6 req/s of **~28k-token prompts**
(~600 output tokens). That's only ~4% more *requests*, but prompt tokens/s went **37k → ~80k** (2.2×).

The real capacity limit for LLM serving is the **KV cache** (~120k tokens/replica). By Little's law, KV held =
arrival rate × context size × time in flight. Per replica: baseline ≈ 5 req/s × ~1k tokens × 7 s ≈ 36k tokens
(30%). Each acme request holds ~28.6k tokens for ~17 s, so at 0.2 req/s/replica that adds ~96k → **~110% of the pool**.
From ~14:28 the pool is full:
- New requests **wait for admission**: queue wait grows ~0.1–0.2 s per second. TTFT rises for **everyone**, not
  only acme, because the queue is FCFS and shared, and round-robin spreads acme over all replicas.
- Running requests get **preempted and recomputed**, which wastes prefill capacity and makes it worse.
- Waits hit the **60 s client timeout**, so 504s start (~14:41) at ~1 − 1/ρ of requests.

**Stutter (TPOT p99 ~1.2 s)** started *before* the KV saturation, right at 14:20. Prefill isn't chunked, so each 28k-token
prefill (~1.2 s at 24k tok/s) blocks decode steps for everyone on that replica.

Why the dashboards looked fine:
- **req/s** is flat: the change is in tokens per request.
- **GPU util** is ~97% always. nvidia-smi "utilization" is "a kernel was running", and continuous batching always has work.
- **GPU memory** is ~94% always: weights + the KV pool are **pre-allocated** at startup.
- The **autoscaler** scales on req/s per replica, so it never triggers.

## Key evidence
- `gateway:prompt_tokens_per_sec` 37k → 80k (and `avg_prompt_tokens` ~900 → ~1,900) while `gateway:rps` is flat.
- `llm/*:kv_cache_usage` climbs from ~30% at 14:20 to a flat **~99.6% ceiling** from ~14:28 on **all** replicas (heatmap: a
  uniform fleet-wide band, not one bad replica). `num_waiting` and `preemptions` start then.
- `gateway:tpot_p99` jumps at 14:20 (prefill stalls). `ttft_p50`/`ttft_p99` ramp linearly from ~14:28 (queue growth).
  `error_rate` (504) once waits hit 60 s.
- Logs: replica stats lines `GPU KV cache usage: 99.x%, Pending: N reqs`. `Sequence group ... preempted ... not enough
  KV cache space`. Gateway access log: `tenant=acme-legal prompt_tokens=24000–31800` (pattern grouping). The tenant-config reload
  line `rpm_limit=300 tpm_limit=unset`.
- Change log: acme's limit change at 14:19 precedes the ramp by a minute.
- Traces: time is in "queue: wait for KV cache admission" and "PREEMPTED: requeue + recompute". Prefill/decode for
  normal requests is unchanged.

## Red herrings
- **inference-server 0.9.3 (14:15)**: no change in any metric at 14:15. The startup log shows the same KV pool (120k tokens).
  The degradation follows the tenant ramp, not the deploy.
- **Moderation vendor (14:28–14:32)**: +300 ms for 4 minutes. That's nothing next to 30–60 s TTFT, and it resolved while TTFT kept climbing.
- **GPU util / memory "flat"**: these aren't saturation signals for LLM serving (see above).
- **"Traffic is normal"**: true in req/s, false in tokens.

## Mitigation (now)
- **Throttle acme-legal**: set a tokens-per-minute limit, or drop rpm back to e.g. 20 and move their batch job to a
  **batch/offline tier** or a dedicated pool. Tell them (they're a new enterprise customer, so be graceful: reserve
  dedicated capacity for them).
- Optionally route long-context (>8k) requests to a separate replica pool so consumer traffic recovers immediately.
- Manually add replicas (each adds ~120k KV tokens) while the limit takes effect. The queue drains within minutes once ρ < 1.

## Durable fixes
- **Token-aware admission and limits**: per-tenant TPM (input + output) and max concurrent context tokens, not just RPM.
  Fair queuing across tenants so one tenant can't fill the shared queue.
- **Autoscale on the real bottleneck**: KV cache usage, queue depth/wait time, or tokens/s, not req/s or GPU util.
- **Scheduler**: enable **chunked prefill** (bounds TPOT stalls from long prompts). Separate prefill/decode or
  long-context pools. Prefix caching for repeated system prompts (acme's prompts share a hash). KV-aware or
  least-loaded routing instead of round-robin.
- **Alerting / SLOs**: TTFT and TPOT percentiles, `kv_cache_usage` > 90% sustained, `num_waiting` > 0 sustained,
  preemption rate > 0. These fire ~10 min before 504s would.
- **Process**: Sales plan changes that raise limits should go through capacity review (tokens × context × duration).

## Real-world commands (how you'd confirm this in production)
- `curl :8000/metrics | grep vllm:` → `gpu_cache_usage_perc` ≈ 1.0, `num_requests_waiting` growing, `num_preemptions_total` rising,
  `prompt_tokens_total` rate ↑ while request rate is flat.
- Engine logs: `Sequence group ... preempted by PreemptionMode.RECOMPUTE`. Gateway access logs grouped by tenant and prompt length (Loki/ES query).
- `benchmark_serving.py` with acme-like prompts (28k in / 600 out) on one replica shows the KV ceiling directly.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Identifies KV cache exhaustion (kv_cache_usage ~100%, waiting queue, preemptions) as the saturated resource |
| 2 | Identifies the workload shift: acme-legal's long prompts (tokens/s ↑ with flat req/s) enabled by the 14:19 limit change |
| 1 | Explains why req/s, GPU util and GPU memory don't show it (token-based load, util semantics, pre-allocation) / why the autoscaler didn't act |
| 1 | Explains TTFT rise for all tenants (shared FCFS queue, round-robin) and the 504s (60 s timeout) |
| 1 | Explains TPOT stutter (un-chunked long prefill blocks decode) or preemption/recompute waste |
| 1 | Rules out the 0.9.3 deploy and moderation blip with evidence |
| 1 | Immediate mitigation: throttle/isolate acme (TPM limit / batch tier / separate pool), add capacity |
| 1 | Durable: token-aware limits + fair queuing, autoscale on KV/queue, chunked prefill / long-context pool, KV/TTFT alerts |
