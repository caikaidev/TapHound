# Knowledge and Route Planning

TapHound can add deterministic planning to Generation without changing the
Journey v2 replay protocol. The feature is deliberately small:

- named Anchors use Activity, window, or the existing Locator fields,
- Screens are project-defined sets of observable predicates,
- Transitions connect Screens and describe one existing action,
- the Route Planner uses deterministic weighted shortest-path search,
- the Action Resolver emits the existing strict `ProposedStep`,
- only Generation may re-plan, and finalization still performs one exact replay.

TapHound Core does not translate natural language and does not call a model.
External Skills or workflows produce a strict JSON Goal Spec and may report LLM
usage through Benchmark results.

## Workspace

Committed authority:

```text
.taphound/
  knowledge/
    index.json
    anchors/*.json
    screens/*.json
    transitions/*.json
  benchmarks/*.json
  ground-truth/*.json
```

Ephemeral evidence:

```text
.taphound/build/
  knowledge-receipts/*.json
  benchmark-runs/*.json
```

The UI cache remains rebuildable and is never treated as committed Knowledge.
Normal observation and execution write immutable receipts only. They never
modify `.taphound/knowledge/`.

## Bootstrap and review

Seed inferred Knowledge explicitly from the current Project Context:

```bash
taphound knowledge bootstrap \
  --project /path/to/android-project \
  --context .taphound/context/project-context.json \
  --json
```

Validate the committed Registry and obtain its binding hash:

```bash
taphound knowledge status --project /path/to/android-project --json
```

Bootstrap is conservative. Activity transitions are converted only when each
side maps to one Screen. Ambiguous static hints remain absent. Review and edit
the generated JSON before relying on it.

Use `knowledge promote --input <promotion.json>` to apply a reviewed,
receipt-backed update. A promotion must bind `expectedKnowledgeHash`; a
concurrent or drifted Registry is rejected instead of overwritten.

## Receipt-folded evolution

Runtime commands accumulate immutable receipts under
`.taphound/build/knowledge-receipts/`. `knowledge evolve` folds the receipts
bound to the current Registry hash back into authority:

```bash
taphound knowledge evolve \
  --project /path/to/android-project \
  --expected-hash <knowledgeHash> \
  --json
```

Deterministic folding rules:

- each bound `transitionVerification` receipt adds one attempt to its
  Transition; `verified` also adds a success and `deviated` adds recovery
  cost,
- matched `screenDetection` and `anchorResolution` evidence upgrades
  `inferred` Screens and Anchors to `observed`,
- a Transition with at least one folded success is upgraded from `inferred`
  to `observed`,
- statuses never downgrade, and `verified` remains reserved for explicit
  promotion.

Because receipts record the exact `knowledgeHash` they observed, folded
receipts cannot be double-counted: the next revision has a new hash and only
newly bound receipts are eligible. When nothing changes, `evolve` reports
`status: "unchanged"` and does not write a revision. Transition observation
counts feed the Route Planner's edge cost, so repeatedly verified Transitions
become cheaper than unproven ones.

## Feature Map projection

`knowledge feature-map` derives a read-only, deterministic, low-token
projection of the committed Registry for agents:

```bash
taphound knowledge feature-map --project /path/to/android-project --json
taphound knowledge feature-map --project /path/to/android-project --markdown
```

A Feature is the set of Screens reachable from one entry Screen (a Screen with
no incoming Transition); entries, features, Transitions, and Anchors are mapped
and sorted deterministically, and the bundle hash is carried for drift
detection. The projection is never a second Source of Truth and never modifies
device state. See [`docs/feature-map.md`](./feature-map.md).

## Goal scaffolding

`knowledge goal` drafts the strict Goal Spec for a known Screen without
hand-editing JSON:

```bash
taphound knowledge goal \
  --project /path/to/android-project \
  --target todo-create \
  --parameter title=TeamSync \
  --max-steps 5 \
  --max-replans 1 \
  --json
```

