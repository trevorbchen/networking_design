# System design primer

## Interview / design-review framework (≈45 min)
1. **Requirements (5 min).** Functional: the 3–5 core features. Non-functional: scale (DAU, QPS), latency
   targets, consistency needs, availability, durability, geography. *Ask, don't assume.*
2. **Estimates (5 min).** QPS (avg and peak), storage per year, bandwidth, read:write ratio. Use
   `lab.html#envelope`. Decide what matters: is it storage-bound, QPS-bound, or fan-out-bound?
3. **API + data model (5 min).** Endpoints, entities, access patterns. **Access patterns drive the database choice.**
4. **High-level design (10 min).** Clients → LB → stateless services → caches → databases / queues /
   object storage. Draw the request path for the 2 most important operations.
5. **Deep dives (15 min).** The interesting part: the hard bottleneck (hot keys, fan-out, consistency,
   ordering, exactly-once). Discuss trade-offs explicitly.
6. **Operations (5 min).** Failure modes, what you'd monitor (golden signals per component), how you'd
   deploy safely, and what breaks first at 10× load.

## Building blocks and when to use them
| block | use for | watch out for |
|---|---|---|
| Load balancer (L4/L7) | spreading load, health checks, TLS termination | sticky sessions, uneven load, gray failures |
| Stateless service tier | horizontal scaling | hidden state (local caches, sessions) |
| Cache (Redis/Memcached, CDN, in-process) | read-heavy data, hot keys | invalidation, stampedes, cold start, consistency |
| Relational DB (Postgres/MySQL) | transactions, joins, constraints | write scaling, connection limits, replication lag |
| Wide-column / KV (Cassandra, DynamoDB) | huge write volume, simple access by key | data modeling by query, no joins, eventual consistency |
| Document DB (MongoDB) | flexible schema, aggregate-oriented reads | transactions across documents, unbounded docs |
| Search (Elasticsearch) | full-text, faceted search | it's not a primary store; reindexing |
| Message queue / log (Kafka, SQS) | decoupling, buffering, async work, event sourcing | ordering per partition only, consumer lag, duplicates |
| Object storage (S3) | blobs, backups, data lake | latency per request, eventual listing |
| Time-series DB | metrics | cardinality explosions |
| Consensus (etcd/ZooKeeper, Raft) | leader election, config, locks | it's slow and small; don't put data in it |

## Core trade-offs to be fluent in
- **Consistency vs. availability/latency (CAP, PACELC).** Under a partition, choose. Without one, you still trade
  latency for consistency. Know linearizable vs. sequential vs. causal vs. eventual, and
  read-your-writes / monotonic reads.
- **Replication**: single-leader (simple, failover pain), multi-leader (conflicts), leaderless quorums
  (`lab.html#quorum`). Sync vs. async (durability vs. latency).
- **Partitioning/sharding**: by hash (even, no range scans), by range (range scans, hot spots), consistent
  hashing (`lab.html#hashing`). Rebalancing cost. Secondary indexes (local vs. global).
- **Storage engines**: B-tree (read-optimized, in-place) vs. LSM (write-optimized, compaction)
  (`lab.html#lsm`).
- **Transactions & isolation** (`lab.html#isolation`): know lost update and write skew, and how to prevent
  them (atomic ops, SELECT FOR UPDATE, serializable).
- **Push vs. pull** (fan-out on write vs. on read, e.g. feeds), **sync vs. async** processing.
- **Exactly-once** is really *at-least-once + idempotency* (idempotency keys, dedup tables, transactional outbox).
- **Caching strategy**: cache-aside, read-through, write-through, write-back. TTL + invalidation, and stampede
  protection (`lab.html#cache`).
- **Back-pressure & overload**: rate limiting (`lab.html#ratelimit`), load shedding, bounded queues,
  timeouts and retry budgets (see scenario 003).
- **Tail latency**: fan-out, hedging, timeouts per hop (`lab.html#fanout`).

## Database selection cheat sheet
- Need multi-row transactions/invariants (money, inventory)? → relational (or Spanner/Cockroach for global scale).
- Write-heavy, key-based access, massive scale, tolerate eventual consistency? → Cassandra/DynamoDB.
- Ad-hoc analytics over lots of data? → columnar warehouse (BigQuery, Snowflake, ClickHouse), fed by CDC/ETL.
- Ephemeral counters, leaderboards, rate limits, sessions? → Redis.
- "Show me things like X"? → search engine or vector index alongside the primary store.

## Useful numbers
See `lab.html#envelope`. Memorize the orders of magnitude: 1 day ≈ 10⁵ s. 1M req/day ≈ 12 req/s. RAM
read ~100 ns. SSD read ~100 µs. Same-DC round trip ~0.5 ms. Cross-continent ~100 ms.
A Postgres primary handles thousands to tens of thousands of simple QPS. A Kafka partition handles ~10 MB/s.

## Classic reading
*Designing Data-Intensive Applications* (Kleppmann). Google SRE book (free online). "The Tail at Scale" (Dean &
Barroso). "Metastable Failures in Distributed Systems" (Bronson et al., HotOS '21). Dynamo paper. Spanner
paper. Raft paper. Amazon Builders' Library (timeouts/retries/backoff, load shedding).
