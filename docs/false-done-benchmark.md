# False-Done Benchmark

The False-Done Benchmark measures the value of TapHound as a **verification**
tool: when a coding agent claims "done", can TapHound catch the completed
work that is actually wrong? It complements the engine Benchmark
(`docs/benchmark.md`), which measures Journey/Knowledge engine performance.

```text
Agent claims done
    ↓
[Case] variant APK (the claimed implementation) + Acceptance Contract
    ↓
TapHound verify --contract on the device
    ↓
Verdict  ← compare with expectedVerdict (ground truth)
    ↓
Detection: confirmed / missed / falseReject / detected
    ↓
False-Done Recall, False-Reject Rate, Verdict Agreement
```

## Case Pack

Committed authority:

```text
.taphound/
  false-done/*.json        # False-Done Cases
  contracts/*.json         # one Acceptance Contract per Case
  variants/*.apk           # host app variant per Case (defect injected)
```

Ephemeral evidence:

```text
.taphound/build/false-done-runs/<runId>.json
```

Case schema (`false-done/<id>.json`, file name must equal the case id):

```json
{
  "version": 1,
  "id": "behavior-01",
  "category": "behavior",
  "description": "Search results stay empty after submit",
  "variant": {
    "label": "behavior-search-empty",
    "apkPath": ".taphound/variants/behavior-01.apk"
  },
  "contractPath": ".taphound/contracts/fd-behavior-01.json",
  "expectedVerdict": "fail",
  "tags": ["search"]
}
```

| Field | Meaning |
|---|---|
| `category` | `correct` (agent right), `behavior` (behavior wrong), `visual` (UI diverges), `boundary` (edge state wrong) |
| `variant.apkPath` | project-relative APK with the claimed change installed |
| `contractPath` | Acceptance Contract the agent claims to satisfy |
| `expectedVerdict` | ground truth: `pass` for truly-done cases; `fail` / `inconclusive` for false-done cases |

`benchmark false-done validate` checks the file name / variant APK readability
and that the bound Contract loads (schema + Journey hash binding).

## Detection Scoring

| expected | actual Verdict | detection |
|---|---|---|
| `pass` | `pass` | `confirmed` |
| `pass` | `fail`/`inconclusive` | `falseReject` (verification rejected correct work) |
| `fail`/`inconclusive` | `fail`/`inconclusive` | `detected` (false done caught) |
| `fail`/`inconclusive` | `needsReview` | `detected` (harness escalated for human review) |
| `fail`/`inconclusive` | `pass` | `missed` (false done escaped) |
| — | install/verify crash | `error` |

## Metrics

- `falseDoneRecall` — detected / false-done cases (the headline number)
- `falseRejectRate` — falseRejects / truly-done cases
- `verdictAgreementRate` — (confirmed + detected) / eligible cases
- `missedCount`, `errorCount`
- `replayStabilityRate` — with `--repeats > 1`, the share of Cases whose
  Verdict is identical across attempts (`stableAcrossAttempts`)
- `anchorUnresolvedTotal`, `evidenceInsufficientTotal` — Verdict health
  counters collected from each run (proxy stability signals for anchors and
  evidence reproducibility)

## Commands

```bash
taphound benchmark false-done validate --project <android-project> --json
taphound benchmark false-done run --project <android-project> \
  --config .taphound/config.json --device <serial> \
  [--case behavior-01 ...] [--repeats 2] --json
taphound benchmark false-done compare --project <android-project> \
  --baseline <runId> --candidate <runId> --json
```

`run` writes one JSON value to stdout (run id + metrics) and the full
result to `.taphound/build/false-done-runs/<runId>.json`. Each Case installs
its variant APK first (`adb install -r`), then runs
`verify --contract` against the bound Contract. `compare` reads two result
files and reports per-case detection changes plus metric deltas
(`falseDoneRecall` / `falseRejectRate` / `verdictAgreementRate` /
`replayStabilityRate` / error and health counters) — the measurement surface
for the Independent Verification Agent
([`docs/verification-agent.md`](verification-agent.md)).

