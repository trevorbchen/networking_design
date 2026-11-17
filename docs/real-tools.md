# From the Observatory to real tools

The Observatory simulates the *views*. On the job you'll use these tools. This doc maps every tab to the real tools that provide it,
then lists the commands an ML-infra / SRE engineer actually runs, grouped by question. (Specific commands for each scenario are in
its answer key under "Real-world commands", so they don't spoil anything here.)

## 1. Tab → real tool

| Observatory tab | Backend / distributed systems | ML / GPU systems |
|---|---|---|
| **Brief** (alert + context) | PagerDuty / Opsgenie alert, Slack incident channel, runbook | same, plus experiment tracker (W&B, MLflow) run page |
| **Service Map** | Grafana service graph, Jaeger/Tempo dependency graph, Kiali (Istio) | job topology: Slurm / Kubernetes (Kueue, Volcano) job view, NCCL topology dump |
| **Metrics** | Prometheus + Grafana, Datadog, CloudWatch | DCGM exporter → Prometheus, W&B/TensorBoard training curves, `nvidia-smi dmon` |
| **Heatmap** | Grafana heatmap/table panels by `instance` label, Datadog host map | per-node/per-GPU DCGM panels, per-rank timing tables, per-expert / per-partition dashboards |
| **Timeline** | deploy annotations in Grafana, Argo CD / Spinnaker history, k8s events, audit logs | job scheduler events (`sacct`, `kubectl get events`), IPMI SEL, config/PR history |
| **Traces** | OpenTelemetry → Jaeger / Tempo / Honeycomb / Datadog APM | **Nsight Systems (`nsys`)**, `torch.profiler` → Perfetto / TensorBoard, NCCL flight recorder |
| **Logs** | Loki / Elasticsearch-Kibana / CloudWatch Logs / `kubectl logs` | rank logs (torchrun), `dmesg` / `journalctl`, DCGM health, `NCCL_DEBUG=INFO` output |
| **Report** | postmortem doc (Google SRE format) | same |

**Perfetto export:** the Traces tab has **⤓ → Perfetto** buttons. They save Chrome trace JSON that opens at
<https://ui.perfetto.dev> ("Open trace file"). Each endpoint becomes a process and each service a thread (`gpu`, `nccl`,
`dataloader`, ...), and aggregate metrics become counter tracks. That's the same layout `torch.profiler` and nsys exports give you.
In Perfetto: `W/S` zoom, `A/D` pan, click a slice for its args (tags), select a range to get per-slice totals, and use the
query (SQL) page, e.g. `select name, count(*), avg(dur)/1e6 as avg_ms from slice group by name order by avg_ms desc`.

## 2. GPU / node health

```bash
nvidia-smi                                   # util, memory, temp, power, processes
nvidia-smi -q -d PERFORMANCE                 # clock event reasons: HW_SLOWDOWN, SW_THERMAL, POWER_CAP, SYNC_BOOST
nvidia-smi -q -d CLOCK,TEMPERATURE,POWER,ECC # clocks, thermals, power cap, ECC counters
nvidia-smi dmon -s pucvmet -d 1              # per-second power/util/clock/violations/mem/ECC/thermal stream
nvidia-smi topo -m                           # GPU↔GPU/NIC topology (NVLink, PCIe, NUMA affinity)
dcgmi diag -r 1|2|3                          # health diag (1 = quick, 3 = long burn-in)
dcgmi dmon -e 1001,1002,1003,1004,1005       # DCGM profiling fields: graphics/SM active, SM occupancy, tensor active, DRAM active
dmesg -T | grep -iE 'xid|nvrm|mlx5|nvlink'   # XID errors (e.g. 79 = fell off the bus, 48 = double-bit ECC), NIC events
ipmitool sel list | tail                     # BMC events: fans, PSUs, temperatures
```
"SM active" / "tensor active" from DCGM is the real utilization. `nvidia-smi` util only means "a kernel was running".

## 3. Network / collectives