The command validates that the target Screen exists in the committed
Registry. Natural-language intent stays outside Core: an external Skill or
agent selects the target Screen and literal parameters, then the drafted
Goal feeds `generation start --goal`.

## Goal-bound Generation

A Goal Spec is canonical JSON:

```json
{
  "version": 1,
  "id": "open-mail-detail",
  "targetScreen": "mail-detail",
  "parameters": {},
  "limits": {
    "maxSteps": 8,
    "maxReplans": 2
  }
}
```

Start a planning-aware session:

```bash
taphound generation start \
  --project /path/to/android-project \
  --context .taphound/context/project-context.json \
  --goal goals/open-mail-detail.json \
  --json
```

This creates Generation session v2 with immutable Knowledge and Goal hashes.
Sessions without `--goal` remain readable and writable v1 sessions.

Execute one known Transition:

```bash
taphound generation next \
  --project /path/to/android-project \
  --session <generation-id> \
  --json
```

`next` observes, recognizes the Screen, computes a bounded Route, resolves its
first Transition to a `ProposedStep`, and passes that proposal through the
existing snapshot freshness and risk-confirmation flow. Post-action observation
verifies the expected Screen. A modeled deviation consumes re-plan budget and
records receipts. Unknown or ambiguous Screens, missing Anchors, stale
Knowledge, no Route, and exhausted budgets fail closed.

Continue until `status: "goalReached"`, then use the existing `generation
finalize`. Final replay never changes route and never consults the planner.

## Anchors in Journey steps

Committed `anchor` ids may be used directly as an action target, so a Journey
step is not tied to a single UI resource id. `click`, `longClick`, `swipe`,
`scrollTo`, and `inputText` steps accept an `anchor` instead of, or alongside,
`locator`; `scrollTo` resolves the anchor to element bounds before swiping and
`inputText` taps the anchor point to focus the field before typing. Replay
resolves the anchor against the fresh layout first and falls back to the
`locator` only when the step carries one, recording
`anchor: { status: "locatorFallback" }` in the report. See
[`docs/journey-schema.md`](./journey-schema.md),
[`docs/report-schema.md`](./report-schema.md), and
[`docs/semantic-anchor.md`](./semantic-anchor.md) for the full protocol.

Anchors are **Semantic UI References**: an optional ordered `candidates`
chain (`composeSemantics` → `resourceId` → `contentDescription` →
`visibleText` → `visualMatch`) is resolved deterministically, the first unique
match wins, and the report records `resolvedBy { kind, confidence }`
(`primary`/`fallback`). `visualMatch` is never performed by Core: when only it
remains, resolution fails closed as `visualOnly` →
`RUNTIME_CAPABILITY_MISSING`, leaving visual matching to an external
multimodal layer under the Escalation Policy.

## Journey promotion

`generation finalize` exports each verified Journey with a
`<name>.meta.json` sidecar in `status: "verified"`. High-value Journeys can
then be promoted into durable assets:

```bash
taphound journey promote \
  --project /path/to/android-project \
  --journey .taphound/journeys/todo-create.json \
  --reason "core regression path" \
  --json
```

Promotion re-reads the generation bundle, re-hashes the verification report,
compares the exported Journey against the verified Journey evidence, and only
then rewrites the sidecar to `status: "promoted"` with `promotedAt` and the
recorded reason. Missing evidence, hash drift, an edited Journey, or an
already promoted sidecar fails closed with a `JOURNEY_*` or `EVIDENCE_*`
code at exit code 2.

## Offline planning and Benchmark

`knowledge plan --goal <goal.json> --snapshot <snapshot.json> --json` runs
Screen recognition and Route planning without device mutation.

Benchmark Case, Ground Truth, per-Case result, and aggregate run schemas are
strict JSON domain protocols. `BenchmarkRunner` accepts an injected legacy or
knowledge executor, excludes `invalid` and `notRun` preconditions from engine
failure rates, and writes stable machine-readable results. Concrete business
Cases stay in the target Android project or an external validation repository.
