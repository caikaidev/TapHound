# Independent Verification Agent (V0.7)

Independent Verification is TapHound's first-class principle: the entity that
decides "done" must not inherit the implementer's reasoning. TapHound Core
stays deterministic and model-free; the Verification Agent is an
**orchestration-layer role** (an external Workflow Skill) that drives TapHound
deterministic commands and consumes their JSON evidence. This document is the
framework contract for that role and the measurement protocol that proves it
adds value.

```text
Implementer (can READ contract, WRITE implementation)
        │
        ▼
Acceptance Contract  ──(hash-bound, immutable to the Verifier)──▶  Verification Agent
        │                                                              │ cold context only:
        │                                                              contract + Knowledge + device
        ▼                                                              readonly + evidence-driven
   Running App  ── tap  ──▶  TapHound verify --contract ──▶  Verdict               │
        ▲                            │                                         verdict == PASS?
        │                            ▼                                            │
        └──────────────  implementer fixes  ◀── Diagnosis (only after FAIL) ◀─────┘
```

## 1. Principles that the role must honor

| Principle | Enforcement |
|---|---|
| Context Isolation | The Verifier receives the Accept Contract, Project Knowledge, the running app, and TapHound evidence — never the implementer's diff/transcript/fix summary (see §3). |
| Model Diversity | The Verifier may be a different model/provider than the Implementer; choose a model with no shared conversation state. |
| Contract Immutability | The Verifier has READ on the Contract, EXECUTE on verification, and NO write. Only `propose_contract_change` is allowed; changing a Contract to make a failing run pass is forbidden. |
| Runtime Evidence | A Verdict must be derived from TapHound Verdict JSON + evidence artifacts, never from an implementer's claim. |

## 2. Role skill contract (external Skill)

A Verification Agent Skill exposes one operation:

```text
Input
  taskId
  contractPath      (project-relative Acceptance Contract)
  projectRoot
  knowledgePath?    (Project Context / Knowledge read-only)
  deviceSerial?     (if omitted, TapHound selects)
  evidenceDir?      (optional baseline evidence for re-verify)

Procedure
  1. Read the Contract (hash shown by `contract validate`).
  2. Run:  taphound verify --contract <path> --device <serial> --json
  3. Parse the single JSON Verdict. Never reinterpret evidence; quote it.
  4. If verdict == "pass"  →  return PASS with reportPath/verdict.json refs.
  5. If verdict == "fail" →  return FAIL + diagnosis (see §5), only now may
     the Diagnosis phase read the diff/source.
  6. If "inconclusive"/"invalid" → return the reason (RUN_ERROR,
     EVIDENCE_INSUFFICIENT, JOURNEY_DRIFT, KNOWLEDGE_UNAVAILABLE, ...); do not
     retry with edited Contracts.

Output
  { verdict, reason, contractSha256, reportPath, verdictPath, diagnosis? }
```

Constraints (enforced by the Skill, not by Core):

- Never invoke the input Text Editor or patch files during verification.
- Never pass the implementer's chat history or PR description into context.
- Never "verify" by inspection — every conclusion cites a TapHound artifact.
- Detection of a modified Contract after binding is Core's job
  (`JOURNEY_DRIFT` → `invalid`); the Agent must surface it, not work around it.

## 3. Cold context inventory

**Verifier gets:**

- Acceptance Contract (JSON) + its `contractSha256`
- Project Knowledge / Feature Map projection (read-only — `taphound
  knowledge feature-map --markdown`, see [`docs/feature-map.md`](./feature-map.md))
- TapHound Verdict JSON, `report.json`, `verdict.json`, screenshots, Logcat
- Device access (through TapHound commands only)

**Verifier must not get:**

- Implementer's diff, branch name, or implementation explanation
- The coding transcript or any "I fixed it" summary
- The right to write files, install packages, or change config

## 4. Existing TapHound surfaces the Agent uses

| Surface | Use |
|---|---|
| `taphound verify --contract <path> --json` | the verification run; one Verdict JSON on stdout |
| `taphound verify --diff <ref> --json` | minimal Journey set a Git change affects; one `overall` verdict |
| `taphound contract validate --json` | static pre-check (schema + Journey hash binding) |
| `taphound failure classify --report <path> --json` | structured failure contract (§5 diagnosis) |
| `taphound baseline compare --baseline <path> --report <path> --json` | behavior drift against a known-good run |
| `docs/contract-schema.md` | Verdict/reason semantics |
| `taphound benchmark false-done run/compare --json` | measurement (§6) |
| `.taphound/build/runs/<runId>/verdict.json` | immutable per-run evidence |

No new Core API is required for V0.7; the Agent is pure orchestration over
deterministic commands. If a future need arises (e.g. batched evidence
packing), add a read-only command, never model-aware logic, to Core.

## 5. Diagnosis protocol (only after FAIL)

The Diagnosis phase (separate role or second phase) receives:

- FAIL evidence: failed assertion, observed state, evidence refs, suspected
  layer, confidence

and may then read the diff/source/logs. Suggested structured output:

```yaml
diagnosis:
  failed_assertion: keyboard.hidden
  observed: { keyboard_visible: true }
  suspected_layer: ui_state
  evidence: [screenshot, hierarchy]
  confidence: 0.91
```

Diagnosis never modifies code directly and never edits the Contract.

## 6. Measurement protocol (prove the Agent works)

Baseline-first, per `docs/false-done-benchmark.md`:

```bash
# baseline (current deterministic verification, no Agent)
taphound benchmark false-done run --project <p> --json
# candidate (Agent-driven verification on the SAME pack + Knowledge revision)
taphound benchmark false-done run --project <p> --json
# measure
taphound benchmark false-done compare \
  --baseline <baselineRunId> --candidate <candidateRunId> --json
```

Judgment rules:

- A change is an improvement only if `falseDoneRecall` (or
  `verdictAgreementRate`) increases while `falseRejectRate` does not rise.
  A recall gain with a rising false-reject rate is a trade-off to review.
- Only compare runs over the same Case Pack + Knowledge revision; the metrics
  are case-family dependent.
- Always re-run with `--repeats 2` (`replayStabilityRate`) before trusting a
  single run.
- A candidate Agent that leaves `recall/reject/agreement` unchanged adds no
  measurable value over the deterministic baseline and should not ship.

The V0.6 demo baseline is recorded in `docs/false-done-benchmark.md`
(Recall 1.0 / Reject 0 / Agreement 1.0 / Stability 1.0).

## 7. Rollout path

1. Grow the Case Pack to 20 (8 correct / 8 behavior / 2 visual / 2 boundary)
   for a discriminating baseline.
2. Ship the Verification Agent Skill (§2) behind the existing CLI surfaces.
3. Re-run the pack, compare, keep only if metrics improve (§6).
4. Add Blind Verification (Phase A/B): run the verifier on a cold checkout
   before showing any code; diagnosis only after FAIL.
5. Add Model Diversity when a second model is available; record model ids in
   the run metadata (LLM counters field of `BenchmarkCaseResult`) for audit.