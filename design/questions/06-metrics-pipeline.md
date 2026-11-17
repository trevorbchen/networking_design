# Metrics ingestion pipeline (the Observatory, for real)

_difficulty: hard_

Design the backend that powers dashboards like the Observatory: 50k hosts each emit 2k metric series every 10 s; users query dashboards over the last 1h–30d; alerts evaluate every 30 s.

**Requirements:** ingest must survive spikes and backend outages without losing data; dashboard queries over 1h should be < 1 s.

## Address in your answer
1. Ingestion path from agents to storage, including buffering.
2. Storage format for time series (and why not a row per point in Postgres).
3. Downsampling/retention.
4. High-cardinality labels: what goes wrong?
5. How alert evaluation stays reliable when the pipeline is lagging.

## How to submit
Write your design (bullets plus an ASCII diagram is fine) and paste it to Claude with `grade design 06-metrics-pipeline`. Claude may ask follow-up questions like an interviewer.
