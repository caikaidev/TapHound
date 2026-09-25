# Checkpoint, Baseline, and Regression Comparator

Three deterministic primitives implement the architecture doc's P1.1–P1.4:
**Checkpoints** (named behavioral contracts), **Baselines** (frozen
known-good behavior evidence), and the **Regression Comparator** (current
behavior vs baseline). They answer:

> Did a change keep observable behavior intact?

without any model call — the comparison is pure and deterministic. Ambiguity
left over after a deterministic compare belongs to the external Workflow's
review step (`docs/source-of-truth.md`).

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

Put Checkpoints in the Journey's top-level `checkpoints` array. They are
included in the Journey hash; no separate Checkpoint file is read at Replay.
`stepIndex` is zero-based and means **after that step succeeds**. If omitted,
the Checkpoint runs after all Journey steps succeed, on the device used by the
last step. Checkpoints with the same evaluation point run in array order.
Their IDs must be unique, and explicit indexes must reference an existing
step. Without Checkpoints, Replay and its report are unchanged.

Each Checkpoint captures a fresh UI hierarchy and checks that the target app
is foreground. An element condition tests unique presence or absence in the
accessibility layout, not geometry or pixel visibility. Ambiguous matches,
missing UI evidence, foreground uncertainty, and an unavailable or unknown
Knowledge Screen are `unresolved`, never a successful absence. A deterministic
mismatch is `failed`. Either stops Replay at that Checkpoint, while final
artifact collection still runs. The report records each evaluated condition
under `checkpoints`; a detected Knowledge Screen also appears in
`report.screens` for ordinary `verify --journey` runs. A Checkpoint not reached
because an earlier step or Checkpoint failed is not reported as evaluated.
Contracts can require Checkpoints by ID; a missing or unresolved required
result cannot satisfy the Contract (see `docs/contract-schema.md`).

### Shared `allOf` window

Use `allOf` instead of legacy `activity`/`screen`/`visibleElements`/
`absentElements` to require UI and structured Logcat evidence on one shared
deadline:

```json
{
  "version": 1,
  "id": "search-ready",
  "name": "Search ready",
  "stepIndex": 2,
  "expect": {
    "timeoutMs": 3000,
    "allOf": [
      { "kind": "absentElement", "locator": { "resourceId": "spinner" } },
      { "kind": "logcatEvent", "expect": {
        "type": "logcatEvent", "tag": "SearchViewModel",
        "event": "resultsReady", "fields": { "query": "hello" },
        "window": { "from": "marker", "markerId": "search-start" }
      } }
    ]
  }
}
```

Declare `search-start` explicitly as `markerId` on an earlier `wait` step.
The event window starts at that marker, even across intervening steps.
`stepStart` and `runStart` are also available. Logcat conditions inherit the
Checkpoint's `timeoutMs` rather than having separate budgets. Legacy
conditions and `allOf` cannot be mixed. Condition identities must be unique;
only one Activity and one Screen may appear in one `allOf`.

