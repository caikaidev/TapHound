# Verification Playbook and Escalation Policy

Playbooks answer **what to verify, in what order, and when to escalate**. They
do not operate the device — Core exposes the deterministic primitives
(Contract verify, evidence collection, replay), external Skills orchestrate
the phases.

## The four Playbooks

| Playbook | Purpose | Core flow |
|---|---|---|
| `feature-acceptance` | Does the new Feature satisfy the Requirement? | Contract → Run → Evidence → Verdict |
| `bug-regression` | Is the Bug actually fixed? | Repro FAIL → Fix → Same Journey PASS |
| `behavior-regression` | Did a refactor change observable behavior? | Baseline → Change → Replay → Compare |
| `visual-parity` | Does the UI match the reference implementation? | Reference → Runtime → Compare |

A `PlaybookDefinition` (`src/domain/playbook.ts`) declares:

- `id`, `kind`, `goal` (natural language stays external; the schema carries
  the user-facing intent string only);
- `phases` — an ordered, unique sequence from `repro-fail`,
  `contract-verify`, `baseline-capture`, `change-apply`, `replay-journey`,
  `baseline-compare`, `visual-compare`, `evidence-collect`, `verdict-apply`;
- `contract` — a hash-bound reference to the Acceptance Contract (same
  drift detection as Contract → Journey binding);
- `evidenceRequirements` — reused Contract evidence kinds;
- `passCondition` / `failCondition` / `inconclusiveCondition` — deterministic
  predicates over the collected evidence (executed by the external Skill;
  the schema pins the contract of what "pass" must mean);
- `escalation` — the Escalation Policy (below).

## Escalation Policy (architecture doc §19)

Panic-free rule set over **deterministic verdict signals**:

```text
when:  verdict ∈ {pass, fail, inconclusive, needsReview, invalid}
       reason ∈ {CONTRACT_OK, ASSERTION_FAILED, ASSERTION_UNRESOLVED, ...}
then:  action ∈ { verdict(result), escalate(target ∈ {semantic, multimodal}) }
```

Rules are evaluated **in order, first match wins**. The evaluator
(`src/application/playbook/escalation-policy-evaluator.ts`) is pure: it maps
already-collected facts to an explicit rule and never calls a model. This is
the Core guarantee for the architecture principle:

> **When AI is invoked must itself be deterministic.**

Semantics:

- `verdict` action is terminal: the result is the final Verdict.
- `escalate` hands the run to the named layer (`semantic` comparator or
  `multimodal` reviewer). The external Skill applies the layer, produces
  findings, and routes them through `contract review`, which re-enforces the
  Source-of-Truth invariant (`pass`/`inconclusive` may become `needsReview`;
  `fail`/`invalid` are never rewritten — see `docs/source-of-truth.md`).

## Workspace

```text
.taphound/
  playbooks/*.json   # committed Playbook definitions
```

## CLI

```bash
# validate schema + Contract hash binding + policy sanity (read-only)
taphound playbook validate \
  --project /path/to/android-project \
  --playbook .taphound/playbooks/behavior-regression.json \
  --json

# several at once
taphound playbook validate --playbook a.json,b.json
```

`playbook validate` never touches a device. It checks:

- the Playbook parses against `PlaybookDefinitionSchema`;
- the bound Acceptance Contract loads and its `sha256` matches (fail on
  drift);
- each escalation rule is well-formed (unique ids, at least one
  verdict/reason signal);
- no rule escalates a deterministic `pass` to `semantic` (a deterministic
  pass should only go to `needsReview` via reviewer findings).

## Where escalation results are consumed

- `ContractVerdictView.verdict` supports `needsReview`
  (`docs/contract-schema.md`).
- `contract review` (findings merge) enforces the immutability invariant
  (`docs/source-of-truth.md`).
- `benchmark false-done` counts a `needsReview` actual as `detected`
  (`docs/false-done-benchmark.md`).