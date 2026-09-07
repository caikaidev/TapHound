# Benchmark

TapHound Benchmark compares Journey replay against Knowledge-driven
generation on the same set of Cases and Ground Truth. It is the Roadmap M4
deliverable: a reproducible, device-bound measurement of what the Knowledge
engine adds over recorded baselines.

TapHound ships only the framework. Cases, Ground Truth, Journeys, Flows, and
Knowledge for a concrete Android app live in that host project's `.taphound/`
workspace.

## Workspace

Committed authority:

```text
.taphound/
  benchmarks/*.json     # Benchmark Cases (goal + limits + baseline)
  ground-truth/*.json   # expected routes per Case
  flows/*.json          # baseFlow baselines
  journeys/*.json       # legacy baselines
```

Ephemeral evidence:

```text
.taphound/build/
  benchmark-runs/*.json # one JSON result per engine run
  knowledge-receipts/   # promotion evidence
```

## Engines

| Engine    | What runs                                                        | Baseline required        |
| --------- | ---------------------------------------------------------------- | ------------------------ |
| `legacy`  | exact replay of a published Journey                               | `kind: "journey"`        |
| `baseFlow`| replay of a reusable Flow prefix                                  | `kind: "baseFlow"`       |
| `knowledge`| full Generation loop: observe, plan, resolve, execute, re-plan  | none                     |

A Case carries one optional `baseline`, and the replay engines validate that
`baseline.kind` matches the engine. A three-engine comparison therefore flips
the Case's `baseline` between the `journey` and `baseFlow` forms (or drops it
for `knowledge`); the Case goal and Ground Truth stay untouched.

## Metrics

- `passedCases / eligibleCases` — replay passed / goal reached
- `firstRunSuccessRate` — passed without recovery
- `routeAccuracy` (knowledge only) — planned transition chain equals the
  Ground Truth route, screen for screen and hop for hop
- per-step timing: `recognitionMs`, `planningMs`, `actionResolutionMs`,
  `executionMs`, `totalMs`
- LLM counters — TapHound Core calls no model; external Skills may report
  their usage through these fields

## Commands

```bash
taphound benchmark validate --project <android-project>
taphound benchmark list --project <android-project>
taphound benchmark run --project <android-project> \
  --engine legacy|baseFlow|knowledge [--case <id>...] --device <serial> --json
taphound benchmark compare --project <android-project> \
  --baseline <runId> --candidate <runId> --json
```

`benchmark run` writes one machine-readable JSON value to stdout and a result
file under `.taphound/build/benchmark-runs/`.

## Acceptance matrix (2026-09-07, single physical device)

Five Cases against one host Android app, Knowledge revision 7
(receipt-backed promotions; every route transition is observed or verified):

| Case                 | Goal route                                  | Hops |
| -------------------- | ------------------------------------------- | ---- |
| `splash-home-search` | cold start, then home search                | 2    |
| `home-search`        | home search                                 | 1    |
| `home-tab-sort`      | home tab sort panel, via the More drawer    | 2    |
| `search-mail`        | mail search, via the Mail tab               | 2    |
| `ai-chat`            | AI chat                                     | 1    |

| Engine     | Run                                  | Passed | Route accuracy |
| ---------- | ------------------------------------ | ------ | -------------- |
| `legacy`   | `2ebcd7ab-c7d9-4340-a565-4170c13e58e8` | 5/5    | n/a            |
| `baseFlow` | `a71983b3-4329-4d0a-88be-f4801a50000a` | 5/5    | n/a            |
| `knowledge`| `b819d5d4-30e1-401c-826b-4223cb9c0b3f` | 5/5    | 4/5            |

`benchmark compare --baseline <legacy> --candidate <knowledge>`: both engines
pass 5/5 with `firstRunSuccessRate` 1.0; knowledge adds ~72 ms average
recognition and sub-millisecond planning per step, with zero replays on every
case.

The single `routeAccuracy` miss is the cold-start Case: the splash screen
auto-advances to home before the first observation stabilizes, so the planner
correctly plans the 1-hop route from home while the Ground Truth records the
full 2-hop route from splash. This is a first-observation timing property of
the cold-start Case, not a planning defect; the case still passes.

## What the matrix required of Knowledge

The three multi-hop Cases were blocked by bootstrap-inferred Knowledge before
this run. Receipt-backed promotions fixed them without touching Core:

- the home tab bar hides the sort entry behind a More drawer, and the mail
  search entry behind the Mail tab — both states are now explicit screens
  with observed transitions instead of one-hop guesses,
- two mail-search screen anchors only exist after user input (a clear button
  and an attachment filter), so they moved from required to optional, matching
  the established conditional-anchor handling,
- every fix was validated by replaying all recorded screen-detection receipts
  against the promoted registry before promotion (zero regressions), and each
  promotion is bound to the receipts that evidence it.

## Conclusion

- Recorded baselines and Knowledge-driven generation both pass the full
  matrix on a live device; Knowledge reached every goal with zero replans.
- Knowledge route planning is deterministic and cheap (sub-ms planning); the
  per-step cost is device-bound recognition, not search.
- Route accuracy against Ground Truth is exact whenever the Case's start
  screen is stable before the first observation; cold-start timing, not
  planning, explains the one miss.
