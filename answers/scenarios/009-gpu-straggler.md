# Answer key: 009-gpu-straggler (SPOILERS)

## Root cause
At **03:18:40** fan **FAN6 on node-23** failed (IPMI: 0 RPM, redundancy lost). **GPU 6 on node-23 (global rank 182)**
lost cooling. It now runs a thermal cycle: it heats from ~79 °C to 88 °C in ~150 s, hits the slowdown threshold, and the GPU
**drops its SM clock 1980 → ~1110 MHz** (HW_THERMAL_SLOWDOWN) for ~90 s while it cools, then recovers. A 240 s period, forever.

While throttled, that one rank's forward+backward takes 1.62 s × 1980/1110 ≈ **2.9 s** instead of 1.62 s. Collectives are
synchronous, so **all 255 other ranks wait** for rank 182 inside the reduce-scatter. Step time goes 2.0 s → **3.24 s** for
~90 s of every 4 min. The average is ~2.32 s (−14% throughput).

**Why rank 0 blames NCCL:** waiting for a late rank is counted as time inside the NCCL kernel. The rank-0 profile shows
`nccl_s` 0.18 → 1.45 s, and the "bandwidth" derived from collective duration collapses (310 → 36 GB/s). But the actual
wire time is unchanged (`wire_time_ms` 180 in trace tags). The network team confirms the fabric is clean. The NCCL upgrade
happened at 03:05, and the job was fine for 13 minutes after it.

**The tell:** in a straggler incident **everyone waits except the straggler**. node-23's `nccl_wait_min_s` stays at 0.18 s
during the slow windows while every other node's jumps to ~1.46 s. Its `compute_s_max` is the only one that rises.

## Key evidence
- `train:step_time_s`: a **square wave** (2.0 ↔ 3.24 s), period **240 s**, starting ~03:19:40 → a control loop (thermostat).
- **Heatmap `compute_s_max`**: only node-23 lights up, in sync with the slow windows.
- **Heatmap `nccl_wait_min_s`**: every node bright in the slow windows **except node-23** (the inverted signal).
- **`sm_clock_min`** node-23: 1980 → 1110 MHz blinking. **`gpu_temp_max`** node-23: sawtooth 79 → 88 °C. **`gpu_power_min`** drops when throttled.
- Logs node-23: `ipmi-sel: Fan FAN6 ... 0 RPM`, `Fan redundancy lost`, then repeating `dcgm: GPU 6 clocks event reasons: HW_SLOWDOWN, HW_THERMAL_SLOWDOWN active (temp 88C)` / `cleared (temp 79C)`.
- Traces: slow steps have `last_rank_to_join: 182`, `rank0_wait_ms ≈ 1270`, `wire_time_ms 180`. Fast steps have random last ranks.

## Red herrings
- **NCCL 2.21 upgrade (03:05)**: 13 min of normal steps after it. Wire time is unchanged, and "bandwidth" only drops in the windows
  where rank 182 is late. The rank-0 profiler measures *waiting*, not transfer.
- **Data mixture v14 (03:30)**: sequences are packed to 8192 tokens, so compute per step is constant (`avg_seq_len` changed but
  `compute_s` didn't). The slowdown started 11 min earlier. Loss up slightly from the new mix is expected.
- **node-9 hot (85 °C)**: warm all week, below the 88 °C slowdown point, and its clocks never drop.
- **Fabric**: link errors ~0, all ports 400G.

## Mitigation (now)
- **Cordon node-23** and restart from the latest checkpoint on a spare node (or on 31 nodes with adjusted grad accumulation).
  A restart costs minutes. The straggler costs ~14% of a 256-GPU job continuously.
- File a hardware ticket: replace FAN6 and inspect GPU 6. Don't return the node until a burn-in shows stable clocks.
- (If no spare: lower the power cap on node-23 GPU 6 to stop the oscillation. That's still slower, but it gives predictable step time.)

## Durable fixes
- **Straggler detection**: per-rank compute time / collective arrival order (NCCL flight recorder, per-rank step timers).
  Alert when one rank's compute deviates > X% from the median, and auto-cordon and restart.
- **Hardware health → scheduler**: alert on IPMI fan/PSU events and DCGM clock-event reasons (thermal/power slowdown), and
  drain nodes proactively. Track `sm_clock_min` per node, not just temperature.
- Teach the dashboards the difference between **wire time and wait time**. "NCCL is slow" on one rank usually means
  "someone else is late".
- Keep hot spares and frequent (async) checkpoints so cordon-and-restart is cheap.

## Real-world commands (how you'd confirm this in production)
- `nvidia-smi -q -d PERFORMANCE -i 6` on node-23 → `HW Slowdown: Active`, `HW Thermal Slowdown: Active` during slow windows.
- `nvidia-smi dmon -s pct -i 6` → SM clock dropping to ~1100 MHz, temperature sawtooth. `ipmitool sel list` → FAN6 lower critical.
- PyTorch NCCL flight recorder / per-rank step timers → rank 182 always last to enter the collective.
- `dcgmi diag -r 3` on the node after draining (it may pass if cooled: hardware tickets need the IPMI evidence).

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Identifies node-23 GPU 6 (rank 182) as a thermal-throttling straggler (fan failure) |
| 2 | Shows it with per-node evidence: compute_s_max / sm_clock_min / temp sawtooth on node-23, plus IPMI/DCGM logs or trace last_rank_to_join |
| 1 | Notes the inverted signal: the straggler waits least in collectives (nccl_wait_min_s) |
| 1 | Explains why rank 0's profiler/NCCL bandwidth blames communication (wait time counted inside collectives; wire time unchanged) |
| 1 | Explains the periodicity (thermal control loop: heat → throttle → cool) |
| 1 | Rules out NCCL upgrade, data mixture, node-9 with evidence (1 pt for at least two) |
| 1 | Mitigation: cordon node-23 + restart from checkpoint on spare; hardware ticket |
| 1 | Prevention: straggler detection (per-rank timing) + hardware/thermal event alerting feeding auto-drain |
