# scrollTo Bounded Scroll-to-Find Design

## Problem

TapHound replays journeys deterministically with no loops or conditionals. To
act on a list item that is off-screen, an author can only record a fixed number
of `swipe` steps. When the target's position drifts (new items pushed in, list
length changes), a fixed swipe count overshoots or undershoots and the following
locator resolution fails.

Real flows such as "open a conversation, scroll to a specific message,
long-press it, tap a menu item" need a way to scroll until a target becomes
visible, without abandoning determinism.

## Goal

Add a deterministic `scrollTo` action that scrolls a named scrollable container
in one direction, re-reading the layout after each swipe, until a target locator
resolves uniquely. The search is bounded by `maxSwipes`; exhausting the bound is
a deterministic failure. `scrollTo` only brings the target into view; a separate
following `click`/`longClick` step operates on it.

Non-goals: no "if exists" conditional steps, no optional steps, no unbounded
scrolling, no selecting a RecyclerView item by ViewHolder type.

## Protocol (`src/domain/journey.ts`)

New step type added to `JourneyStepSchema`:

```ts
const ScrollToStepSchema = z.strictObject({
  action: z.literal("scrollTo"),
  locator: LocatorSchema,      // target to bring into view
  container: LocatorSchema,    // scrollable element the swipe gesture acts on
  direction: z.enum(["up", "down", "left", "right"]),
  maxSwipes: z.number().int().positive().max(30).default(20),
  distancePercent: z.number().positive().max(1).default(0.6),
  durationMs: z.number().int().positive().default(300),
  ...CommonStepShape           // activity (before/after), optional expect
});
```

- No annotated-label (`#number`) fallback: the fallback is only meaningful for
  clicking a visible element, not for a locator-driven scroll search.
- `container` and `locator` are both `LocatorSchema` and follow the fixed
  locator priority (`resourceId`, then `text`, then `contentDescription`).

## Replay (`src/application/runtime/step-runner.ts`)

`StepRunner.run` branches on `step.action === "scrollTo"`, replacing the generic
"read layout once + resolve locator" middle section with a bounded loop:

1. Check `before` Activity (existing behavior).
2. Loop, at most `maxSwipes` swipes:
   - Read layout, then `resolveLocator(layout, step.locator)`:
     - **unique match** -> stop, record `swipesUsed`.
     - **ambiguous** -> fail `LOCATOR_AMBIGUOUS` immediately.
     - **not found** -> if swipes remain: resolve `step.container` (missing ->
       fail `LOCATOR_NOT_FOUND`), swipe the container's bounds in `direction`
       via the shared swipe geometry, wait for layout stability with
       `IdleWaiter`, increment `swipesUsed`; otherwise fail
       `SCROLL_TARGET_NOT_FOUND`.
   - If the target resolves on the first read (0 swipes), stop without swiping.
3. Continue with the existing tail: check process pid, check `after` Activity,
   evaluate optional `expect`.

Reuses `ActionExecutor` swipe geometry (`swipePoints`) and `IdleWaiter`; no new
wait mechanism. The idle wait after each swipe uses the same `idle` config
budget already threaded through `StepRunner`.

## Failure and Report

- `src/domain/failure.ts`: add `SCROLL_TARGET_NOT_FOUND` with exit code `1`.
- `src/domain/report.ts`: add `"scrollTo"` to `StepReportSchema.action`; add an
  optional `scroll` field `{ swipesUsed: number, maxSwipes: number }` recording
  the actual scroll effort.

## Recorder (`RecorderService` + `RecorderPrompt`)

Live bounded-scroll recording:

1. The action list gains `scrollTo`.
2. On selection, list currently visible scrollable elements
   (`scrollable === true` with a deterministic locator) for the user to pick the
   `container`; then prompt for `direction`.
3. Enter a bounded scroll loop: each round lists the currently visible
   deterministic targets and prompts "select target / scroll again". "Scroll
   again" performs one real swipe on the container, waits for stability, and
   re-reads the layout (accumulating `swipesUsed`, capped for safety). Selecting
   the target ends the loop.
4. Record the draft: `target` locator, `container` locator, `direction`,
   `distancePercent`/`durationMs` (from the existing swipe options prompt), and
   `maxSwipes = swipesUsed + 5` (drift margin, bounded by the schema max of 30).

New prompt capabilities: select a scroll container (reuse `selectTarget` over
scrollable elements) and a scroll-loop decision (`scrollMore` vs `selectTarget`).
Direction and swipe parameters reuse the existing `selectSwipeDirection` and
`swipeOptions` prompts. Only a completed selection writes the step; cancelling or
exhausting the loop writes no partial step.

## Tests

- Schema: `journey`, `report`, `failure` accept/emit `scrollTo` and the new
  failure code.
- `StepRunner` scrollTo branch: target already visible (0 swipes), found after N
  swipes, exhausted bound (`SCROLL_TARGET_NOT_FOUND`), ambiguous target
  (`LOCATOR_AMBIGUOUS`), missing container (`LOCATOR_NOT_FOUND`).
- Recorder scrollTo interaction: container selection, live scroll loop, target
  selection, `maxSwipes` derived from swipes used, cancel writes nothing.
- Layout fixtures include a `scrollable` container and off-screen-then-visible
  target across successive reads.

## Documentation

- Add a `scrollTo` example to `docs/examples` journeys.
- Update `AGENTS.md` action notes: adding an action crosses `JourneyStepSchema`,
  recorder prompt/preparation, `ActionExecutor`, step/report schemas, and tests.

## Impact

Touches `journey.ts`, `report.ts`, `failure.ts`, `step-runner.ts`,
`action-executor.ts` (or a small scroll helper), `recorder-service.ts`, the
`recorder-prompt` port and its Inquirer adapter, plus tests and docs. The
determinism contract is preserved: bounded search, explicit failure when not
found, no conditional branching.