UI observations capture fresh hierarchies and validate the target foreground
package. UI conditions may pass before the deadline, but Logcat event
conditions are observed until the shared deadline so a second matching event
cannot be mistaken for success. The report records each condition's own
pass/fail/unresolved status, start and match time, and UI/Logcat evidence
reference. Missing events and UI mismatches fail at the shared deadline;
unavailable windows, ambiguous UI, or lost Logcat evidence are unresolved.
Overflow blocks required Checkpoint event evidence when it occurred within
or after that event's window start. When `lastDroppedAtMs` proves drops
preceded the window, it does not invalidate the event; absent drop timing
remains incomparable.

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
  "elements": [{ "stepIndex": 0, "locator": { "resourceId": "search" }, "kind": "present", "matchedBy": "resourceId", "fallbackUsed": false }],
  "screens": [{ "screen": "search", "status": "matched" }],
  "checkpoints": [
    { "checkpointId": "loading-gone", "stepIndex": 0,
      "kind": "absentElement", "locator": { "resourceId": "loading" } }
  ],
  "requiredEvidence": { "screens": true },
  "sourceReportPath": "/runs/run-1/report.json"
}
```

Facts are behavior, not pixels (architecture doc §15): per-step before/after
Activities, step element presence, optional Knowledge Screen detection, and
passed Checkpoint conditions (Activity, Screen, presence, and verified absence).
`BaselineCapturer` derives them offline from a published V4 report and hook
outcomes — no device access, no state mutation. Capture refuses a non-passed
run, an empty fact set, or a successful step locator without a stable
`requested` Locator or `anchorId`. It never infers `absent` from a failed
locator in a passed report. The capture command's optional Journey hash must
match the report; it cannot replace the report's binding.
Checkpoint facts carry their Checkpoint ID and post-step index (or omit the
index for end-of-Journey), so an absent element cannot be confused with a
step's presence fact or another Checkpoint. Capture rejects failed, unresolved,
or duplicate Checkpoint results; historical Baselines without `checkpoints`
remain readable.
Passed `logcatEvent` facts freeze the structured event/window identity, not
the raw message or captured values. Capture requires one match, its line
digest and a Logcat artifact reference. Compare reproduces the same identity
and uniquely evidenced occurrence; missing or incomplete evidence is
`BASELINE_INCOMPARABLE`, while a failed condition is a `logcatEvent` drift.

If a Baseline binds a Contract, capture requires the **passing** Verdict for
the same report (`--verdict <path>` or `verdict.json` beside the report). The
Verdict must identify that report, its Journey and package, and the requested
Contract hash. A bare `--contract-sha256` is not proof that the Contract ran.
`--verdict` alone also binds the Contract hash from the passing Verdict.

## Regression Comparator (`compareRegression`)

Pure compare (`src/application/checkpoint/regression-comparator.ts`):

```text
Current Evidence  VS  Baseline Evidence
```

Before comparing facts, the service parses a V4 report and requires a passed
run (or a failed run whose primary failure is a Checkpoint failure, all steps
passed, and the Baseline contains Checkpoint facts), the same report Journey
hash and package, nonempty Baseline coverage,
and, for a Contract-bound Baseline, a matching passing Verdict for the
**current** report. For a Checkpoint failure, the current Contract Verdict
must be `fail/CHECKPOINT_FAILED` and bound to that report. An identity or
capability mismatch returns
`BASELINE_INCOMPARABLE` at exit 2 without an `equivalent` value. An empty
historical Baseline returns `BASELINE_EMPTY` at exit 2.

Each baseline activity fact and element fact must reproduce:
activity drift yields one `RegressionDiff` per mismatch with `expected`
(baseline) and `actual` (current). Element facts are keyed by step index and
the complete requested Locator or Anchor ID. `matchedBy` and annotated
`fallbackUsed` are compared separately; a change in either yields a diff.
Screen facts compare both ID and status. Checkpoint conditions compare at
their own ID and evaluation point; a failed condition, including an absence
that no longer holds, yields a diff with `checkpointId`. Missing, duplicate,
or unresolved current Checkpoint evidence, or changed condition identity,
is incomparable rather than equivalent. The result reports
`coverage: { activities, elements, screens, checkpoints? }`; `equivalent: true` requires
nonzero coverage and reproduction of **every** frozen fact.

Older element facts without `stepIndex` remain readable, but cannot safely
establish equivalence and must be recaptured. Old `evidenceSha256` fields,
which hashed a human-readable locator message, remain readable for
compatibility but are not produced or compared.

This is the **Regression Comparator** (architecture doc §16.1). It is
separate from requirement compliance: a run can be *equivalent to baseline*
and still fail its Contract (a bug present in both), or pass its Contract and
diverge from baseline (intentional UX change). The two pipelines must stay
independent.

Screen facts require comparable instrumentation: capture the Baseline and the
compared report from runs that both produce Knowledge Screen matches (Contract
hooks or an evaluated Screen Checkpoint). A plain `verify` report without a
Screen Checkpoint carries no Screen matches. When a Baseline requires Screen evidence but the current report has
none, compare returns `BASELINE_INCOMPARABLE`, not a Screen regression.
Use `baseline capture --no-screen-facts` if future comparisons use plain
`verify --journey`; legacy Baselines infer this requirement from their
`screens` array.

Passed step locators only establish presence at their own step. Verified
absence comes only from passed `absentElement` Checkpoint conditions. A Baseline does
not assert complete App equivalence or bind the current Knowledge version;
do not use Screen facts across changed Knowledge without separate review.
Only resolved Screen matches can be captured; historical ambiguous or
unresolved Screen facts cannot establish equivalence.

## CLI

```bash
# Capture a baseline from an existing passing report (offline)
taphound baseline capture \
  --project /path/to/android-project \
  --report .taphound/build/runs/<runId>/report.json \
  --verdict .taphound/build/runs/<runId>/verdict.json \
  --out .taphound/baselines/search.json \
  --json

# Compare a new report against the baseline
taphound baseline compare \
  --project /path/to/android-project \
  --baseline .taphound/baselines/search.json \
  --report .taphound/build/runs/<runId>/report.json \
  --verdict .taphound/build/runs/<runId>/verdict.json \
  --json
```

For plain Journey runs, omit `--verdict` and `--contract-sha256` from capture,
and omit `--verdict` from compare. Contract-bound comparisons look for a
Verdict next to the current report by default.

`baseline capture` exits 0 and writes the Baseline; `baseline compare` exits
0 when equivalent, 1 for real regressions, and 2 for incomparable evidence
(JSON on stdout in each case, diagnostics on stderr).

## Workflow

```text
known-good run  →  baseline capture  →  Baseline  ─┐
                                                   ↓
change applied  →  new run  →  report  →  baseline compare  →  REGRESSION?
                                                   │
                                      no → equivalent (behavior preserved)
                                                   │
                                      yes → diffs feed the Workflow's
                                            regression review
```

Baselines live under `.taphound/baselines/` and are committed; they are
derived artifacts (never a second Source of Truth — the report hash and
Journey hash bind them to the evidence they came from).