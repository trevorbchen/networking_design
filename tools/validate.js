#!/usr/bin/env node
/* Validate scenarios headlessly: node tools/validate.js [scenario-file-or-id ...]
 * Compiles each scenario with the same engine the browser uses, reports errors,
 * and prints a summary (metrics, logs, traces, events) so authors can sanity-check. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..');
global.window = undefined;
const OBS = require(path.join(root, 'assets/js/engine.js'));
globalThis.OBS = OBS;
vm.runInThisContext(fs.readFileSync(path.join(root, 'scenarios/manifest.js'), 'utf8'));
const files = OBS.manifest;
const want = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const before = new Set(Object.keys(OBS.scenarios));
  try { vm.runInThisContext(fs.readFileSync(path.join(root, 'scenarios', f), 'utf8'), { filename: f }); }
  catch (e) { console.log('✗ ' + f + ': failed to load: ' + e.message); bad++; continue; }
  const added = Object.keys(OBS.scenarios).filter((k) => !before.has(k));
  if (!added.length) { console.log('✗ ' + f + ': did not call OBS.register'); bad++; continue; }
  for (const id of added) {
    if (want.length && !want.some((w) => f.includes(w) || id.includes(w))) continue;
    const s = OBS.scenarios[id];
    const t = Date.now();
    let c;
    try { c = OBS.compile(s); } catch (e) { console.log('✗ ' + id + ': compile threw: ' + e.stack); bad++; continue; }
    const ms = Date.now() - t;
    const answer = path.join(root, 'answers/scenarios', id + '.md');
    const problems = c.errors.slice();
    if (!fs.existsSync(answer)) problems.push('missing answer key answers/scenarios/' + id + '.md');
    if (!s.brief || !s.brief.summary) problems.push('missing brief.summary');
    if (!s.hints || !s.hints.length) problems.push('no hints');
    const errs = c.logs.filter((l) => l.level === 'ERROR' || l.level === 'FATAL').length;
    console.log((problems.length ? '⚠ ' : '✓ ') + id + '  [' + (s.difficulty || '?') + '] ' + s.title);
    console.log('    ' + Object.keys(c.series).length + ' metrics × ' + c.n + ' pts · ' + c.logs.length + ' logs (' + errs + ' error) · ' + c.traces.length + ' traces · ' + c.events.length + ' events · compiled in ' + ms + 'ms');
    for (const p of problems.slice(0, 15)) console.log('      - ' + p);
    if (problems.length) bad++;
    if (process.env.VERBOSE) {
      for (const k of Object.keys(c.series)) { const v = c.series[k]; const q = (f) => v[Math.floor(f * (v.length - 1))]; console.log('      ' + k.padEnd(42) + ' ' + [0, .25, .5, .75, 1].map((f) => q(f).toFixed(1)).join('  ')); }
    }
  }
}
console.log(bad ? '\n' + bad + ' scenario(s) with problems' : '\nall scenarios OK');
process.exit(bad ? 1 : 0);
