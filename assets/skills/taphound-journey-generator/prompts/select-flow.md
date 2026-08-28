# Select a Reusable Base Flow

You are selecting an existing TapHound Flow to reuse before AI-driven Journey
generation.

## Inputs

- **Goal**: the user's natural-language test scenario.
- **Project Context Index**: the current validated module catalog.
- **Flow catalog**: exact output from `taphound journey list-flows --json`.

## Selection Procedure

1. Ignore every Flow whose `status` is not `valid`. Report invalid candidates;
   never silently repair or bypass them.
2. Identify the Activity or screen where the Goal's business-specific actions
   begin.
3. Require the first resolved step to start from a stable Activity that cold
   launch deterministically reaches. `run.activity` is only the cold-launch
   entry and may redirect immediately. Never require a transient Splash
   Activity to remain foreground long enough to become the Flow's first
   checkpoint.
4. Keep only Flows whose `exitActivity` is a deterministic prerequisite for
   that screen and whose traversed Activities are covered by the Context
   modules selected for generation.
5. Prefer the deepest valid Flow, meaning the candidate that eliminates the
   largest reusable navigation prefix. For a Goal inside a chat detail screen,
   prefer `chat/open-thread` over `core/launch-home` when both are valid.
6. Do not select by filename alone. A name containing `core`, `home`, or a Goal
   keyword is not proof that the Flow is applicable.
7. If no candidate is applicable, return `{"selected": null}` and generate from
   the normal launch state.

## Output

```json
{
  "selected": "chat/open-thread",
  "reason": "Deepest valid Flow whose exit Activity is the Goal's chat screen"
}
```

or:

```json
{
  "selected": null,
  "reason": "No valid Flow ends at a prerequisite screen for this Goal"
}
```

## Safety Rules

- A Flow with missing dependencies, a cycle, an Activity boundary mismatch, or
  stale resolution evidence is unusable.
- If a selected Flow fails Core replay, stop and report `FLOW_REPLAY_FAILED`.
  Read its Flow name, Verify report path, primary failure, failed-step summary,
  and recovery guidance. Repair or re-record the shared Flow; do not silently
  regenerate it.
- Do not accept "the device is already on Home" as proof that a failed Flow
  replayed exactly.
- Bypass reuse only when the user explicitly requests generation without a
  base Flow.

## Stable Launch Anchor Example

Model `core/launch-home` as readiness at the stable Home destination, not as a
timing-sensitive `Splash -> Home` transition:

```json
{
  "version": 1,
  "kind": "flow",
  "name": "core/launch-home",
  "includes": [],
  "steps": [{
    "action": "wait",
    "activity": {
      "before": "com.example.app.HomeActivity",
      "after": "com.example.app.HomeActivity"
    },
    "expect": {
      "type": "element",
      "locator": { "resourceId": "home_root" },
      "timeoutMs": 3000
    }
  }]
}
```

Choose an element unique to the ready Home screen for the expectation.
