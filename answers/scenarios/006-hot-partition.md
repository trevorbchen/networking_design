# Answer key: 006-hot-partition (SPOILERS)

## Root cause
At 17:10 **order-service v8.1.0** changed the Kafka producer key from `order_id` to **`merchant_id`**
(for per-merchant ordering). Partition = `hash(key) % 12`, so **every MegaMart order now lands on
partition 7**. Before the sale MegaMart was ~110 orders/s, so p7 went from ~120 → ~230 msg/s. That's
hotter, but still under the ~420 msg/s that a single sequential consumer can process. At 17:25 the **flash sale** pushed
MegaMart to ~730/s, and **p7 got ~830 msg/s against 420 msg/s of capacity**. The backlog grows by ~400 msg/s
(~1 min of delay added per ~1 min that passes; lag reaches ~730k msgs / ~29 min by 18:00).

The sale by itself would have been harmless. With `order_id` keys the load spreads over 12 partitions
(12 × 420 ≈ 5,000 msg/s of capacity vs ~2,200 demanded). **The key change turned the skew of one merchant into a single hot partition.**

**Why scaling 6 → 12 pods didn't help:** within a consumer group, a partition is consumed by at most one
consumer, and processing within a partition is sequential. p7's throughput is capped at 420/s no matter how
many pods exist. The scale-up just moved p7 from pod-4 to pod-8, and the **rebalance paused every partition for ~30 s**
(a small lag bump everywhere at 17:40).

**Why only some small merchants:** any merchant whose `merchant_id` hashes to partition 7 shares MegaMart's
queue (head-of-line blocking). That's about 1/12 of the other merchants. Everyone else's p50 stays ~1.4 s. That's why
`confirm_delay_p50` is flat while `confirm_delay_p99` climbs to tens of minutes.

## Key evidence
- **Heatmap `order-events/*:lag`**: one bright row (p7). Every other partition is ~0 (except a 30 s bump at the rebalance).
  `fulfillment:group_lag` is just p7.
- **`order-events/p7:consume_rate` flat-topped at ~420**: saturation of one sequential worker. `produce_rate` on p7 steps
  up **at 17:10 (deploy)** and again at 17:25 (sale). p2 also steps up at 17:10 (merchant m-0417): more evidence that keying changed.
- **Change log**: the deploy message says outright "producer key order_id → merchant_id".
- **order-service logs**: `key=` switches from `o-…` to `m-…` at 17:10. `partition=7` lines are dominated by `merchant=m-0001`
  but also include random small merchants.
- **Fulfillment pod CPU is only ~70% (pod-4) / ~55% (pod-8)**: a trap. One worker thread pegs **1 of 2 vCPU**, so the pod
  average hides a 100%-busy thread. The WARN log "partition=7 consumer falling behind ... worker busy 100%" confirms it.
- **Traces**: the "queue wait" span dominates (minutes) and its `partition` tag is always 7. Traces on other partitions wait ~25 ms. Tags show the
  `merchant` and `partition`.
- `notify:confirm_delay_p50` flat vs. `p99` climbing.

## Red herrings
- **Broker disk filling up**: caused by the `clickstream` retention change (3d → 7d) at 17:18. It's a linear slope on all
  three brokers, still far from full, and unrelated to the order-events backlog. Brokers' produce latency is flat at ~4 ms.
- **broker-2 bytes_in higher / CPU slightly up**: broker-2 leads p7, so this is a *symptom* of the skew, not a cause.
- **Payments latency blip (17:15–17:17)**: real, resolved, before the incident. It reduced produce briefly, if anything.
- **"It's just sale volume"**: total demand (~2.2k/s) is well below total capacity (~5k/s). Total consumption only dips
  because p7 is capped.
- **Scaling consumers**: no effect beyond the number of partitions or for a single hot partition. It caused a rebalance pause.

## Mitigation (now)
- **Revert v8.1.0 (key back to `order_id`)**. New orders spread evenly immediately. The existing ~p7 backlog still needs draining:
  it drains at ~420/s, so ~30 min. Speed that up by
  temporarily running a **drain consumer** that reads p7 and processes in parallel by `order_id` (fulfillment
  doesn't actually need per-merchant ordering), or re-publish the p7 backlog keyed by `order_id` to a fresh topic.
- Communicate: the delayed small merchants are on p7, and MegaMart's queue is ~X min behind.

## Durable fixes
- **Pick partition keys by the ordering you actually need** and check key cardinality/skew. If per-merchant ordering is
  needed for the dashboard, use a **separate topic** (or a key like `merchant_id + order_id % N` to salt hot merchants),
  or derive ordering downstream (sequence numbers, per-merchant event versions).
- **Parallelize within a partition** with per-key ordering (e.g. a parallel consumer keyed by `order_id`), so one
  partition's capacity is not one thread.
- Load-test with a **realistic skew** (top merchant × sale multiplier), not uniform traffic.
- **Alert on `max(partition lag)` and on lag in *seconds*** (consumer time-lag), not just the sum. Alert on
  `confirm_delay_p99`. A sum alert hides which partition is hot and fires late.
- Monitor per-thread/worker utilization, not only pod CPU. Treat a flat-topped `consume_rate` as saturation.
- Avoid scale-up rebalances during incidents, or use cooperative/incremental rebalancing and static membership.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Identifies a single hot partition (p7), not "the consumer group/Kafka is slow" |
| 2 | Root cause: the key change to `merchant_id` (17:10 deploy) + MegaMart's skew during the sale; notes the sale alone was within capacity |
| 1 | Explains why scaling consumers didn't help (≤1 consumer per partition, sequential processing; rebalance pause) |
| 1 | Explains why only some small merchants are affected (they hash to p7, head-of-line blocking) / p50 vs p99 |
| 1 | Notices pod CPU < 100% is misleading (one thread of 2 vCPU saturated) or uses the flat-topped consume rate |
| 1 | Rules out broker disk / broker-2 / payments with evidence |
| 1 | Immediate mitigation: revert key + plan to drain the existing p7 backlog |
| 1 | Durable: key choice / salting / separate topic or in-partition parallelism + per-partition / time-lag alerting |
