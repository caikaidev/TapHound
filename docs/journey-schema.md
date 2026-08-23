# TapHound Journey Schema v1

TapHound Journey is an independent, self-developed, strictly validated JSON protocol. The default config file is `taphound.config.json`. It does not reuse, invoke, or stay compatible with the official Android CLI Journey. Unknown fields, empty step lists, non-v1 documents, and natural-language steps are all rejected.

## Top-Level Structure

```json
{
  "version": 1,
  "name": "Search flow",
  "steps": []
}
```

- `version`: currently fixed at `1`.
- `name`: a non-empty Journey name.
- `steps`: at least one step, executed serially in array order, stopping after the first failure.

## Activity Checkpoint

Each step must include:

```json
"activity": {
  "before": "com.example.app.MainActivity",
  "after": "com.example.app.SearchActivity"
}
```

`activity.before` is checked before Locator resolution; `activity.after` is checked after the Action succeeds and the Layout is stable. Both must be fully qualified class names. The Recorder reads them directly from the device and writes them automatically; they are structural checks, not business `expect`.

## Locator

Target-type Actions use one or more fields:

```json
{
  "resourceId": "toolbar_search",
  "text": "Search",
  "contentDescription": "Open search"
}
```

The priority is fixed as `resourceId`, `text`, then `contentDescription`. Replay starts from the first field that has matches and uses subsequent fields to disambiguate.

When identity fields still match repeated elements, a Locator can add a stable ancestor scope and/or zero-based ordinal:

```json
{
  "text": "Item",
  "index": 1,
  "within": { "resourceId": "results_list" }
}
```

`within` resolves first and limits matching to that element's descendants. `index` is then applied to the remaining candidates in Layout traversal order, after every supplied identity field has narrowed the set. The Recorder and `generation manual` prefer a unique identity, then a stable ancestor scope, and use `index` when identical candidates remain. An unresolved scope, a missing identity match, or an out-of-range index returns `LOCATOR_NOT_FOUND`; multiple matches without an index return `LOCATOR_AMBIGUOUS`. TapHound never guesses a target.

Newly recorded or generated indexed steps may also contain Core-owned
`evidence` with a versioned `semanticSha256`. The digest excludes coordinates,
window/parser IDs, focus, and other transient state. Replay recomputes it for
the element selected by `index` and returns `LOCATOR_NOT_FOUND` before mutation
when represented semantic content changed; annotated fallback cannot bypass
that mismatch. The field is optional so older Journey v1 files retain their
existing ordinal behavior. Authors and Agents should not calculate it
themselves.

## Action

