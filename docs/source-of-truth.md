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

*When* a run is escalated to a lower-trust layer is decided by an explicit,
ordered Escalation Policy in the Playbook (`docs/playbook.md`). The
`EscalationPolicyEvaluator` is pure and maps only collected verdict/reason
facts to rules — no model call is allowed before the rule fires. This is the
Core guarantee behind "when AI is invoked must itself be deterministic".

## Deterministic coverage

A mature TapHound should maximize deterministic verification and minimize
reliance on AI judging. The benchmark treats `needsReview` for a
false-done case as `detected` (the harness flagged it for a human), and
`pass` as `missed` — the only unacceptable outcome.