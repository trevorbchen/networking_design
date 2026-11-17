/* Scenario 006 — "Order confirmations are 30 minutes late."
 * Answer key: answers/scenarios/006-hot-partition.md  (don't peek!) */
OBS.register((function () {
  const T_DEPLOY = 600, T_RET = 1100, T_SALE = 1500, T_SCALE = 2400, PAUSE = 30, CAP = 420, NP = 12;
  const HOT = 7, BIG2 = 2; // partitions that the two largest merchants hash to (after the key change)
  const orders = (t) => 1500 + 150 * Math.sin(t / 700);
  const mm = (t) => 110 + (t < T_SALE ? 0 : 620 * Math.min(1, (t - T_SALE) / 240) * (1 - 0.15 * Math.max(0, t - T_SALE - 240) / 1860));
  const big2 = () => 70;
  const total = (t) => orders(t) + (mm(t) - 110);
  // produce rate per partition
  function inRate(p, t) {
    if (t < T_DEPLOY) return total(t) / NP; // keyed by order_id → uniform
    const rest = (total(t) - mm(t) - big2()) / NP;
    return rest + (p === HOT ? mm(t) : 0) + (p === BIG2 ? big2() : 0);
  }
  const capAt = (t) => (t >= T_SCALE && t < T_SCALE + PAUSE ? 0 : CAP); // consumer-group rebalance pauses everyone
  // integrate backlog per partition at 1 s resolution
  const LAG = [], CONS = [];
  for (let p = 0; p < NP; p++) {
    const L = new Float64Array(3602), C = new Float64Array(3602);
    let q = 0;
    for (let t = 0; t <= 3601; t++) {
      const inn = inRate(p, t), cap = capAt(t);
      const c = Math.min(cap, q + inn);
      q = Math.max(0, q + inn - c);
      L[t] = q; C[t] = c;
    }
    LAG.push(L); CONS.push(C);
  }
  const at = (arr, t) => arr[Math.max(0, Math.min(3601, Math.round(t)))];
  const lagMsgs = (p, t) => at(LAG[p], t);
  const lagSec = (p, t) => lagMsgs(p, t) / CAP;
  const consumed = (p, t) => at(CONS[p], t);
  // weighted quantile of end-to-end confirmation delay across partitions
  function delayQ(t, q) {
    const rows = [];
    let W = 0;
    for (let p = 0; p < NP; p++) { const w = inRate(p, t); rows.push([lagSec(p, t) + 1.4, w]); W += w; }
    rows.sort((a, b) => a[0] - b[0]);
    let acc = 0;
    for (const [d, w] of rows) { acc += w; if (acc >= q * W) return d; }
    return rows[rows.length - 1][0];
  }
  const podOf = (p, t) => (t < T_SCALE ? Math.floor(p / 2) + 1 : p + 1); // range assignor
  const podCpu = (i, t) => {
    if (t < T_SCALE && i > 6) return 0;
    let c = 6;
    for (let p = 0; p < NP; p++) if (podOf(p, t) === i) c += (consumed(p, t) / CAP) * 50; // one worker thread per partition = 1 of 2 vCPU
    return c;
  };
  const leader = (p) => (p % 3) + 1;
  const vendor = (t) => (t > 900 && t < 1050 ? 1 : 0);
  const pickPartition = (t, h) => {
    let W = 0; const w = [];
    for (let p = 0; p < NP; p++) { w.push(inRate(p, t)); W += w[p]; }
    let r = h.noise(0.5) + 0.5; r = Math.min(0.9999, Math.max(0, r)) * W;
    for (let p = 0; p < NP; p++) { r -= w[p]; if (r <= 0) return p; }
    return NP - 1;
  };
  const PARTS = Array.from({ length: NP }, (_, k) => k);
  const merchantFor = (p, t, h) => {
    if (t >= T_DEPLOY && p === HOT && h.chance(mm(t) / inRate(p, t))) return 'm-0001';
    if (t >= T_DEPLOY && p === BIG2 && h.chance(big2() / inRate(p, t))) return 'm-0417';
    return 'm-' + String(h.int(2000, 9800)).padStart(4, '0');
  };

  return {
    id: '006-hot-partition',
    title: 'Order confirmations are 30 minutes late (for some merchants)',
    difficulty: 'medium',
    tags: ['kafka', 'partitioning', 'consumer lag', 'hot key', 'skew', 'stream processing'],
    startTime: '2026-11-13T17:00:00Z',
    duration: 3600, step: 10, seed: 606,
    brief: {
      severity: 'SEV-2',
      alert: 'fulfillment consumer group lag > 150k messages',
      firedAt: 2100,
      summary: `<p><b>Basket</b> is a grocery-delivery marketplace. After checkout, an <code>order.created</code> event goes to Kafka. The <b>fulfillment</b> service consumes it, assigns a picker and sends the "Order confirmed" push. Normally that takes ~1–2 s.</p>
        <p>Since around 17:30, customers are complaining that confirmations arrive <b>many minutes late (and it keeps getting worse)</b>, or the order sits at "Pending". MegaMart, the biggest merchant, started a flash sale at 17:25, and a lot of complaints are about them. But support also reports late confirmations from <b>small, unrelated shops</b>.</p>
        <p>Colleagues' takes so far: <i>"Kafka is struggling: broker disks are filling up and broker-2 is taking way more traffic."</i> <i>"It's just sale volume. We doubled the fulfillment consumers at 17:40, give it time."</i> <i>"Payments was flaky earlier, maybe orders are stuck there."</i></p>`,
      task: '<p>Find out why confirmations are delayed, why the scale-up didn\'t fix it, and why some non-MegaMart orders are affected while most aren\'t. Propose an immediate mitigation and a durable fix.</p>',
      questions: [
        'Where exactly is the backlog? Is it the whole consumer group, or something narrower?',
        'Why did doubling the consumers not help?',
        'Why are some small merchants affected, but not most?',
        'What changed that turned a big sale into an incident? (The sale alone isn\'t the answer.)',
        'Immediate mitigation? Durable fix, and what should the alert have been?',
      ],
    },
    architecture: `<ul>
      <li><b>order-service</b> (6 pods) → produces <code>order.created</code> to topic <b>order-events</b>: <b>12 partitions</b>, replication factor 3, on brokers <b>broker-1..3</b>. Partition = <code>hash(key) % 12</code>.</li>
      <li><b>fulfillment</b> is a consumer group (HPA, min 6 pods). Each pod is 2 vCPU and runs <b>one worker thread per assigned partition</b>. Messages within a partition are processed <b>sequentially</b> (~2.4 ms each: picker assignment + DB write), i.e. ≈ <b>420 msg/s per partition</b> max.</li>
      <li>Kafka rule: a partition is consumed by <b>at most one</b> consumer in a group.</li>
      <li>fulfillment → <b>orders-db</b> (writes) and → <b>notify</b> → push provider.</li>
      <li>order-service calls <b>payments</b> (external) synchronously <i>before</i> producing the event.</li>
      <li>Normal peak: ~1,600 orders/s.</li></ul>`,
    hints: [
      'A consumer group\'s lag is a <b>sum</b>. Break it apart: the Heatmap shows every partition side by side.',
      'Compare <code>produce_rate</code> per partition before and after 17:10. What decides which partition a message lands on? Then think about what one partition can do with one consumer, however many pods you add.',
      'Search order-service logs for <code>partition=7</code>, and compare the <code>key=</code> field before and after the 17:10 deploy. Which merchant shares a partition with MegaMart?',
    ],
    topology: {
      nodes: [
        { id: 'client', kind: 'client', x: 0, y: 50 },
        { id: 'order-service', kind: 'service', x: 20, y: 50, health: 'order-service:latency_p99', thresholds: [800, 2000] },
        { id: 'payments', kind: 'external', x: 22, y: 12, health: 'payments:latency_p99', thresholds: [800, 1500] },
        { id: 'kafka', kind: 'queue', x: 44, y: 50, health: 'fulfillment:group_lag', thresholds: [20000, 150000], desc: 'topic order-events, 12 partitions, brokers 1-3' },
        { id: 'fulfillment', kind: 'worker', x: 66, y: 50, health: 'fulfillment:max_pod_cpu', thresholds: [80, 95] },
        { id: 'orders-db', kind: 'db', x: 70, y: 88, health: 'orders-db:write_latency_p99', thresholds: [20, 50] },
        { id: 'notify', kind: 'service', x: 86, y: 30, health: 'notify:confirm_delay_p99', thresholds: [10, 120] },
        { id: 'push', kind: 'external', x: 98, y: 60 },
      ],
      edges: [
        { from: 'client', to: 'order-service', metric: 'order-service:orders_rps' },
        { from: 'order-service', to: 'payments' },
        { from: 'order-service', to: 'kafka', metric: 'order-service:produce_rate', async: true },
        { from: 'kafka', to: 'fulfillment', metric: 'fulfillment:consume_rate' },
        { from: 'fulfillment', to: 'orders-db' },
        { from: 'fulfillment', to: 'notify' },
        { from: 'notify', to: 'push', async: true },
      ],
    },
    metrics: [
      { entity: 'order-service', name: 'orders_rps', unit: 'req/s', fn: (t, h) => total(t) * (1 + h.noise(0.02)) },
      { entity: 'order-service', name: 'produce_rate', unit: 'msg/s', fn: (t, h) => total(t) * (1 - 0.3 * vendor(t)) * (1 + h.noise(0.02)) },
      { entity: 'order-service', name: 'latency_p99', unit: 'ms', fn: (t, h) => 240 + 1900 * vendor(t) + h.noise(20) },
      { entity: 'order-service', name: 'error_rate', unit: '%', fn: (t, h) => 0.1 + 2.5 * vendor(t) + Math.abs(h.noise(0.05)) },
      { entity: 'payments', name: 'latency_p99', unit: 'ms', desc: 'external payment provider', fn: (t, h) => 180 + 1900 * vendor(t) + h.noise(15) },
      { entity: 'order-events/p{i}', instances: PARTS, name: 'produce_rate', unit: 'msg/s', fn: (t, h, i) => inRate(i, t) * (1 + h.noise(0.03)) },
      { entity: 'order-events/p{i}', instances: PARTS, name: 'consume_rate', unit: 'msg/s', fn: (t, h, i) => consumed(i, t) * (1 + h.noise(0.015)) },
      { entity: 'order-events/p{i}', instances: PARTS, name: 'lag', unit: 'msgs', desc: 'log-end offset minus committed offset', fn: (t, h, i) => lagMsgs(i, t) + Math.abs(h.noise(40)) },
      { entity: 'fulfillment', name: 'group_lag', unit: 'msgs', desc: 'sum of lag over all partitions', fn: (t, h) => { let s = 0; for (let p = 0; p < NP; p++) s += lagMsgs(p, t); return s + Math.abs(h.noise(300)); } },
      { entity: 'fulfillment', name: 'consume_rate', unit: 'msg/s', fn: (t, h) => { let s = 0; for (let p = 0; p < NP; p++) s += consumed(p, t); return s * (1 + h.noise(0.01)); } },
      { entity: 'fulfillment', name: 'replicas', unit: 'pods', fn: (t) => (t < T_SCALE ? 6 : 12) },
      { entity: 'fulfillment/pod-{i}', instances: 12, name: 'cpu', unit: '%', desc: '% of the pod\'s 2 vCPU', fn: (t, h, i) => (podCpu(i, t) ? podCpu(i, t) + h.noise(2) : 0) },
      { entity: 'fulfillment', name: 'max_pod_cpu', unit: '%', fn: (t, h) => { let m = 0; for (let i = 1; i <= 12; i++) m = Math.max(m, podCpu(i, t)); return m + h.noise(1.5); } },
      { entity: 'notify', name: 'confirm_delay_p50', unit: 's', desc: 'order placed → confirmation push sent', fn: (t, h) => delayQ(t, 0.5) * (1 + h.noise(0.04)) },
      { entity: 'notify', name: 'confirm_delay_p99', unit: 's', fn: (t, h) => delayQ(t, 0.99) * (1 + h.noise(0.04)) },
      { entity: 'orders-db', name: 'write_latency_p99', unit: 'ms', fn: (t, h) => 7 + 2 * Math.max(0, (total(t) - 1600) / 600) + h.noise(0.8) },
      { entity: 'orders-db', name: 'cpu', unit: '%', fn: (t, h) => 30 + 0.012 * total(t) + h.noise(2) },
      { entity: 'kafka/broker-{i}', instances: 3, name: 'bytes_in', unit: 'B/s', desc: 'produce traffic to partitions this broker leads + replication', fn: (t, h, i) => { let s = 0; for (let p = 0; p < NP; p++) s += inRate(p, t) * (leader(p) === i ? 1 : 2 / 3); return (s * 1200 + 4.2e6) * (1 + h.noise(0.03)); } },
      { entity: 'kafka/broker-{i}', instances: 3, name: 'cpu', unit: '%', fn: (t, h, i) => 22 + (i === leader(HOT) ? 0.004 * inRate(HOT, t) : 0) + h.noise(2.5) },
      { entity: 'kafka/broker-{i}', instances: 3, name: 'disk_used', unit: '%', fn: (t, h, i) => 58 + i * 2 + (t > T_RET ? 0.0042 * (t - T_RET) : 0) + h.noise(0.05) },
      { entity: 'kafka/broker-{i}', instances: 3, name: 'request_latency_p99', unit: 'ms', desc: 'produce request latency', fn: (t, h) => 4 + h.noise(0.5) },
    ],
    dashboards: [
      { title: 'Fulfillment overview', charts: [
        { title: 'Consumer group lag', series: ['fulfillment:group_lag'], threshold: 150000 },
        { title: 'Produce vs consume', series: ['order-service:produce_rate', 'fulfillment:consume_rate'] },
        { title: 'Confirmation delay', series: ['notify:confirm_delay_p50', 'notify:confirm_delay_p99'] },
        { title: 'Fulfillment pod CPU', series: ['fulfillment/*:cpu'] },
        { title: 'Order-service latency', series: ['order-service:latency_p99', 'payments:latency_p99'] },
        { title: 'Kafka broker disk', series: ['kafka/*:disk_used'], threshold: 85 },
      ] },
      { title: 'Kafka brokers', charts: [
        { title: 'Bytes in', series: ['kafka/*:bytes_in'] },
        { title: 'Broker CPU', series: ['kafka/*:cpu'] },
        { title: 'Produce latency p99', series: ['kafka/*:request_latency_p99'] },
        { title: 'Disk used', series: ['kafka/*:disk_used'] },
      ] },
    ],
    events: [
      { t: T_DEPLOY, kind: 'deploy', entity: 'order-service', msg: 'order-service v8.1.0: producer key order_id → merchant_id (FUL-212: guarantee per-merchant event ordering for the new merchant dashboard)' },
      { t: 900, kind: 'info', entity: 'payments', msg: 'payments provider status page: "elevated latency, investigating"' },
      { t: 1060, kind: 'info', entity: 'payments', msg: 'payments provider: resolved' },
      { t: T_RET, kind: 'config', entity: 'kafka', msg: 'topic clickstream: retention.ms 3d → 7d (analytics request)' },
      { t: T_SALE, kind: 'traffic', entity: 'client', msg: 'MegaMart flash sale live: push campaign to 2.1M users' },
      { t: 2100, kind: 'alert', entity: 'kafka', msg: 'ALERT fulfillment consumer group lag > 150k' },
      { t: T_SCALE, kind: 'scale', entity: 'fulfillment', msg: 'fulfillment scaled 6 → 12 pods (manual, on-call)' },
    ],
    logs: [
      { entity: (t, h) => 'order-service/pod-' + h.int(1, 6), level: 'INFO', rate: 2, msg: (t, h) => {
        const p = pickPartition(t, h), m = merchantFor(p, t, h), oid = 'o-' + h.hex(8);
        return 'produced order.created order=' + oid + ' merchant=' + m + ' key=' + (t < T_DEPLOY ? oid : m) + ' partition=' + p;
      } },
      { entity: 'order-service/pod-2', level: 'INFO', t: T_DEPLOY + 5, msg: 'starting order-service v8.1.0 (producer.key=merchant_id, partitioner=murmur2)' },
      { entity: (t, h) => 'order-service/pod-' + h.int(1, 6), level: 'WARN', rate: (t) => vendor(t) * 0.6, msg: (t, h) => 'payments authorize slow: ' + h.int(1500, 4200) + 'ms (retrying once)' },
      { entity: (t, h) => 'order-service/pod-' + h.int(1, 6), level: 'ERROR', rate: (t) => vendor(t) * 0.12, msg: 'payments authorize timeout after 5000ms; order rejected' },
      { entity: (t, h) => 'fulfillment/pod-' + h.int(1, t < T_SCALE ? 6 : 12), level: 'INFO', rate: 0.6, msg: (t, h) => {
        const p = pickPartition(t, h);
        return 'committed offsets partition=' + p + ' batch=500 took=' + Math.round(500 * 2.4 * (1 + h.noise(0.1))) + 'ms lag=' + Math.round(lagMsgs(p, t));
      } },
      { entity: (t) => 'fulfillment/pod-' + podOf(HOT, t), level: 'WARN', rate: (t) => (lagSec(HOT, t) > 60 ? 1 / 45 : 0), msg: (t) => 'partition=' + HOT + ' consumer falling behind: lag=' + Math.round(lagMsgs(HOT, t)) + ' (~' + Math.round(lagSec(HOT, t) / 60) + ' min), worker busy 100%' },
      { entity: (t, h) => 'fulfillment/pod-' + h.int(1, 6), level: 'INFO', t: T_SCALE + 2, msg: 'consumer group fulfillment: rebalance started (generation 41 → 42), revoking all partitions' },
      { entity: 'fulfillment/pod-8', level: 'INFO', t: T_SCALE + PAUSE, msg: 'assigned partitions: [order-events-7]' },
      { entity: 'fulfillment/pod-4', level: 'INFO', t: T_SCALE + PAUSE, msg: 'assigned partitions: [order-events-3]' },
      { entity: 'fulfillment/pod-1', level: 'INFO', t: T_SCALE + PAUSE + 1, msg: 'consumer group fulfillment: rebalance complete, 12 members, 12 partitions' },
      { entity: (t, h) => 'kafka/broker-' + h.int(1, 3), level: 'INFO', rate: (t) => (t > T_RET ? 1 / 40 : 1 / 200), msg: (t, h) => 'Rolled new log segment for clickstream-' + h.int(0, 23) + ' (retention.ms=' + (t > T_RET ? '604800000' : '259200000') + ')' },
      { entity: 'notify', level: 'WARN', rate: (t) => (delayQ(t, 0.99) > 120 ? 0.05 : 0), msg: (t, h) => 'confirmation for order o-' + h.hex(8) + ' sent ' + Math.round(delayQ(t, 0.99) / 60) + ' min after placement' },
      { entity: (t, h) => 'notify', level: 'INFO', rate: 0.3, msg: (t, h) => 'push sent order=o-' + h.hex(8) + ' provider=fcm status=200' },
    ],
    traces: [
      { name: 'order → confirmation', rate: 0.32, fn: (t, h) => {
        const p = pickPartition(t, h), m = merchantFor(p, t, h);
        const wait = lagSec(p, t) * 1000 + h.lognormal(25, 0.5);
        const pay = vendor(t) ? h.lognormal(2200, 0.4) : h.lognormal(160, 0.3);
        return h.span('client', 'checkout → confirmed', 2, [
          h.span('order-service', 'POST /orders', 4, [
            h.span('payments', 'authorize', pay),
            h.span('kafka', 'produce order-events', h.lognormal(4, 0.3), [], { tags: { partition: p, key: t < T_DEPLOY ? 'order_id' : m } }),
          ], { tags: { merchant: m } }),
          h.span('kafka', 'queue wait (order-events)', wait, [], { tags: { partition: p, lag_msgs: Math.round(lagMsgs(p, t)) } }),
          h.span('fulfillment', 'process order.created', 0.6, [
            h.span('orders-db', 'INSERT picker_assignment', h.lognormal(1.6, 0.3)),
            h.span('notify', 'send confirmation push', h.lognormal(30, 0.4)),
          ], { tags: { pod: 'pod-' + podOf(p, t), partition: p } }),
        ], { error: wait > 300000, tags: { merchant: m } });
      } },
    ],
  };
})());
