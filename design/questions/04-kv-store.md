# Distributed key-value store

_difficulty: hard_

Design a Dynamo-style distributed KV store: `get(key)`, `put(key, value)`, multi-datacenter, always writable.

**Scale:** 10 PB, 5M ops/s, values ≤ 1 MB, 99.99% availability, tunable consistency.

## Address in your answer
1. Partitioning and rebalancing.
2. Replication strategy and quorum settings. What does R+W>N buy you and what doesn't it?
3. Conflict resolution for concurrent writes.
4. Failure detection and membership; handling temporary vs. permanent failures.
5. Storage engine on each node.

## How to submit
Write your design (bullets plus an ASCII diagram is fine) and paste it to Claude with `grade design 04-kv-store`. Claude may ask follow-up questions like an interviewer.
