# TapHound Terminology

TapHound has several state vocabularies that live in different domain
schemas. This document is the single reference for their meanings, their
relationships, and the conventions for adding new ones. Do not create a new
synonym for an existing token; prefer the closest existing vocabulary and
extend it deliberately.

## Domain statuses

### Knowledge (`src/domain/knowledge.ts`, `KnowledgeStatusSchema`)

| Status | Meaning |
|---|---|
| `inferred` | Projects from a known context (bootstrap/placement); no device-observed evidence yet. |
| `observed` | Promoted from inference by matched `screenDetection` / `anchorResolution` receipts. |
| `verified` | Covered by `transitionVerification` receipts; `verified` never downgrades, and only `verified` knowledge may promote to `trusted`-style use (see Journey promotion below). |

### Journey lifecycle (`src/domain/journey-lifecycle.ts`, `JourneyLifecycleStateSchema`)

| Status | Meaning |
|---|---|
| `draft` | No generation meta sidecar yet. |
| `verified` | Generation bundle re-verified; bindings fresh — but not yet *promoted*. |
| `suspect` | Config-only drift since verification. |
| `stale` | Project or module evidence drifted since verification. |
| `retired` | Explicitly retired via `journey retire` (never re-activated). |

`journey promote` moves `verified → promoted` (sidecar
`promotion: {promotedAt, reason}`); `promoted` is recorded in
`generation.ts` as the final state of the Journey lifecycle.

### Acceptance Contract Verdict (`src/domain/contract.ts`, `ContractVerdictSchema`)

| Status | Meaning |
|---|---|---|
| `pass` | Contract satisfied by runtime evidence (`CONTRACT_OK`). |
| `fail` | Replay or an assertion/precondition failed (`RUN_FAILED`, `PRECONDITION_FAILED`, `ASSERTION_FAILED`). |
| `inconclusive` | Evidence insufficient or conditions undeterminable (`RUN_ERROR`, `RUN_MANUAL_REQUIRED`, `*_UNRESOLVED`, `EVIDENCE_INSUFFICIENT`). |
| `needsReview` | Ambiguous evidence suggests a possible regression; requires human review (`REVIEW_FINDINGS`, only via `contract review`). |
| `invalid` | The Contract or its environment cannot be trusted (`CONTRACT_INVALID`, `JOURNEY_MISSING`, `JOURNEY_DRIFT`, `KNOWLEDGE_UNAVAILABLE`). |

### Verification run & step (`src/domain/report.ts`)

| Token | Schema | Statuses |
|---|---|---|
| Run | `RunStatusSchema` | `passed`, `failed`, `error`, `manualRequired` |
| Step | `ResultStatusSchema` | `passed`, `failed`, `notRun`, `manualRequired` |
| Layer | `LayersSchema` (reuses `ResultStatusSchema`) | per-layer `passed` / `failed` / `notRun` / `manualRequired` |

### Contract evaluation details (`contract.ts` outcomes)

`passed` / `failed` / `unresolved` / `notRun` for per-precondition and
per-assertion entries, plus boolean evidence `satisfied`.

### Benchmark (`src/domain/benchmark.ts`)

| Token | Statuses |
|---|---|
| Case result | `passed`, `failed`, `invalid`, `notRun` |
| False-Done detection (`false-done.ts`) | `confirmed`, `missed`, `falseReject`, `detected`, `error` |

### Project Context (`src/domain/project-context.ts`, `ContextShardStatusSchema`)

`complete`, `partial`, `unsupported`, `notAnalyzed` (per-module shards).

### Receipts (`src/domain/knowledge-receipt.ts`)

`matched` / `ambiguous` / `unknown` (screen detection), anchor resolution
`found` / `notFound` / `ambiguous` — these are observation outcomes, not
lifecycle states.

### Anchor resolution confidence (`src/domain/knowledge.ts`, report anchor)

