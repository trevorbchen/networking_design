# Debugging playbook & failure-mode catalog

## The loop (what experienced on-call engineers actually do)
1. **Stabilize your picture of impact.** Who's affected, since when, how badly? (Error rate, latency, which
   endpoints.) Is it getting worse?
2. **What changed?** Deploys, config/feature flags, traffic shifts, infra events, cron jobs, dependency
   status pages. Compare the timing of each change to **onset**, not to the alert.
3. **Localize.** Follow the request path on the service map. Which component's latency/errors move first?
   Per-instance or fleet-wide? (Heatmap.) One endpoint or all?
4. **Find the saturated resource (USE).** CPU, memory, pools, threads, queues, disk, network, locks,
   external quotas. Look for a metric pinned at a ceiling or a queue that grows.
5. **Get the mechanism.** Traces (where time goes, calls per request), logs (exception text, config at
   startup), ratios. Be able to explain *why* the change caused the saturation, ideally with numbers.
6. **Mitigate before you fully understand.** Rollback, flag off, shed load, drain a node, scale. Stop the
   bleeding first. The root cause can wait 20 minutes. The users can't.
7. **Separate trigger from root cause from sustaining mechanism.** "The DB failed over" (trigger) vs.
   "retries amplified load 10×" (why it didn't recover) vs. "no retry budget" (root cause in design).
8. **Write it up blamelessly**: timeline, impact, causes, what went well/poorly, action items.

## Cognitive traps
- **Anchoring on the first anomaly** (often a symptom, like CPU going up because threads are spinning).
- **Blaming the last deploy** without checking its timing or mechanism.
- **"The database is slow"**: verify with DB-side latency vs. client-side latency. The gap is queueing in
  between (pools, threads, network).
- **Averages**: an aggregate that barely moved can hide one instance on fire.
- **Fixing the trigger instead of the amplifier.**

## Failure-mode catalog
Use this for ideas. Each one shows a characteristic signature in the tools.

| failure mode | signature | typical fix |
|---|---|---|
| Memory leak → OOMKill | sawtooth memory to limit, restarts counter, exit 137, 502s at kill times | rollback; bound caches; memory alerts |
| Connection-pool exhaustion | pool active pinned at max, acquire wait ↑, DB itself fine | reduce hold time, batch queries, size pools via Little's law |
| N+1 queries | queries/request ↑ after a deploy, many identical spans per trace | batching / joins / caching |
| Retry storm / metastable failure | downstream rps ≫ user rps, stays broken after trigger ends | retry budgets, backoff+jitter, deadlines, shedding |
| Thundering herd / cache stampede | periodic DB spikes at TTL period; aligned hit-ratio dips | TTL jitter, singleflight, stale-while-revalidate |
| Hot key / hot partition | one shard or partition's load ≫ others; consumer lag on one partition | key salting, splitting, local caching |
| Gray failure / noisy neighbor | one instance slow but "healthy"; cpu_steal / disk latency on that host | outlier ejection, hedging, drain host |
| GC pauses | latency spikes aligned with GC metrics; trace gaps | heap tuning, allocation reduction |
| Lock contention | throughput plateaus while CPU is low; lock wait metrics | narrower locks, sharding, optimistic concurrency |
| Replication lag / stale reads | replica lag ↑; read-after-write bugs; long query on replica | read-your-writes routing, lag-aware LB |
| Queue backlog / consumer lag | lag grows linearly; producer rate > consumer rate | scale consumers, fix slow handler, backpressure |
| Head-of-line blocking | one slow request type delays all in a shared pool/queue | bulkheads (separate pools) |
| Timeout misconfiguration | upstream timeout < downstream; work continues for abandoned callers | timeout budgets that decrease with depth |
| DNS / cert / clock problems | sudden total failures at a specific time; TLS errors; skew | automation, monitoring of expiry and NTP |
| Disk full / inode exhaustion | writes fail; disk used at 100% | retention, alerts at 80% |
| Rate limit / quota from a vendor | 429s from an external API at a round-number rate | client-side limiting, quota increases, caching |
| Bad config push / feature flag | step change exactly at the config event, fleet-wide | staged rollouts, config validation |
| Split brain / failover issues | two primaries, write conflicts, or long failover | fencing, consensus-based leader election |
| Autoscaler oscillation | instance count sawtooth; latency spikes during scale events | cooldowns, scale on leading metrics |
| Kernel/network limits | conntrack table full, ephemeral ports exhausted, SYN backlog drops | tune sysctls, connection reuse |

## Writing a strong report
- **Root cause** as a mechanism chain: *change → resource effect → saturation → symptom*.
- **Numbers.** "Pool 20/20 from 12:05, wait 3000 ms (= timeout), queries/request 3 → 9 at the 11:50 deploy."
- **Timeline** with onset (not alert time).
- **Ruled out**, with reasons. This shows judgment.
- **Mitigation vs. prevention**, plus the alert that would have fired earlier.
