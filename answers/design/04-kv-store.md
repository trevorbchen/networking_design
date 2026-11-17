# Rubric: Distributed key-value store (SPOILERS)

## Strong answer covers
- Consistent hashing with virtual nodes (`lab.html#hashing`). Rebalancing moves ~1/N of data, so stream it with throttling.
- N=3 per DC. R/W tunable (`lab.html#quorum`). R+W>N gives overlap, but not linearizability under sloppy quorums / concurrent writes. LOCAL_QUORUM per DC + async cross-DC.
- Conflicts: last-write-wins (simple, loses data, needs clocks) vs. vector clocks / version vectors with siblings and app merge, or CRDTs.
- Temporary failures: hinted handoff + sloppy quorum. Permanent: replace and stream from replicas. Anti-entropy with Merkle trees, plus read repair.
- Membership via gossip with phi-accrual failure detection. No single master for data. Optionally a small consensus-backed config service.
- Storage: LSM (write-heavy, `lab.html#lsm`). Commit log, memtable, SSTables, bloom filters, compaction strategy (size-tiered vs. leveled) and its effect on read/write amplification.
- Ops: hot partitions, compaction storms, repair costs, tombstones.

## Scoring (10 pts)
- 2 pts: Partitioning with vnodes + rebalancing
- 2 pts: Quorum semantics stated precisely (incl. limits)
- 2 pts: Conflict resolution options with trade-offs
- 2 pts: Failure handling: hinted handoff, anti-entropy, gossip
- 1 pts: Storage engine reasoning (LSM)
- 1 pts: Multi-DC strategy

Push back in follow-ups on any number given without a derivation.