```bash
ibstat; ibv_devinfo                          # port state + negotiated rate (expect 400 Gb/sec NDR) per HCA
perfquery -x; ibqueryerrors                  # IB port counters: SymbolErrorCounter, LinkDownedCounter, PortRcvErrors
ibdiagnet                                    # fabric-wide check (run by the network team)
NCCL_DEBUG=INFO NCCL_DEBUG_SUBSYS=INIT,NET    # which NICs/rings/algorithms NCCL picked; async IB events
./build/all_reduce_perf -b 8 -e 8G -f 2 -g 8 # nccl-tests: compare busbw with expected (~370-390 GB/s intra-node H100, ~45 GB/s/NIC inter-node)
TORCH_NCCL_TRACE_BUFFER_SIZE=2000            # PyTorch NCCL flight recorder: dump on timeout to see which rank never joined
TORCH_NCCL_DUMP_ON_TIMEOUT=1
```

## 4. Profiling a training step (the nsys loop)

```bash
nsys profile -t cuda,nvtx,osrt,cudnn,cublas --capture-range=cudaProfilerApi \
     --cuda-memory-usage=true -o step_profile python train.py      # then: nsys stats step_profile.nsys-rep
nsys stats --report cuda_gpu_kern_sum,nvtx_sum step_profile.nsys-rep
```
```python
from torch.profiler import profile, schedule, ProfilerActivity, tensorboard_trace_handler
with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA],
             schedule=schedule(wait=5, warmup=2, active=3),
             on_trace_ready=tensorboard_trace_handler("./tb"), record_shapes=True, with_stack=True) as prof:
    for step, batch in enumerate(loader):
        train_step(batch); prof.step()
print(prof.key_averages().table(sort_by="cuda_time_total", row_limit=15))
# prof.export_chrome_trace("trace.json")  → open in ui.perfetto.dev
```
What to look for (the questions the Traces tab trains): idle gaps before forward (dataloader), NCCL kernels not overlapped with
compute (exposed comm), long `cudaStreamSynchronize`/`.item()` calls (CPU sync), small kernels with launch gaps (use CUDA
graphs / `torch.compile`), memcpy H2D on the critical path (pin memory, non_blocking).

Dataloader check without a profiler: time `next(iter(loader))` alone, and `py-spy top --pid <worker>` / `htop` on workers.

## 5. LLM serving

```bash
curl -s localhost:8000/metrics | grep -E 'vllm:(gpu_cache_usage_perc|num_requests_(running|waiting)|num_preemptions_total|time_to_first_token_seconds|time_per_output_token_seconds|prompt_tokens_total|generation_tokens_total)'
python benchmarks/benchmark_serving.py --backend vllm --dataset-name random --random-input-len 2000 --random-output-len 300 --request-rate 20
```
SGLang / TensorRT-LLM / TGI expose equivalents (KV usage, queue, TTFT/ITL histograms). Engine flags worth knowing:
`--enable-chunked-prefill`, `--max-num-batched-tokens`, `--gpu-memory-utilization`, `--kv-cache-dtype fp8`, `--enable-prefix-caching`.

## 6. Shared storage, Kafka, data quality

```bash
lfs df -h; lctl get_param mdt.*.md_stats     # Lustre capacity, metadata op rates (MDS load)
iostat -x 1; nfsiostat 1                     # device / NFS latency and throughput
kafka-consumer-groups.sh --bootstrap-server $B --describe --group fulfillment   # per-partition lag (sum hides hot partitions!)
kafka-topics.sh --describe --topic order-events                                  # partitions, leaders, ISR
```
Feature/data quality: Great Expectations / Deequ checks, Evidently / WhyLabs / Arize drift (PSI, KL) and calibration
dashboards, and a SQL `GROUP BY source` on per-batch metadata for training data.

## 7. Kubernetes / backend

```bash
kubectl get events --sort-by=.lastTimestamp | tail -30
kubectl top pods; kubectl describe pod <p>   # OOMKilled, restarts, throttling
kubectl rollout history deploy/<d>; kubectl rollout undo deploy/<d>
ss -s; ss -tanp state time-wait | wc -l      # socket states, port exhaustion
pg_stat_activity / pg_stat_replication       # Postgres: running queries, replica replay lag
```

## 8. Habit to build
For every scenario you finish, write one line in your report: **"In production I would have run ___ to confirm."**
The Report tab has a section for it, and the grader gives feedback on it. It's the habit interviewers and on-call leads look for.
