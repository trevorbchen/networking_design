# Rubric: Metrics ingestion pipeline (the Observatory, for real) (SPOILERS)

## Strong answer covers
- Volume: 50k × 2k / 10 s = 10M points/s. At ~16 B raw/point that's 160 MB/s; with Gorilla-style compression it's ~1.5 B/point.
- Agents → regional collectors → **Kafka** (durable buffer, partitioned by series hash) → ingesters → TSDB (in-memory head block + compressed chunks, flushed to object storage: Prometheus/Mimir/M3 style).
- Storage: columnar per series; delta-of-delta timestamps + XOR floats; inverted index from labels to series IDs.
- Retention: raw for 15 d, then 1-min and 1-h rollups (min/max/avg/count, not averages of percentiles; keep histograms/sketches).
- Cardinality: a label like user_id explodes series count, which means memory, index size, and query fan-out. Enforce limits per tenant.
- Queries: shard by series and time. Cache step-aligned query results. Fan-out query → tail latency.
- Alerting: evaluate close to ingestion. Detect "no data" vs. "zero". Track pipeline lag as its own SLO, and alert on staleness. Meta-monitoring (who watches the watcher).

## Scoring (10 pts)
- 2 pts: Correct volume estimate
- 2 pts: Durable buffered ingestion (queue) with backpressure
- 2 pts: TSDB storage/compression reasoning
- 2 pts: Retention/downsampling done right (no avg of percentiles)
- 1 pts: Cardinality risks & limits
- 1 pts: Alerting reliability under lag

Push back in follow-ups on any number given without a derivation.
