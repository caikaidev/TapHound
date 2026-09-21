# Failure Classification (V0.8)

Raw evidence must not be sent directly to a Coding Agent. Before diagnosis,
every failed run is classified into a **concise structured failure contract**
(architecture doc §20, P1.5):

```text
Raw Evidence
    ↓
Failure Classification  (deterministic, offline)
    ↓
Structured Failure Report
    ↓
Coding Agent / Diagnosis Agent
```

## The failure contract (`FailureClassification`)

```json
{
  "version": 1,
  "runId": "2026-09-13T07-10-29.702Z-...",
  "classificationId": "run-1:LOCATOR_NOT_FOUND:2",
  "type": "target_not_found",
  "stage": "interaction",
  "code": "LOCATOR_NOT_FOUND",
  "message": "search target missing",
  "stepIndex": 2,
  "expected": "search",
  "actual": "not found in layout",
  "locator": { "resourceId": "search" },
  "evidenceRefs": ["screenshot-default.png", "logcat-default.txt", "steps/002.log"],
  "sourceReportPath": "/runs/run-1/report.json"
}
```

An agent consumes this, never 10,000 lines of logcat.

## Taxonomy (`FailureType`)

`target_not_found` / `target_ambiguous` / `target_unresolved` /
`activity_mismatch` / `app_crash` / `launch` / `environment_missing` /
`capability_missing` / `timeout` / `interaction` / `action_failed` /
`expect_failed` / `checkpoint_failed` / `contract_invalid` / `evidence_failed` /
`alignment_failed` / `collection_failed` / `internal_error`

Classification is a **pure map** from failure code + report facts
(`FAILURE_CODE_TYPES` in `src/domain/failure-classification.ts`). No model
call, no log dump. If a new failure code is added, the map must cover it —
the taxonomy test fails otherwise.
`BASELINE_INCOMPARABLE` and `BASELINE_EMPTY` are classified as
`contract_invalid` (setup); compare reports them at exit 2 rather than
claiming behavior changed.

## Likely stage (`FailureStage`)

`setup` / `launch` / `navigation` / `interaction` / `assertion` / `evidence`
/ `finalize` / `unknown` — derived deterministically from the type, so a
repair agent knows *where* to look first without reading the report.

## Deterministic details

- **expected / actual**: extracted from the report per family — activity
  mismatch uses the failed before/after check; `expect_failed` uses the failed
  expectation; target failures use the failed step's locator; `app_crash`
  states process expectations; contract/evidence failures state the binding
  mismatch.
- **stepIndex**: the failing step (from the primary failure).
- **locator**: a canonical `Locator` for target families (report locators are
  normalized back to a findable form).
- **evidenceRefs**: screenshot, logcat, step-log paths from the run artifacts.

## Structured request outcome

Failed reports also carry optional
`requestOutcome: { errorClass, evidenceRefs }`, where `errorClass` is
`client`, `auth`, `network`, `server`, or `unknown`. TapHound accepts a class
only from a uniquely matched, digest-bound `logcatEvent` whose app-emitted
JSON `fields.errorClass` is one of the four stable values. The source
expectation may be on an earlier step before the primary failure. Missing,
unmatched, invalid, or conflicting classes yield `unknown`; TapHound never
guesses from a status message or log text. The refs identify the report and
the source step Logcat artifact, but no request ID, token, event fields, or raw
payload is copied into this outcome. Raw Logcat evidence may still contain
sensitive content and must be handled separately.

## CLI

```bash
taphound failure classify \
  --project /path/to/android-project \
  --report .taphound/build/runs/<runId>/report.json \
  --json
```

`failure classify` is offline and deterministic (exit 0). Diagnostics go to
stderr; exactly one JSON value on stdout.

## Where classification is consumed

- Diagnosis Agent (V0.8): the agent reads the classification, inspects
  evidence by `evidenceRefs`, and proposes a fix or re-run.
- `contract review` findings may reference a classification id.
- The Escalation Policy's `needsReview` path produces reviewer findings
  attached to the same report stack.