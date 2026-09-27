# Source of Truth Hierarchy

TapHound verdicts are produced by layers of decreasing trust. This is a hard
architectural invariant, not a suggestion.

```text
Deterministic Verification
        >
Deterministic Semantic Comparison
        >
AI / Multimodal Reviewer
        >
Human Review
```

## The one rule that cannot be broken

> **A lower-trust layer may escalate a successful result into failure or
> review, but must never convert a deterministic failure into success.**

Concretely:

```text
Deterministic FAIL
    ↓
FAILED
```

No AI, semantic model, or reviewer is allowed to rewrite it as VERIFIED.
There is no path from `fail` (or `invalid`) back to `pass`.

## Verdict model

| Verdict | Meaning | Producers |
|---|---|---|
| `pass` | All required deterministic contracts passed. | `verify --contract` (Core) |
| `fail` | Deterministic evidence proves a contract violation. | `verify --contract` (Core) |
| `inconclusive` | Required evidence could not be collected; the contract could not be fully evaluated. | `verify --contract` (Core) |
| `needsReview` | Non-deterministic or ambiguous evidence suggests a possible regression. | `contract review` (escalation), never produced by Core automatically |
| `invalid` | Pre-flight rejection: unloadable contract, drift, missing Knowledge. | `verify --contract` (Core) |

## Escalation rules

The layering is enforced by `ContractReviewMerger`
(`src/application/contract/contract-review.ts`):

| Base Verdict | Reviewer findings applied? | Result |
|---|---|---|
| `pass` | yes | `needsReview` (`REVIEW_FINDINGS`) |
| `inconclusive` | yes | `needsReview` (`REVIEW_FINDINGS`) |
| `needsReview` | yes (findings appended) | stays `needsReview` |
| `fail` | no | stays `fail` — immutable |
| `invalid` | no | stays `invalid` — immutable |

The recorded review entry always carries `baseVerdict`, `baseReason`,
`applied`, reviewer `source`, `model`/`promptVersion` (when known), and
`appliedAt`, so an escalation is fully auditable.

## Deterministic escalation gates

*When* a run is escalated to a lower-trust reviewer is decided by the external
Workflow, never by Core. Core's guarantee is on the way back in: reviewer
findings enter only through `contract review`, which may escalate
`pass` / `inconclusive` to `needsReview` but never rewrites a deterministic
`fail` / `invalid`.

## Deterministic coverage

A mature TapHound should maximize deterministic verification and minimize
reliance on AI judging. The False-Done Benchmark developer tool treats `needsReview` for a
false-done case as `detected` (the harness flagged it for a human), and
`pass` as `missed` — the only unacceptable outcome.