## Suggested 20-Case Distribution

| Category | Count | Examples |
|---|---|---|
| `correct` | 8 | ordinary fixes that truly work (control group for false rejects) |
| `behavior` | 8 | search context lost, state not restored, wrong navigation, keyboard state wrong |
| `visual` | 2 | layout diverges from reference; wrong style applied |
| `boundary` | 2 | empty list, permission denial, rotation/process restart |

Incremental rollout: start with 5 Cases (3 behavior + 2 correct) to establish
the baseline, then grow to 20 before adding any Verification SubAgent. Only
compare False-Done metrics across runs of the same Case Pack + Knowledge
revision; the metrics are case-family dependent.

## Baseline Procedure

1. Author the pack + contracts + variants.
2. `benchmark false-done run` → record the baseline result file.
3. Any later change (Independent Verification Agent, new resolvers, new
   `ignoreCursorBlink`-style adaptations) → re-run → `falseDoneRecall` /
   `falseRejectRate` must improve or hold; a recall improvement with a
   growing false-reject rate is a trade-off to review, not a win.

## Demo baseline (2026-09-13, Solana Seeker SM02G4061928151, Android 16)

Five Cases against the in-repo demo app (`examples/taphound-android-demo`,
`dev.taphound.demo`), one shared Acceptance Contract
(`.taphound/contracts/fd-search-results.json`) bound to the
`.taphound/journeys/search.json` Journey. Variants are debug builds with a
single source-level fault (or a behavior-preserving refactor), kept under
`.taphound/variants/` (git-ignored; rebuild with
`./gradlew :app:assembleDebug --offline` after patching
`SearchActivity.kt`, then restore the source).

| Case | Category | Variant fault / note | Expected | Actual | Detection |
|---|---|---|---|---|---|
| `correct-baseline` | correct | untouched implementation | pass | pass | confirmed |
| `correct-refactor` | correct | submit extracted into a helper (behavior preserved) | pass | pass | confirmed |
| `behavior-result-missing` | behavior | result text shows `NO RESULTS` instead of the query | fail | fail | detected (ASSERTION_FAILED) |
| `behavior-query-lost` | behavior | logcat drops the submitted query | fail | fail | detected (RUN_FAILED) |
| `behavior-no-submit` | behavior | submit handler is a no-op | fail | fail | detected (RUN_FAILED) |

Runs `fa09a984-2480-401c-bd75-049bb1a3e85b` (explicit appium),
`c99c662a-0de0-40f6-9a3b-3bf5855bdb6c` (auto backend → Appium),
and `32347e71-14ef-47aa-a5a0-cdec20e963c8` (repeats 2):

| Metric | Value |
|---|---|
| falseDoneRecall | 1.0 (3/3) |
| falseRejectRate | 0 (0/2) |
| verdictAgreementRate | 1.0 |
| replayStabilityRate | 1.0 (5/5 cases stable across 2 attempts) |
| errorCount / anchorUnresolvedTotal | 0 / 0 |

Notes:

- `behavior-result-missing` is caught by the Contract assertion layer
  (post-journey `element {text:"NO RESULTS"} absent`), while the other two
  fault cases are caught by the Journey's own replay expect (Logcat) — the two
  layers are complementary.
- Detecting "the result shows the queried text" directly requires a
  text-capable Locator test that is unambiguous; the demo contract uses the
  absence of the explicit failure text plus a present `search_result` element
  instead, because the query text also appears in the input field.
- Environment: this device cannot run the Android CLI `layout`
  service (instrumentation handshake failure) nor the shell `uiautomator`
  service (UiAutomation conflict), so the demo config pins
  `ui.backend=appium-uiautomator2` with a local Appium server
  (`appium --address 127.0.0.1 --port 4723`); the Appium provider implements
  stability sampling itself (`/session/{id}/source` hash diff) because the
  shell UiAutomation is mutually exclusive with an active Appium session.