- `click`: requires `locator`, performs an ADB tap.
- `longClick`: requires `locator`, accepts a positive integer `durationMs`, default 800.
- `inputText`: requires non-empty `text`, typed into the current focus.
- `swipe`: requires `locator`, `direction`; `distancePercent` is in `(0, 1]`, default 0.6; `durationMs` default 300. The Recorder only shows elements that Android CLI marks as scrollable and that provide bounds; a hand-written Journey that only locates an element without bounds will terminate with `ACTION_FAILED` and will not guess a swipe region.
- `scrollTo`: requires a target `locator`, a scroll container `container`, and `direction`; `maxSwipes` ranges from 1 to 30, default 20; `distancePercent` and `durationMs` default to 0.6 and 300 respectively. Replay deterministically resolves the target before and after each swipe, stopping once the target appears uniquely, without clicking the target; exceeding the limit returns `SCROLL_TARGET_NOT_FOUND`. The container must be unique and provide bounds; annotated fallback is not supported.
- `back`: performs the ADB BACK keyevent.
- `wait`: performs only Layout stability detection, with no fixed sleep.
- `bridge`: executes a cross-application flow. Core clicks the `triggerLocator`,
  detects that the foreground escaped the target package, waits for the foreground
  to return, and captures the post-return snapshot. Requires `scenario`,
  `description`, `triggerLocator`, and `returnTimeoutMs`. The committed step always
  carries `replayMode: "manual"`. See [Cross-Application Bridge](#cross-application-bridge)
  below.

Example:

```json
{
  "action": "swipe",
  "locator": { "resourceId": "results" },
  "direction": "up",
  "distancePercent": 0.6,
  "durationMs": 300,
  "activity": {
    "before": "com.example.app.SearchActivity",
    "after": "com.example.app.SearchActivity"
  }
}
```

`scrollTo` example:

```json
{
  "action": "scrollTo",
  "locator": { "text": "Privacy" },
  "container": { "resourceId": "settings_list" },
  "direction": "up",
  "maxSwipes": 12,
  "activity": {
    "before": "com.example.app.SettingsActivity",
    "after": "com.example.app.SettingsActivity"
  }
}
```

For a full example see [`examples/scroll-to.journey.json`](../examples/scroll-to.journey.json).

## Replay Mode

Each step may carry an optional `replayMode` field:

- `"auto"` (default when omitted): Core executes the action deterministically
  during replay. All non-bridge steps use this mode.
- `"manual"`: the step is committed with `replayMode: "manual"`. During replay,
  Core clicks the trigger, then a human operator completes the external-app
  portion and the operator confirms return. Bridge steps always use this mode.

Older Journey v1 files without `replayMode` are treated as `"auto"` for every
step. The field is optional to preserve backward compatibility.

## Cross-Application Bridge

The `bridge` action lets Core own the trigger click and the return detection for
flows that leave the target package — for example opening the system camera,
image picker, or file picker.

### Scenario

```json
{
  "action": "bridge",
  "scenario": "photoCapture",
  "description": "Capture photo via system camera",
  "triggerLocator": { "resourceId": "camera_button" },
  "returnTimeoutMs": 60000,
  "replayMode": "manual",
  "activity": {
    "before": "com.example.app.ProfileActivity",
    "after": "com.example.app.ProfileActivity"
  }
}
```

- `scenario`: one of `photoCapture`, `pickImage`, `pickFile`, or `custom`.
  Built-in scenarios validate the escaped package against a hardcoded list of
  known system packages. `custom` skips package validation and requires an
  explicit `description`.
- `description`: human-readable summary of the cross-app action. Required for
  `custom`; optional for built-in scenarios (a default is provided).
- `triggerLocator`: a standard Locator for the element that initiates the
  cross-app transition (e.g., a camera button). Must resolve to a clickable
  element.
- `returnTimeoutMs`: positive integer. Maximum time Core waits for the
  foreground to return to the target package after the trigger click.
- `replayMode`: always `"manual"` for bridge steps. Committed automatically by
  Core; Agents should not set it manually.
- `escapedPackageName`: filled by Core during generation. Records the package
  that the foreground escaped to. Present in committed Journey steps but not in
  proposals.

### Generation Flow

1. Core observes the current layout and builds a bridge proposal bound to the
   session revision and snapshot.
2. Risk confirmation is required (like `generation manual`). The Agent calls
   `generation bridge` and a human approves the challenge.
3. Core clicks the `triggerLocator`, then polls the foreground for up to 3
   seconds. If the foreground does not leave the target package, the step fails
   with `BRIDGE_NO_ESCAPE`.
4. For built-in scenarios, Core validates the escaped package against the known
   system package list. A mismatch fails with `SCENARIO_PACKAGE_MISMATCH`.
   `custom` scenarios skip this check.
5. Core polls the foreground for up to `returnTimeoutMs`. If the foreground does
   not return to the target package, the step fails with `BRIDGE_NOT_RETURNED`.
6. After return, Core waits for layout stability and captures the post-return
   snapshot. The committed step carries `replayMode: "manual"` and
   `escapedPackageName`.

### Replay Flow

During replay, `StepRunner` executes the bridge step:

1. Resolves `triggerLocator` (must be clickable).
2. Clicks the trigger via `actionExecutor.execute`.
3. Polls for foreground escape (3 seconds). No escape → `BRIDGE_NO_ESCAPE`.
4. Polls for foreground return (`returnTimeoutMs`). Timeout →
   `BRIDGE_NOT_RETURNED`.
5. Waits for layout stability and continues to the next step.

The human operator is responsible for completing the external-app action (taking
a photo, picking an image, etc.) before the foreground returns.

### CLI

```bash
taphound generation bridge \
  --project . \
  --session <id> \
  --scenario photoCapture \
  --trigger-locator '{"resourceId":"com.example.app:id/camera_button"}' \
  --return-timeout-ms 60000 \
  --json
```

For full examples see:
- [`examples/bridge-camera.journey.json`](../examples/bridge-camera.journey.json)
- [`examples/bridge-pick-image.journey.json`](../examples/bridge-pick-image.journey.json)
- [`examples/bridge-pick-file.journey.json`](../examples/bridge-pick-file.journey.json)

## Explicit Annotated Fallback

Only `click` and `longClick` accept annotated-screenshot fallback:

```json
"fallback": {
  "type": "annotatedLabel",
  "label": "#7"
}
```

When the regular Locator fails and an `annotatedLabel` is present, Replay captures a new annotated screenshot and lets Android CLI parse that `#number`. TapHound never selects labels through AI or visual reasoning. Other Actions do not allow fallback.

## Explicit Expect

The Recorder does not auto-generate business assertions. A step may carry one `expect`:

### `activity`

```json
{
  "type": "activity",
  "value": "com.example.app.SearchActivity",
  "timeoutMs": 3000
}
```

### `element`

```json
{
  "type": "element",
  "locator": { "resourceId": "search_input" },
  "timeoutMs": 3000
}
```

### `logcat`

```json
{
  "type": "logcat",
  "tag": "SearchViewModel",
  "level": "I",
  "pattern": "submitted query=hello world",
  "match": "literal",
  "timeoutMs": 3000
}
```

Logcat is matched only within this step's `[T0, T1]` window. `match` may be `literal` or `regex`; the regex must be valid. For a full executable example see [`examples/search.journey.json`](../examples/search.journey.json).

## Reusable Flow Composition

Journey v1 remains the only runtime Replay protocol. Reuse is an authoring
layer that resolves strict Flow and Journey Source documents into a complete,
flat Journey v1 before verification.

Reusable Flows live under `.taphound/flows/`:

The first resolved Flow step must start at a stable Activity that cold launch
deterministically reaches. Do not require a transient Splash Activity to remain
foreground. A reusable launch anchor such as `core/launch-home` is a
`wait: Home -> Home` step with an `element` expectation for a unique Home
control, as shown in
[`flow.example.json`](../assets/skills/taphound-ai-journey/templates/flow.example.json).

```json
{
  "version": 1,
  "kind": "flow",
  "name": "chat/open-thread",
  "includes": ["core/launch-home"],
  "steps": [
    {
      "action": "click",
      "locator": { "resourceId": "test_thread" },
      "activity": {
        "before": "com.example.app.HomeActivity",
        "after": "com.example.app.ChatActivity"
      }
    }
  ]
}
```

Leaf authoring documents live under `.taphound/sources/`:

```json
{
  "version": 1,
  "kind": "journeySource",
  "name": "chat/send-message",
  "includes": ["chat/open-thread"],
  "steps": [
    {
      "action": "wait",
      "activity": {
        "before": "com.example.app.ChatActivity",
        "after": "com.example.app.ChatActivity"
      }
    }
  ]
}
```

Resolve a source explicitly:

```bash
taphound journey resolve \
  --project . \
  --source .taphound/sources/chat/send-message.json \
  --output .taphound/journeys/chat/send-message.json \
  --json
```

Resolution expands dependencies depth-first in declared order, rejects cycles,
duplicate or diamond inclusion, missing Flows, unsafe paths, and Activity
boundary gaps, then writes both the flat Journey and a `.resolve.json`
dependency/hash manifest. `verify` continues to accept only the resolved
Journey v1.

List reusable prefixes with `taphound journey list-flows --project . --json`.
For AI generation, `generation start --base-flow chat/open-thread` performs a
clean cold-start replay before session creation, binds the Flow resolution and
verification hashes, and lets planning begin at the Flow exit Activity.
