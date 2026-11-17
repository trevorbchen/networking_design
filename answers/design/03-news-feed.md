# Rubric: News feed / timeline (SPOILERS)

## Strong answer covers
- Reads: 3B/day ≈ 35k/s avg, ~100k/s peak. Writes: 500M posts/day ≈ 6k/s, and push fan-out ×200 = ~1.2M timeline inserts/s avg. Heavy, but doable in a sharded in-memory store (Redis lists of post IDs, capped at ~800).
- **Hybrid**: push for normal users (precomputed timeline cache), pull for celebrities (merge their recent posts at read time). Otherwise one celebrity post = 50M writes.
- Storage: posts in a sharded KV/wide-column by post_id. The follow graph in a sharded store (both directions). Timelines as ID lists in cache, with rebuild from source on miss (cold users are not precomputed).
- Read path: fetch ID list → multi-get posts (fan-out → tail latency, so batch + cache posts) → rank → hydrate.
- Async fan-out via queue workers. Eventual consistency is acceptable. Delete/privacy changes need tombstones.
- Ops: hot shards, backlog of fan-out queue (consumer lag), cache cold start.

## Scoring (10 pts)
- 2 pts: Correct QPS + fan-out estimates
- 2 pts: Push vs pull trade-off and hybrid for celebrities
- 2 pts: Data model & storage choices
- 2 pts: Read path latency strategy (caching, batching, fan-out)
- 1 pts: Async fan-out pipeline & consistency
- 1 pts: Operational risks

Push back in follow-ups on any number given without a derivation.
