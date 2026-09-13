# Acceptance Contract and Verdict

Acceptance Contracts make **product intent** the completion criterion. A
Journey proves that a sequence of taps works; a Contract binds a Journey to
the preconditions, post-conditions, and evidence that a task is actually
done. `verify --contract` returns a Verdict
(`PASS` / `FAIL` / `INCONCLUSIVE` / `NEEDS_REVIEW` / `INVALID`) instead of a
replay status.

```text
Product Intent
    ↓
Acceptance Contract  (goal, journey binding, preconditions, assertions, evidence)
    ↓
Runtime Execution   (VerifyRuntime: install → launch → steps → snapshot)
    ↓
Evidence            (report.json, screenshots, Logcat, hook observations)
    ↓
Verdict             (pass / fail / inconclusive / needsReview / invalid)
    ↓
Human / Multimodal Review (optional escalation, see docs/source-of-truth.md)
```

Core rules:

- `verify --contract` emits **exactly one JSON value** on stdout: the Verdict.
  Diagnostics go to stderr. The Verdict is also written as
  `verdict.json` next to `report.json` in the run directory.
- A Verdict never upgrades uncertainty: `error` / `manualRequired` /
  unresolvable assertions / missing required evidence all produce
  `inconclusive`, never `pass`.
- Determinism is preserved: Contract assertions are machine-checkable
  (activity, element presence/absence, Knowledge screen), not LLM-judged.
- Knowledge terms (`screen`, `anchor`) are optional. Contracts that use them
  require a loadable Knowledge registry; otherwise the Verdict is `invalid`
  with `KNOWLEDGE_UNAVAILABLE`.

## Workspace

```text
.taphound/
  contracts/*.json     # committed Acceptance Contracts
  journeys/*.json      # bound Journeys (unchanged lifecycle)
```

The Contract lives in `.taphound/contracts/`; the Journey keeps its own file,
meta sidecar, and lifecycle (`verified` / `promoted` / `stale`). A Contract
**references** its Journey by content hash:

```json
{
  "version": 1,
  "id": "mail-search-return",
  "goal": "Returning from mail detail preserves the search context",
  "targetScreen": "search-results",
  "journey": {
    "path": ".taphound/journeys/search-open-back.json",
    "sha256": "<sha256 of the Journey content>"
  },
  "preconditions": [
    { "kind": "activity", "activity": "com.example.app.InboxActivity", "timeoutMs": 3000 },
    { "kind": "screen", "screen": "inbox", "timeoutMs": 3000 }
  ],
  "assertions": [
    { "type": "element", "locator": { "resourceId": "searchInput" },
      "visibility": "visible", "timeoutMs": 3000 },
    { "type": "element", "locator": { "resourceId": "keyboardContainer" },
      "visibility": "absent", "timeoutMs": 3000 },
    { "type": "activity", "activity": "com.example.app.SearchResultsActivity", "timeoutMs": 3000 },
    { "type": "screen", "screen": "search-results", "timeoutMs": 3000 }
  ],
  "evidenceRequirements": [
    { "kind": "screenshot", "scope": "final", "required": true },
    { "kind": "logcat", "scope": "anyStep", "required": true }
  ]
}
```

## Schema

`AcceptanceContractSchema` (version `1`) is strict and versioned:

| Field | Meaning |
|---|---|
| `id` | stable Contract id (`KnowledgeIdSchema`) |
| `goal` | human-readable intent; never evaluated |
| `targetScreen?` | optional Knowledge Screen the goal targets |
| `journey` | `{ path, sha256 }` — hash binding; drift is `CONTRACT_JOURNEY_DRIFT` |
| `preconditions` | unique kinds: `installed`, `activity`, `screen`, `anchor` |
| `assertions` | at least one: `activity`, `element` (`visibility: visible\|absent`), `screen` |
| `evidenceRequirements` | unique `kind:scope` pairs; `screenshot`/`uiHierarchy`/`logcat`, `final`/`anyStep`, `required` |

Journey hash is `hashJourney` (canonical content), matching
`report.journey.sha256`. The Contract's own `contractSha256` is the SHA-256 of
the Contract file bytes.

## Preconditions

- `installed` is implied by the runtime install check; it always reports
  `passed` when the hook runs.
- `activity` reads `adb.currentActivity` at the pre-journey readiness
  snapshot.