`resolvedBy.kind`: `composeSemantics` / `resourceId` / `contentDescription` /
`visibleText` / `visualMatch`; `confidence`: `primary` (first candidate) /
`fallback` (a later candidate — anchor still works, signal degraded);
`visualOnly` means only `visualMatch` could resolve, which Core never
performs (`RUNTIME_CAPABILITY_MISSING`).

### Playbook and Escalation (`src/domain/playbook.ts`)

- Playbook kind: `feature-acceptance` / `bug-regression` /
  `behavior-regression` / `visual-parity`.
- Escalation action: `verdict(result)` is terminal; `escalate(target)` hands
  the run to `semantic` or `multimodal` (first-match, ordered rules).

### Baseline and Regression (`src/domain/checkpoint.ts`)

- Baseline facts: `activities` (per-step before/after), `elements`
  (`present` / `absent`), `screens` (`matched`).
- Regression diff kinds: `activity` / `element` / `screen`;
  `equivalent: true` means zero drifted facts.

### Failure classification (`src/domain/failure-classification.ts`)

- `type`: taxonomy map of the failure code; `stage`: setup/launch/navigation/
  interaction/assertion/evidence/finalize/unknown.
- A Coding or Diagnosis Agent consumes the classification; raw evidence is
  referenced by `evidenceRefs` paths, never dumped.

## Cross-domain maps (important)

`passed`/`failed` appear in run, step, layer, Contract evaluation, and
Benchmark contexts. They share the "business result" meaning but do **not**
interchange:

- A **run** `passed` does not imply a **Contract verdict** `pass`: the verdict
  adds preconditions, post-journey assertions, evidence requirements, and the
  `invalid`/`inconclusive` branches.
- **Knowledge** `verified` ≠ **Journey** `verified`: the former means
  receipt-backed evidence; the latter means a replayed generation result with
  fresh bindings (and precedes `promoted`).
- A **step** `failed` while the run is `passed` cannot happen (replay stops at
  first primary failure), but a step `notRun` with run `passed` is normal for
  steps after an `unresolved` hook.

## Roadmap vocabulary → current fields

The Roadmap (V0.x planning docs) uses a looser vocabulary. Map it to the
enums above instead of introducing new schemas:

| Roadmap term | Current equivalent |
|---|---|
| `fresh` | Journey `verified` with fresh `/journey check` bindings; Knowledge `verified` with receipts |
| `trusted` | Journey `promoted`; Knowledge eligible as promotion-gated `verified` |
| `stale` | Journey `stale` (evidence drift) or `suspect` (config-only drift); Knowledge hash drift reported by `knowledge evolve` (`unchanged` otherwise) |
| `needsRevalidate` | Journey `stale`/`suspect` state + `knowledge evolve` no-op/`UNCHANGED` report; trigger on `journey check` |
| `blocked` | `CONTRACT_KNOWLEDGE_UNAVAILABLE` / `KNOWLEDGE_UNAVAILABLE` / `ENVIRONMENT_MISSING_TOOL` / capability-gated `RUNTIME_CAPABILITY_MISSING` |
| `PASS` / `FAIL` / `INCONCLUSIVE` / `NEEDS_REVIEW` / `INVALID` | Contract Verdict `pass` / `fail` / `inconclusive` / `needsReview` / `invalid` |

## Conventions

1. **Result state verbs** for completed outcomes (`passed`, `failed`,
   `notRun`); **progressive adjectives** while running (`inProgress` is not
   used — use timestamps instead).
2. `invalid` is reserved for *cannot be trusted* (schema/hash/environment);
   `error` for *a run could not complete*; `inconclusive` for *ran, but the
   answer is undetermined*.
3. **Promotion gating**: only receipts/evidence can move a value toward
   `verified`/`promoted`; statuses never downgrade (exception: Journey
   `retired` is terminal).
4. New vocabularies must be added to this table in the same change as the
   schema; a name that cannot be explained by a sibling row is a sign of a
   duplicate concept.