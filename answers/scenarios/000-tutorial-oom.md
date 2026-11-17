# Answer key — 000-tutorial-oom (SPOILERS)

## Root cause
Deploy **resizer v2.3.0** (14:10, PR #812) added an in-memory thumbnail cache with
`maxEntries=unbounded`. Every resized image is retained, so heap grows linearly with
traffic (~1.3–1.8 MiB/s per pod) until the container hits its **1.5 GiB limit** and the
kernel OOM-kills it (`OOMKilled`, exit code 137). The pod restarts empty, and the cycle repeats every
~12–15 minutes per pod. The cycles are staggered because the rolling deploy started the pods 45s apart and
each pod leaks at a slightly different rate.

## Why users see 502s
In-flight requests on the dying pod get `connection reset by peer`. The LB does **not retry
POSTs**, because they're non-idempotent, so they surface as 502. Capacity also drops 4→3 pods for ~20s
during restart. In the ~90s before each kill, full-GC pauses of 0.6–1.9s add latency.

## Key evidence (what a strong report cites)
- `resizer/*:memory` heatmap/chart: flat ~380 MiB before 14:10, then a **sawtooth** that
  climbs to the 1.5 GiB limit and drops to 0.
- Logs: `kubelet ... reason=OOMKilled exitCode=137`, with timestamps matching the `lb:5xx_rate` spikes.
- `resizer/*:restarts` stepping up. `pods_ready` dips to 3.
- Startup log line: `thumbnailCache=enabled maxEntries=unbounded`.
- WARN `G1 Full GC pause ... heap 9x% used` right before each kill. `gc_pause_ms` spikes.
- Change log: v2.3.0 deploy is the only change right before the pattern begins.

## Red herrings
- **Blobstore latency blip ~14:38** (provider status page). It's short and unrelated to the periodic pattern.
- **CPU spikes**: these come from JIT warm-up after restart plus GC thrash near the limit. They're a symptom, not the cause.
- Traffic (`lb:rps`) is a gentle sine and doesn't correlate with the failures.

## Mitigation (now)
- **Roll back to v2.2.x** (best), or set the cache to disabled/bounded via config if a flag exists.
- Stopgap: raise the memory limit to buy time. This lengthens the cycle but doesn't fix it.

## Prevention (long-term)
- Bound the cache (max entries / max bytes, LRU), or use an external cache (Redis/CDN) instead of heap.
- Make the JVM heap aware of the container limit and keep headroom for off-heap use.
- Alerts: **memory working set > 85% of limit for 5m**, **container restarts > N/hour**,
  **OOMKilled events**. Any of these fires before customer-visible 502s.
- Canary deploys with a soak period long enough to see slow leaks (≥ 1 cycle). Compare memory slope between canary and baseline.
- LB/client: idempotency keys so POST retries are safe. Graceful shutdown/drain.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 3 | Identifies memory leak → OOMKill sawtooth, tied to the v2.3.0 unbounded cache |
| 2 | Cites concrete evidence (memory pattern + OOMKilled logs aligned with 5xx spikes) |
| 1 | Explains why it surfaces as 502 (in-flight resets, no POST retry) |
| 1 | Dismisses at least one red herring with reasoning |
| 1 | Correct immediate mitigation (rollback) |
| 2 | Good prevention: bounded cache + a memory/restart alert + canary/soak |
