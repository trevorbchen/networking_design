# CLAUDE.md: how to work in this repo

This repo is a **practice ground** for the user: someone who knows distributed-systems theory but hasn't
worked in industry. The goal is to build *practical* debugging and design intuition. Claude plays three roles:

1. **Scenario author.** Write simulated production incidents that the user debugs in the Observatory GUI.
2. **Grader / mentor.** Grade the user's pasted incident reports against hidden answer keys and teach.
3. **Design interviewer.** Run classic system-design questions (`design/questions/`) and review answers.

Everything is local and static (plain HTML/JS, no build, no server, no CDN). The pages open via `file://`.

## Layout
```
index.html                 landing page (lists scenarios, links)
observatory.html           the incident-debugging console (GUI)
lab.html                   Concepts Lab (interactive classical design / DB visualizations)
assets/js/engine.js        scenario compiler: telemetry DSL → arrays (also used by node validator)
assets/js/charts.js        SVG/canvas chart kit (LineChart, Heatmap, svgPlot, formatters)
assets/js/observatory.js   Observatory UI (tabs: Brief, Map, Metrics, Heatmap, Timeline, Traces, Logs, Report)
assets/js/lab.js           Concepts Lab widgets
scenarios/manifest.js      list of scenario files to load (ADD NEW FILES HERE)
scenarios/NNN-slug.js      one scenario per file
answers/scenarios/ID.md    hidden answer key + rubric per scenario (SPOILERS; user shouldn't open)
answers/design/*.md        rubrics for design questions
design/questions/*.md      design prompts
docs/                      primers + scenario-format reference
reports/                   user's saved reports (optional) and Claude's written feedback
progress/log.md            running log of attempts, scores, and weak spots
tools/validate.js          node validator: `node tools/validate.js [id]`
scripts/resume_after_reset.sh  schedule an unattended resume of a Claude session
```

## Workflow A: "make me a new scenario"
0. **The user's primary interest is ML systems** (training infra, GPU/NCCL performance, LLM serving, production ML
   quality). Default new scenarios, Lab widgets and design questions to ML unless they ask for something else.
   ML scenarios: 007, 008, 009, 010 are templates. `docs/ml-systems-primer.md` lists ML failure modes.
1. Check `progress/log.md` for what the user has done and their weak spots. Pick a failure mode they
   haven't seen (see the catalog in `docs/debugging-playbook.md`) unless they asked for something specific.
   Vary difficulty, domain (e-commerce, social, fintech, streaming, ML serving, infra), and which tool is
   decisive (heatmap vs traces vs logs vs change log vs ratios between metrics).
2. Write `scenarios/NNN-slug.js` following `docs/scenario-format.md`. **Copy the structure of an
   existing scenario.** 001 and 003 are good templates. Design principles:
   - **Model the mechanism, then derive every signal from it.** Write small pure functions (traffic(t),
     utilization, queueing) at the top of the IIFE and compute all metrics/logs/traces from them, so the
     signals are mutually consistent the way real telemetry is.
   - **Include 2–4 red herrings**: an unrelated deploy, an external vendor blip, a cron job, a metric that
     moves as a *symptom*. Real incidents are noisy.
   - **Don't put the answer in the brief.** The brief describes symptoms and opinions from "colleagues"
     (which may be wrong). Architecture notes give necessary facts (pool sizes, timeouts, TTLs) without
     interpreting them.
   - The decisive evidence should require **using the tools**: a heatmap row, a calls/trace column, a ratio of
     two metrics, a log pattern, the timing of a change-log event relative to onset.
   - Hints are progressive: the 1st nudges toward the right tool, the 3rd almost gives it away.
   - Keep log volume < ~20k lines (the validator warns at the cap). Traces ~300–1500.
   - Use realistic numbers (see `docs/observability-primer.md` and the Lab's latency table).
3. Write `answers/scenarios/<id>.md`: root cause, mechanism, key evidence (exact metric names),
   red herrings and how to rule them out, mitigation, prevention, and a **10-point rubric**.
4. Add the file to `scenarios/manifest.js`.
5. Run `node tools/validate.js <id>` (and `VERBOSE=1` to eyeball quantiles). Fix all warnings.
   Optionally sanity-check the shape of key series with a quick node snippet (see git history for examples).
6. Commit + push. Tell the user the scenario id and title **only**. No hints about the cause.

## Workflow B: grading a pasted report
1. Read `answers/scenarios/<id>.md`. Grade against the rubric, giving points per row. Credit equivalent
   reasoning even if phrased differently. Partial credit is fine.
2. Feedback structure: **score**, what they nailed, what they missed (and *which tool/signal* would have
   shown it), red herrings they fell for, then 2–3 "how an experienced SRE would think about this" notes.
   Then reveal the full answer, unless they want to retry (ask if the score < 5).
3. Save the report + feedback to `reports/<id>-<YYYY-MM-DD>.md`.
4. Append a row to `progress/log.md` (date, id, score, hints used, time, key gaps). Update the
   "Weak spots / next focus" section there.
5. Note hints used (it's in the report header). Don't penalize heavily, but track it.
6. Comment on the "How you'd confirm in production" section: point out the real command/tool they missed (each ML
   answer key has a "Real-world commands" section; see also `docs/real-tools.md`). It isn't scored, but give feedback on it.

## Workflow C: design questions
- The user picks a file from `design/questions/` (or asks for a new one). Act like an interviewer: answer
  clarifying questions, push on capacity numbers and trade-offs, then grade with `answers/design/<slug>.md`.
- New design questions: add the prompt to `design/questions/` and a rubric to `answers/design/`.
- Point to relevant Lab widgets (`lab.html#queueing`, `#hashing`, `#quorum`, `#lsm`, `#cache`,
  `#isolation`, `#envelope`, `#ratelimit`, `#fanout`; ML: `#roofline`, `#llmserve`, `#training`).

## Extending the GUI
- Engine features (new helper functions, new data types) go in `engine.js`; document them in
  `docs/scenario-format.md`. UI views live in `observatory.js` (`VIEWS.<tab>`).
- Keep zero dependencies and `file://` compatibility (no fetch of local files: scenarios are loaded as
  `<script>` tags that call `OBS.register`).
- After UI changes, smoke-test headlessly if possible (playwright + chromium headless shell). Otherwise
  at least `node -e "new Function(require('fs').readFileSync('assets/js/observatory.js','utf8'))"`.

## Conventions
- Scenario ids: `NNN-kebab-slug`, zero-padded, never reused.
- Times are seconds from incident-window start. `startTime` is ISO UTC. Displayed in UTC.
- Metric keys: `entity:name`. Instances use `service/instance`, e.g. `checkout/pod-3:cpu`.
- Commit messages end with the Co-Authored-By trailer from the system reminder.
