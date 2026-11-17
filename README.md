# Observatory: distributed-systems debugging & design practice

A local, zero-install practice ground for turning distributed-systems knowledge into **industry-style
debugging and design skill**.

It does **not** run a real distributed system. It simulates **the tools you'd use to debug one**:
dashboards, a service map, per-instance heatmaps, a timeline, distributed traces, and logs. That's the
equivalent of NVIDIA nsys for microservices. Claude writes realistic incidents (with red herrings). You investigate them in
the GUI, write an incident report, and paste it back to Claude to be graded against a hidden answer key.

**Focus: ML systems.** Most new scenarios are ML infrastructure incidents: distributed training (NCCL/InfiniBand,
straggler GPUs, step-time profiles that look like nsys timelines), LLM inference serving (KV cache, batching, TTFT/TPOT),
and production ML quality (training-serving skew, drift, calibration). Classic backend incidents are included too.

There's also a **Concepts Lab** of interactive visualizations: ML ones (GPU roofline, LLM serving / KV-cache
calculator, distributed-training step time & scaling) and classic ones (queueing, consistent hashing, quorums, LSM
trees, caching, isolation levels, rate limiting, capacity estimation). Plus **system-design questions** with rubrics,
including ML platform designs.

## Quick start
1. Open `index.html` in a browser (double-click works, no server needed). Chrome/Edge/Firefox all work.
2. Start with **`000-tutorial-oom`**. It walks you through every tab.
3. When you're done, go to the **Report** tab → **Copy as Markdown** → paste it to Claude (in Claude Code, running in this folder).

## The loop with Claude
| you say | Claude does |
|---|---|
| `new scenario` / `new scenario about kafka lag, hard` | writes `scenarios/NNN-*.js` + a hidden answer key, validates it, and tells you the id |
| *(paste your report)* | grades it against `answers/scenarios/<id>.md`, explains what you missed, logs it to `progress/log.md` |
| `give me a hint for 002` | a nudge toward the right tool, without spoilers |
| `design question` / `grade design 03-news-feed` | runs an interview-style design session, grades with `answers/design/` |
| `what should I practice next?` | reads `progress/log.md` and picks a weak spot |

**Don't open `answers/`.** It's the answer keys.

## The Observatory tabs
| tab | what it's for | real-world equivalent |
|---|---|---|
| Brief | the page you got: alert, context, architecture notes, change log, hints | PagerDuty + wiki + deploy log |
| Service Map | topology colored by health; scrub/play through time | Datadog service map, Kiali |
| Metrics | dashboards + metric explorer; drag to zoom, thresholds, pin, correlate, top movers | Grafana / Prometheus |
| Heatmap | one row per instance: find the one bad host | Grafana heatmaps, per-host views |
| Timeline | events, log volume per service, and every trace on one time axis | nsys timeline, Honeycomb |
| Traces | request waterfalls + Breakdown table (self time, calls/trace) | Jaeger / Tempo / APM |
| Logs | search (text or /regex/), level/source filters, pattern grouping | Kibana / Loki / Splunk |
| Report | structured write-up + pinned evidence → copy as Markdown | postmortem doc |

Keyboard: `p` pins the value under the cursor, `z` zooms out, `Esc` closes dialogs. Double-click a chart to reset zoom.

## Scenarios included
| id | difficulty | theme |
|---|---|---|
| 000-tutorial-oom | easy | tutorial: intermittent 502s |
| 001-checkout-pool | medium | checkout p99 explodes at lunch |
| 002-search-gray-failure | medium | slow search, all health checks green |
| 003-retry-storm | hard | the DB came back, the site didn't |
| 004-cache-stampede | medium | product pages error every five minutes |
| 005-stale-reads | medium | saved settings keep reverting (DB replication) |
| 006-hot-partition | medium | order confirmations 30 min late (Kafka / streaming) |
| 007-training-slowdown | medium | **ML** · pretraining run a third slower overnight (128 GPUs) |
| 008-llm-serving-kv | hard | **ML** · chatbot slow and timing out, traffic normal (LLM serving) |
| 009-gpu-straggler | hard | **ML** · training step time keeps jumping (256 GPUs) |
| 010-feature-skew | hard | **ML** · recommendation CTR down 30%, nothing broken |
| 011-dataloader-bound | medium | **ML** · new dataset made training 35% slower |
| 012-checkpoint-hang | hard | **ML** · run keeps crashing with NCCL timeouts, no progress |
| 013-loss-spikes | medium | **ML** · loss keeps spiking, then NaN |
| 014-moe-imbalance | hard | **ML** · MoE run gets slower every hour |

Design questions: 01 url-shortener · 02 rate-limiter · 03 news-feed · 04 kv-store · 05 ticketing · 06 metrics-pipeline ·
**07 llm-inference-platform · 08 training-platform · 09 realtime-recsys** (ML).

## Folder layout
```
index.html, observatory.html, lab.html   the three pages
assets/js/engine.js      scenario compiler (telemetry DSL → data); also used by the validator
assets/js/charts.js      dependency-free charts
assets/js/observatory.js the debugging console
assets/js/lab.js         Concepts Lab widgets
scenarios/               one file per incident + manifest.js
answers/                 SPOILERS: answer keys & rubrics
design/questions/        system-design prompts (classic + ML platforms)
docs/                    primers (start with observability-primer.md)
reports/, progress/      your graded reports and progress log
tools/validate.js        `node tools/validate.js` checks every scenario
scripts/                 resume_after_reset.sh (auto-resume a Claude session later)
```

## Docs
- `docs/observability-primer.md`: golden signals, RED/USE, percentiles, saturation, how to read the tools, and the nsys analogy.
- `docs/debugging-playbook.md`: the investigation loop, cognitive traps, and a catalog of ~20 failure modes with their signatures.
- `docs/ml-systems-primer.md`: GPU performance (roofline, MFU), distributed training (parallelism, collectives, stragglers,
  checkpointing), LLM serving (KV cache, batching, TTFT/TPOT), production ML (skew, drift, calibration), and their failure signatures.
- `docs/system-design-primer.md`: the interview framework, building blocks, trade-offs, and DB selection.
- `docs/scenario-format.md`: how scenarios are written (for Claude, or for you to write your own).
- `CLAUDE.md`: instructions Claude follows in this repo.

## Development
No build step. `node tools/validate.js` validates scenarios (needs Node ≥ 18). Everything else is static files.
