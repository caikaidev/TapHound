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
3. Keep only Flows whose `exitActivity` is a deterministic prerequisite for
   that screen and whose traversed Activities are covered by the Context
   modules selected for generation.
4. Prefer the deepest valid Flow, meaning the candidate that eliminates the
   largest reusable navigation prefix. For a Goal inside a chat detail screen,
   prefer `chat/open-thread` over `core/authenticated-home` when both are valid.
5. Do not select by filename alone. A name containing `core`, `home`, or a Goal
   keyword is not proof that the Flow is applicable.
6. If no candidate is applicable, return `{"selected": null}` and generate from
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
  Do not silently regenerate the shared prefix.
- Bypass reuse only when the user explicitly requests generation without a
  base Flow.
