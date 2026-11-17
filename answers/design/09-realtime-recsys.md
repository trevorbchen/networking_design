# Rubric: Real-time recommendations with a feature store (SPOILERS)

## Strong answer covers
- **Funnel:** retrieval (two-tower embeddings + ANN index like HNSW/ScaNN, plus heuristics: trending, follows) → ~500–2,000
  candidates → ranker (GBDT or DNN, batched scoring) → re-rank (diversity, freshness, policy). Budget e.g. features 15 ms,
  retrieval 20 ms, ranking 40 ms, rerank 5 ms, network/slack the rest. Fan-out to feature shards means tail-latency care (hedging, caching).
- **Load:** 50k req/s × 1,000 candidates = 50M item-scorings/s → GPUs or very optimized CPU, with batching across requests.
- **Feature store:** offline store (warehouse/lake) for training with **point-in-time joins** (no label leakage), online store
  (Redis/KV) for low-latency reads. Streaming (Kafka/Flink) for fresh user features, batch for heavy aggregates.
  **One feature definition** used for both paths (or log features at serving time and train on the logs). Schemas with
  types/units/ranges validated at write and read. Backfill + shadow-compare before switching sources.
- **Embedding tables:** large (100M users × 128 floats ≈ 51 GB in fp32), so shard them across hosts/GPUs (model parallel), cache
  hot rows, or use hashing/quantization.
- **Rollout:** daily training → offline metrics (AUC/NDCG, calibration, slice metrics) → shadow → canary with guardrail
  KPIs → A/B → ramp. Auto-rollback on calibration/CTR regressions. Model and feature versions pinned together.
- **Monitoring quality:** per-feature drift (PSI/KL), null/default rates, out-of-range counts, prediction distribution,
  calibration (pred/obs), segment-level KPIs (new vs returning, country, device), freshness lag of streaming features.

## Scoring (10 pts)
- 2 pts: Multi-stage funnel with a latency budget and load math
- 2 pts: Feature store design: offline/online, streaming/batch, point-in-time correctness
- 2 pts: Concrete training-serving-skew prevention (shared definitions or logged features, schema/unit validation, shadow-compare)
- 1 pt: Model serving: batching, hardware choice, large embedding handling
- 2 pts: Safe rollout pipeline with rollback
- 1 pt: Quality monitoring beyond RED metrics (drift, calibration, segments)