- `screen` runs knowledge Screen detection against a runtime snapshot built
  from the live Activity and layout.
- `anchor` resolves an element-identity Anchor against the readiness layout.
  Unknown / non-element anchors are `unresolved`.

All preconditions are evaluated once, at the readiness snapshot, through the
optional `beforeSteps` hook; the hook outcome never changes the replay report.

## Assertions

Evaluated once against the final post-journey snapshot through the optional
`afterSteps` hook:

- `activity` — `adb.currentActivity` equals the value.
- `element` — `visibility: "visible"` requires a unique Locator match;
  `"absent"` requires no match. Ambiguity is `failed`.
- `screen` — Knowledge Screen detection matches the id; `ambiguous` /
  `unknown` are `unresolved`.

## Evidence requirements

| kind | `final` satisfied when | `anyStep` satisfied when |
|---|---|---|
| `screenshot` | report has at least one screenshot | n/a |
| `uiHierarchy` | at least one step resolved a Locator | n/a |
| `logcat` | report has at least one Logcat artifact | at least one step wrote a scoped Logcat |

Missing **required** evidence yields `inconclusive` with
`EVIDENCE_INSUFFICIENT`.

## Verdict

`ContractVerdictViewSchema` (version `1`) carries: `contractId`,
`contractSha256`, `journeySha256`, `verdict`, `reason`, per-precondition /
per-assertion / per-evidence results, `reportPath`, `reportStatus`,
timestamps, and the environment.

| Verdict | Reasons |
|---|---|
| `pass` | `CONTRACT_OK` |
| `fail` | `RUN_FAILED`, `PRECONDITION_FAILED`, `ASSERTION_FAILED` |
| `inconclusive` | `RUN_ERROR`, `RUN_MANUAL_REQUIRED`, `PRECONDITION_UNRESOLVED`, `ASSERTION_UNRESOLVED`, `EVIDENCE_INSUFFICIENT` |
| `needsReview` | `REVIEW_FINDINGS` (only via `contract review`, never produced by Core) |
| `invalid` | `CONTRACT_INVALID`, `JOURNEY_MISSING`, `JOURNEY_DRIFT`, `KNOWLEDGE_UNAVAILABLE` |

Exit codes: `pass` 0, `fail` the replay failure exit code (1–4), `inconclusive`
1, `needsReview` 1, `invalid` 2.

The view also carries optional `provenance`
(`policyVersion`, `taphoundVersion`, `toolVersions`) and an optional `review`
record (reviewer `source`, `model`, `promptVersion`, `findings`, `applied`,
`baseVerdict`, `baseReason`, `appliedAt`) when findings were merged.

## Commands

```bash
taphound contract validate --contract .taphound/contracts/mail-search-return.json --json
taphound verify --contract .taphound/contracts/mail-search-return.json --json
taphound contract review --verdict <run>/verdict.json --findings <run>/findings.json --json
taphound playbook validate --playbook .taphound/playbooks/behavior-regression.json --json
```

`contract validate` is read-only: schema + hash binding, no device, no
mutation. `verify --contract` runs the full flow (doctor, install, launch,
replay, hooks, evidence, verdict). `contract review` merges external reviewer
findings into a stored `verdict.json`: a lower-trust layer may escalate
`pass` / `inconclusive` to `needsReview`, but never rewrites a deterministic
`fail` / `invalid` (see `docs/source-of-truth.md`). `playbook validate`
checks a Verification Playbook schema, its hash-bound Contract, and its
Escalation Policy rules (see `docs/playbook.md`). Passing a path outside
`.taphound/` is allowed; `--target` is not supported yet.

## Runtime hooks

`VerifyRuntime` accepts optional `beforeSteps` / `afterSteps` hooks
(`VerifyInput.hooks`). Each hook receives `{ deviceRole, deviceSerial, adb,
uiSnapshotProvider, logcat, clock, snapshot }` and returns
`{ status: "passed" | "failed" | "unresolved", message? }`. Hooks:

- never run when undefined (zero behaviour change),
- never mutate the replay report or exit code,
- are isolated: a throwing hook becomes an `unresolved` outcome,
- surface as `VerifyResult.hookOutcomes` (one per phase per device).

`beforeSteps` reuses the readiness snapshot (no extra capture);
`afterSteps` captures one fresh snapshot (only when configured).