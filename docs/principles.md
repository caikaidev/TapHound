# Product and Architecture Principles

TapHound exists so that Android changes written by AI coding agents are
proven on a device before anyone calls them done. The agent writes code
faster than people can review it; TapHound turns "done" into deterministic
evidence. See [Workflow Skills](workflow-skills.md) for how each kind of
change (new behavior with or without UI, refactor, UI toolkit migration,
structural UI change) is proven.

> **Outsource mechanics. Own semantics. Verify outcomes.**

| Mechanics (reuse, behind adapters) | Semantics and outcomes (TapHound owns) |
|---|---|
| device discovery, install, launch, stop | Project Context and Journey Briefs |
| tap, swipe, text input, screenshots | Locator and Semantic Anchor resolution |
| UI hierarchy dumps, Logcat streams | Journeys, Flows, and deterministic Replay |
| runtime servers (Appium, Mobile MCP) | expectations, Contracts, Baselines, Verdicts |
| | evidence, freshness and drift detection, recovery policy |

## Deciding whether a feature belongs in Core

Ask: *if Appium or Mobile MCP made this capability perfect tomorrow, would
TapHound still need to own it?* If not, it belongs in a Runtime Backend
adapter (`docs/architecture/runtime-backend.md`), not in Core.

Before adding a feature, check that it:

1. improves deterministic verification, Project Context, semantic stability,
   Journey reuse, or change-impact selection;
2. is not reasoning the external coding agent can already do;
3. adds no model dependency to Core;
4. is not generic Android plumbing handled elsewhere.

Reimplementing device plumbing (a faster adb wrapper, Appium parity, more
tap/swipe tools, every UIAutomator edge case) needs all three: the reused
runtime demonstrably cannot meet TapHound's needs, the gap directly harms
verification accuracy, and no adapter or fallback can close it.

## Out of scope for Core

- embedded models, model routing, or any provider API key;
- LLM planning, autonomous navigation, or autonomous recovery;
- visual grounding or OCR as a source of truth (`visualMatch` fails closed);
- a general-purpose device automation or MCP server;
- cross-app or system-app automation beyond bridge steps with External Flows.

Agents plan, propose, and diagnose outside Core; Core binds state, enforces
risk policy, executes, replays, and publishes evidence. A reviewer or model
may escalate a result to `needsReview`, never rewrite a deterministic `fail`
(see [Source of Truth](source-of-truth.md)).

## Keeping the surface small

Pre-1.0, a concept that sits beside the verify path instead of on it is
removed rather than maintained, and persisted formats keep exactly one
current shape: stale artifacts are regenerated, not migrated.
