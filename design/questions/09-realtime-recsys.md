# Real-time recommendations with a feature store

_difficulty: medium-hard · ML systems_

Design the home-feed recommender for a video app with 100M daily users. Peak is 50k feed requests/s, each returning 30 items
from a catalog of 5M videos, with a **p99 < 150 ms** budget end to end. The ranking model should use features that are fresh within
minutes (what the user just watched), and the model is retrained daily.

## Address in your answer
1. **Serving architecture:** candidate generation (retrieval, ANN over embeddings) → ranking (heavy model) → re-ranking/business rules. A latency budget per stage.
2. **Feature store:** offline (training) vs online (serving) stores, streaming vs batch features, point-in-time correct training data, and how you prevent **training-serving skew** (scenario 010).
3. **Model serving:** CPU vs GPU for the ranker, batching, embedding tables that don't fit on one GPU.
4. **Training and rollout:** daily retraining pipeline, offline evaluation, shadow/canary/A-B, automatic rollback.
5. **Monitoring:** what tells you the model is *wrong* when every service is healthy?

Useful Lab widgets: `lab.html#cache`, `#fanout`, `#queueing`.

## How to submit
Paste your design to Claude with `grade design 09-realtime-recsys`.
