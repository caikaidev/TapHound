# Checkpoint, Baseline, and Regression Comparator

Three deterministic primitives implement the architecture doc's P1.1–P1.4:
**Checkpoints** (named behavioral contracts), **Baselines** (frozen
known-good behavior evidence), and the **Regression Comparator** (current
behavior vs baseline). They answer:

> Did a change keep observable behavior intact?

without any model call — the comparison is pure and deterministic. Ambiguity
left over after a deterministic compare is the job of the Playbook Escalation
Policy (`docs/playbook.md`).

## Checkpoint (`src/domain/checkpoint.ts`)

A Checkpoint is a named expectation at a point in a Journey:

```json
{
  "version": 1,
  "id": "results-visible",
  "name": "Search results visible",
  "stepIndex": 3,
  "expect": {
    "activity": "com.example.app.SearchActivity",
    "screen": "search",
    "visibleElements": [{ "resourceId": "results" }],
    "absentElements": []
  },
  "status": "inferred"
}
```

A Checkpoint is **not a screenshot** (architecture doc §11): `expect` carries
deterministic, machine-checkable conditions — Activity, Knowledge Screen,
visible/absent elements — and at least one condition is required.

## Baseline (`BaselineSchema`)

A Baseline freezes behavior evidence from one known-good (passed) run:

```json
{
  "version": 1,
  "id": "search-baseline",
  "journeySha256": "…",
  "contractSha256": "…",
  "capturedAt": "2026-07-19T10:00:00.000Z",
  "packageName": "com.example.app",
  "runId": "run-1",
  "activities": [{ "stepIndex": 0, "before": "…MainActivity", "after": "…SearchActivity" }],
  "elements": [{ "locator": { "resourceId": "search" }, "kind": "present", "matchedBy": "resourceId" }],
  "screens": [{ "screen": "search", "status": "matched" }],
  "sourceReportPath": "/runs/run-1/report.json"
}
```

Facts are behavior, not pixels (architecture doc §15): per-step before/after
Activities, element presence/absence, optional Knowledge Screen detection.
`BaselineCapturer` derives them offline from a published V4 report and hook
outcomes — no device access, no state mutation. Capture refuses a non-passed
run (fail closed).

## Regression Comparator (`compareRegression`)

Pure compare (`src/application/checkpoint/regression-comparator.ts`):

```text
Current Evidence  VS  Baseline Evidence
```

Each baseline activity fact and element fact must reproduce:
activity drift yields one `RegressionDiff` per mismatch with `expected`
(baseline) and `actual` (current); element presence flips `present` →
`absent` produce diffs too. `equivalent: true` only when **every** fact
reproduces.

This is the **Regression Comparator** (architecture doc §16.1). It is
separate from requirement compliance: a run can be *equivalent to baseline*
and still fail its Contract (a bug present in both), or pass its Contract and
diverge from baseline (intentional UX change). The two pipelines must stay
independent.

Screen facts require comparable instrumentation: capture the Baseline and the
compared report from runs that both produce Knowledge Screen matches (the
`verify --contract` path). A plain `verify` report carries no Screen matches,
so comparing it against a Baseline that has screen facts reports those facts
as `missing` — that is missing evidence, not necessarily a real regression.

## CLI

```bash
# Capture a baseline from an existing passing report (offline)
taphound baseline capture \
  --project /path/to/android-project \
  --report .taphound/build/runs/<runId>/report.json \
  --out .taphound/baselines/search.json \
  --json

# Compare a new report against the baseline
taphound baseline compare \
  --project /path/to/android-project \
  --baseline .taphound/baselines/search.json \
  --report .taphound/build/runs/<runId>/report.json \
  --json
```

`baseline capture` exits 0 and writes the Baseline; `baseline compare` exits
0 when equivalent and 1 when one or more regressions are found (JSON on
stdout in both cases, diagnostics on stderr).

## Workflow

```text
known-good run  →  baseline capture  →  Baseline  ─┐
                                                   ↓
change applied  →  new run  →  report  →  baseline compare  →  REGRESSION?
                                                   │
                                      no → equivalent (behavior preserved)
                                                   │
                                      yes → diffs feed the Playbook's
                                            behavior-regression phases
```

Baselines live under `.taphound/baselines/` and are committed; they are
derived artifacts (never a second Source of Truth — the report hash and
Journey hash bind them to the evidence they came from).