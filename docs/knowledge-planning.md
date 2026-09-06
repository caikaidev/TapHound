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

## Offline planning and Benchmark

`knowledge plan --goal <goal.json> --snapshot <snapshot.json> --json` runs
Screen recognition and Route planning without device mutation.

Benchmark Case, Ground Truth, per-Case result, and aggregate run schemas are
strict JSON domain protocols. `BenchmarkRunner` accepts an injected legacy or
knowledge executor, excludes `invalid` and `notRun` preconditions from engine
failure rates, and writes stable machine-readable results. Concrete business
Cases stay in the target Android project or an external validation repository.
