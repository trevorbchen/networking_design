# Scenario format reference

A scenario is a JS file in `scenarios/` that calls `OBS.register({...})`. It describes **telemetry**
(what your monitoring would show), not a running system. `assets/js/engine.js` compiles it into arrays.
Add the file name to `scenarios/manifest.js`, then run `node tools/validate.js <id>`.

Wrap it in an IIFE so you can define model functions first:

```js
OBS.register((function () {
  const traffic = (t) => 800 + 200 * Math.min(1, t / 1800);        // model first…
  const util = (t) => traffic(t) / 1000;
  return {                                                          // …then derive every signal from it
    id: '005-my-scenario', title: 'Short symptom-style title', difficulty: 'medium',
    tags: ['replication', 'stale reads'],
    startTime: '2026-11-17T14:00:00Z', duration: 3600, step: 10, seed: 5,
    brief: { ... }, architecture: '<ul>…</ul>', hints: ['…', '…', '…'],
    topology: { nodes: [...], edges: [...] },
    metrics: [...], dashboards: [...], events: [...], logs: [...], traces: [...],
  };
})());
```

## Top-level fields
| field | meaning |
|---|---|
| `id` | `NNN-slug`. Must match `answers/scenarios/<id>.md`. |
| `title`, `difficulty` (`easy`/`medium`/`hard`), `tags` | Shown in pickers. The title describes the **symptom**, not the cause. |
| `startTime` | ISO UTC timestamp of t=0. |
| `duration`, `step` | Window length and metric resolution in seconds (default 3600 / 10). Keep `duration/step` ≤ ~800. |
| `seed` | RNG seed. The same seed always gives the same data. |
| `maxLogs`, `maxTraces` | Caps (default 25000 / 4000). The validator warns when the log cap truncates. |

## `brief`
`{ severity, alert, firedAt, summary (HTML), task (HTML), questions: [string] }`. Shown on the Brief tab.
Describe symptoms and colleagues' opinions, which can be wrong. Never state the cause.

`architecture` (HTML): facts a new on-call engineer would find on the wiki (pool sizes, timeouts, TTLs, retry
policies, placement). These are needed to reason, but not interpreted.

`hints`: progressive, revealed one at a time. The count used is recorded in the report.

## Helper object `h`
Every authoring function receives `(t, h, i)`. `t` is seconds since start, `i` is the instance number (when using `instances`).

| helper | returns |
|---|---|
| `h.noise(a)` | uniform in [-a, a] |
| `h.gauss(sd)`, `h.lognormal(median, sigma)` | random samples (lognormal is good for latencies) |
| `h.jitter(v, frac)` | v × (1 ± frac) |
| `h.ramp(t, t0, t1, a=0, b=1)` | linear a→b between t0 and t1 |
| `h.step(t, t0, v)`, `h.window(t, t0, t1, v)` | v after t0 / inside window |
| `h.pulse(t, center, width, height)` | gaussian bump |
| `h.decay(t, t0, height, tau)` | exponential decay after t0 |
| `h.saw(t, period, phase)`, `h.sine(t, period, phase)` | periodic shapes |
| `h.clamp, h.chance(p), h.pick(arr), h.int(lo,hi), h.hex(n)` | misc |
| `h.get(key, t)`, `h.lag(key, t, dt)` | value of an already-defined metric (define it ABOVE) |
| `h.span(service, op, selfMs, children, opts)` | trace span (see below) |

## `metrics`
```js
{ entity: 'checkout/pod-{i}', instances: 6, name: 'cpu', unit: '%', desc: 'tooltip text',
  fn: (t, h, i) => 30 + h.noise(3), smooth: 3, min: 0, max: 100 }
```
- Key = `entity:name`, e.g. `checkout/pod-3:cpu`. The service is the part before `/`, and it groups the metric tree
  and the heatmap.
- `instances`: a number (1..n) or an array of names. `{i}` in `entity` is replaced.
- Values are clamped at `min` (default 0). Use `min: -Infinity` for signed metrics.
- Units with special formatting: `%`, `ms`, `s`, `B`, `B/s`, `ratio`, `''`. Anything else prints as `<num> <unit>`.

## `topology`
```js
nodes: [{ id, label, kind, x, y, health: 'metric:key', thresholds: [warn, crit], invert, desc }]
edges: [{ from, to, metric, label, thresholds, invert, async }]
```
`kind`: `client lb service db cache queue external storage worker`. `x`/`y` are 0–100 layout coordinates.
The node color comes from the health metric at the scrubbed time (`invert: true` means lower is worse). `id` should equal the
service prefix of its metrics, so clicking a node shows them.

## `dashboards`
`[{ title, charts: [{ title, series: ['svc:metric', 'svc/*:metric'], threshold }] }]`. `*` expands across instances.
The first dashboard is preloaded on the Metrics tab. Make it the "obvious" on-call dashboard, which should
*not* contain the decisive metric.

## `events`
`{ t, kind, entity, msg }`. `kind`: `deploy config scale cron traffic failover alert info`. They appear as
markers on every chart. Deploy/config/scale/cron/traffic/failover also appear in the Brief's change log.

## `logs`
- Single line: `{ t, entity, level, msg }`
- Generator: `{ entity, level, rate | every, from, to, msg }`
  - `rate`: lines per second, either a number or `(t, h) => number` (Poisson sampled per second).
  - `entity`: a string, an array (random pick), or `(t, h) => string`.
  - `msg`: a string or `(t, h, entity) => string`. `level` can also be a function.
  - Levels: `DEBUG INFO WARN ERROR FATAL`.
- Include background noise (INFO chatter, a recurring irrelevant WARN) so search is necessary.

## `traces`
```js
{ name: 'POST /checkout', rate: (t) => 0.2, /* or count: 500 */ fn: (t, h) =>
  h.span('gateway', 'POST /checkout', 1, [
    h.span('checkout', 'handler', 3, [
      h.span('orders-db', 'SELECT', h.lognormal(4, 0.3)),
      h.span('inventory', 'reserve', 30, [], { tags: { pod: 'pod-2' } }),
    ]),
  ], { error: false, tags: { status: 200 } }) }
```
- `selfMs` is time spent in the span itself. 60% of it goes before the children and 40% after.
- Children run sequentially unless `{ parallel: true }`. `opts.gap` is the network hop before the span (default 0.3 ms).
- `opts.error`, `opts.tags`, `opts.note`. Return `null` to skip a sample.
- The Traces → Breakdown table aggregates self time and calls/trace per `service · op`. Make the op names
  meaningful, because that table is often the decisive tool.

## Answer key: `answers/scenarios/<id>.md`
Sections: Root cause · (mechanism math) · Key evidence (exact metric names) · Red herrings · Mitigation ·
Prevention · **Grading rubric (10 pts)**. See existing keys for the tone.
