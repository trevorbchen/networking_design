# Answer key — 002-search-gray-failure (SPOILERS)

## Root cause
At ~16:25 the cloud provider **live-migrated host h-2291**, which runs VM **node-17**, where
**search-shard-5** lives. On the new host, shard-5's VM suffers **CPU steal of ~30–38%**: a noisy
neighbor / oversubscribed hypervisor. The guest gets roughly 2/3 of the CPU time it asks for, so every query on
shard-5 runs slower and queues. Shard-5 p50 goes 4 → ~18 ms and **p99 goes 24 → ~400–470 ms**.

This is a **gray failure**: the process is up, `/healthz` returns 200 in a few ms, and there are no errors. The node
is degraded, not dead, so binary health checks and error-rate alerts don't see it.

## Why one bad shard ruins global p99 (fan-out amplification)
search-agg does scatter-gather and **waits for all 8 shards**. Request latency = **max** of 8 shard
latencies. Shard-5 is in every request, so its tail becomes everyone's tail. A broader version of the same math:
with N independent shards each having a 1% chance of being slow, P(request slow) = 1 − 0.99^N.
That's ~8% for N=8, and ~63% for N=100. Here one shard is *always* slow, so its p99 ≈ the system's p99.
p50 rises only modestly, which is a classic tail-latency signature.

## Key evidence
- Heatmap of `search-shard:latency_p99` (or `cpu_steal`): **one hot row (shard-5) starting at 16:25**.
- `search-shard/shard-5:cpu_steal` jumps 1% → 30%+. Every other shard stays < 1%.
- Shard-5 `cpu` (guest view) rises 48 → 70% with the same qps. It's doing the same work less efficiently.
- Traces: the parallel fan-out span's longest child is consistently `shard-5 query` (tag `node=node-17`).
- Logs: `slow shard response shard=5 ...` WARNs begin at 16:25. `node-exporter node-17: cpu steal above 20%`.
- Event: provider maintenance notice for the host running node-17, 8 s before onset.
- All shards serve the same qps, so it's not a hot shard / load imbalance.

## Red herrings
- **web v8.40.1 deploy at 16:15**: it came 10 min before onset and only caused a 1-minute blip in web p99. Agg/shard
  latency is unchanged until 16:25. A frontend change can't slow one backend shard.
- **shard-2** is consistently slightly slower (bigger segment), but that's stable and pre-existing.
- **shard-3 segment merge (~16:43)**: a short, self-resolving spike.
- **search-agg GC pauses**: periodic, present before the incident.

## Mitigation (now)
- **Move shard-5 off node-17**: cordon/drain the node, or stop/start the VM to land on a different host.
  If replicas exist, take shard-5's primary replica out of rotation.
- Escalate to the cloud provider with the steal-time evidence.

## Architectural / prevention
- **Hedged (backup) requests**: if a shard hasn't answered by ~p95, send the same query to another
  replica of that shard and take the first reply (Dean & Barroso, "The Tail at Scale").
- **Replicas per shard + outlier detection/ejection** (e.g. Envoy outlier detection on latency).
- **Partial results / per-shard deadline**: return results from 7/8 shards and mark the response degraded.
- Alert on **per-instance** latency deviation from the fleet (not just aggregates), and on **cpu_steal**.
- Health checks that measure real work latency (synthetic query), not just process liveness.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Isolates shard-5 (heatmap / traces / per-shard metrics) |
| 2 | Identifies CPU steal / noisy neighbor after the live migration of node-17 as the underlying cause |
| 2 | Explains fan-out: request latency = max over shards, so one slow shard dominates p99 |
| 1 | Explains why health checks / error alerts missed it (gray failure) |
| 1 | Rules out the web deploy (timing + mechanism) and/or the shard-3 merge |
| 2 | Mitigation (move off the host) + at least one tail-tolerance design (hedging, replicas+ejection, partial results) |
