# Observability primer: the industry vocabulary

If you know distributed systems from papers and courses, this is the missing piece: **how practitioners
actually see a running system**. The nsys analogy holds well:

| nsys / GPU profiling | Distributed systems equivalent | Where in the Observatory |
|---|---|---|
| Timeline of kernels per stream | Timeline of events, log volume, request latencies per service | **Timeline** tab |
| Kernel summary (total / avg / count) | Span breakdown: self time and calls per request per service·operation | **Traces → Breakdown** |
| One kernel's execution | One request's trace waterfall | **Traces** (click a row) |
| SM occupancy / bandwidth counters | Utilization & saturation metrics (CPU, pool usage, queue depth, IOPS) | **Metrics** |
| Per-SM view to spot imbalance | Per-instance heatmap to spot the one bad host | **Heatmap** |
| Memory copies stalling compute | Waiting on a pool / lock / network hop rather than computing | trace gaps, `*_wait_ms` |

## The three pillars
1. **Metrics**: numeric time series, cheap and aggregated (e.g. `checkout:latency_p99` every 10 s). Good for
   *detecting* and *localizing*. Bad for individual requests.
2. **Logs**: discrete events with text. Good for *why* (exception messages, config printed at startup).
   High volume, so you search and group them into patterns.
3. **Traces**: one request's path through services as a tree of timed spans. Good for *where the time
   goes* and for fan-out/retry structure. They're sampled (you see a fraction of requests).

Plus **events / change log** (deploys, config flips, scaling, cron jobs). Most incidents are caused by a
change, so the first question on any page is: *what changed?*

## Signal methodologies
- **Four golden signals** (Google SRE book): **latency, traffic, errors, saturation**. Your first dashboard.
- **RED** (for request-driven services): **R**ate, **E**rrors, **D**uration.
- **USE** (for resources: CPU, disks, pools, queues): **U**tilization, **S**aturation, **E**rrors. Saturation is
  the most important and most often missing one: *is work waiting?* (run-queue length, pool pending
  threads, queue depth, CPU steal).

A useful mental model: RED tells you **that** a service is hurting. USE on its resources tells you **why**.

## Percentiles, not averages
- p50 = typical user. p99 = 1 in 100 requests. Users who make many requests (or one request that fans
  out) hit your p99 constantly. Averages hide bimodal behavior ("most requests fast, some time out").
- **Tail latency** dominates at scale. With fan-out N, P(slow) = 1 − (1−p)^N (see `lab.html#fanout`).
- You can't average percentiles across hosts. Look at per-instance values or histograms (heatmaps).

## Saturation and thresholds (the "knee")
Queueing theory: waiting time ∝ ρ/(1−ρ). At 50% utilization, waiting is about equal to service time. At 90%, it's
~9×. At 99%, ~99×. That's why:
- capacity planning targets ~60–75% at peak, and
- **alert on saturation before latency**: pool > 80%, CPU run-queue > cores, queue depth growing.
- **Little's law** `L = λW` is the most useful equation in operations. `connections_in_use = qps × hold_time`.
  If a deploy doubles hold time, you need double the connections at the same traffic.

Play with `lab.html#queueing`.

## Alerts and SLOs
- **SLI**: a measured ratio, e.g. % of requests < 300 ms and non-5xx. **SLO**: the target (99.9% per 30 days).
  **Error budget**: 1 − SLO (43 min/month at 99.9%).
- **Burn-rate alerts**: page when you're consuming budget fast (e.g. 14× rate over 1 h), not on every spike.
- Symptom-based alerts (user pain) page. Cause-based alerts (disk 85%) create tickets. In the incident
  reports, "what alert would have caught this earlier?" usually means a *saturation* or *leading* signal.

## Reading the tools well
- **Shape vocabulary:** step (a change/deploy), ramp (traffic/leak), sawtooth (leak + restart, GC, TTL
  cycles), periodic spikes (cron, TTL, batch), plateau at a round number (a hard limit: pool max, rate limit,
  max_connections, a timeout like exactly 1000 ms), flat-line at 0 (dead / not reporting).
- **Round numbers are clues.** A latency that tops out at 3000 ms is a timeout. A gauge stuck at 20 is a pool size.
- **Ratios between metrics** reveal mechanisms: downstream rps / user rps = amplification. Queries per
  request. Completed vs. received.
- **Earliest mover, not biggest mover.** Symptoms cascade, so the cause usually starts moving first.
- **Correlation is not causation.** Everything driven by traffic correlates with everything else.
- **Per-instance before aggregate.** One bad host out of 8 is a 12% blip in the average and 100% of the
  tail. Use the heatmap.
- **Gaps in traces** (time no span covers) = queueing, GC pauses, or network.

## Typical industry tools (what these views imitate)
Metrics: Prometheus + Grafana, Datadog, CloudWatch. Logs: Elasticsearch/Kibana, Loki, Splunk.
Traces: Jaeger, Tempo, Honeycomb, Datadog APM (OpenTelemetry for instrumentation). Profiles: pprof,
async-profiler, Pyroscope. Kubernetes: `kubectl get events`, `kubectl top`. Hosts: `top`, `vmstat` (look at the
`st` steal column), `iostat`, `ss`.
