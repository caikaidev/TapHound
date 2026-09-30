# TapHound Journey Schema v2

TapHound Journey is an independent, self-developed, strictly validated JSON protocol. The default config file is `.taphound/config.json`. It does not reuse, invoke, or stay compatible with the official Android CLI Journey. Unknown fields, empty step lists, non-v2 documents, and natural-language steps are all rejected.

## Top-Level Structure

```json
{
  "version": 2,
  "name": "Search flow",
  "devices": [{ "role": "default" }],
  "steps": []
}
```

- `version`: currently fixed at `2`.
- `name`: a non-empty Journey name.
- `devices`: at least one device role declaration. Multi-device Journeys declare
  several roles and bind every step to one of them; single-device Journeys
  declare exactly one role (conventionally `default`) and may omit per-step
  bindings.
- `steps`: at least one step, executed serially in array order, stopping after the first failure.

## Device Roles

Each entry in `devices` carries a `role` (lowercase identifier, unique across
the Journey) and an optional human-readable `description`. When more than one
role is declared, every step MUST set `device` to a declared role; a step that
references an undeclared role, or a declared role no step uses, is rejected.
With a single declared role, `device` may be omitted and defaults to that role.

At replay time each role is mapped to a concrete device serial, for example
`--device sender=emulator-5554 --device receiver=emulator-5556`. All devices
run the same configured package. Multi-device replay executes steps strictly in
Journey order on one timeline.

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

The candidate set is fixed by the first field that has any match. Once that
field narrows the set to a single element, resolution ends immediately and
subsequent fields are **not** validated. Concretely, when `resourceId` already
matches exactly one element, `text` and `contentDescription` are never
examined, so a Locator such as `{ "resourceId": "submit_button", "text": "Send" }`
is equivalent to a bare `{ "resourceId": "submit_button" }` — the `text` field
is silently ignored rather than asserted. The same short-circuit applies when
`text` narrows the set to one element before `contentDescription` is reached.

To assert an element's text content, use a text-only Locator (a Locator whose
only identity field is `text`), or an `expect` element Locator that omits
`resourceId`. The Locator engine drives both Action resolution and `expect`
element resolution, so a multi-field Locator that already resolves uniquely
through `resourceId` will not also assert `text` in either context.

Counter-example — the following Locator **cannot** assert that the button label
is `Send`, because `resourceId` already resolves uniquely and resolution stops
before `text` is examined:

```json
{
  "resourceId": "submit_button",
  "text": "Send"
}
```

If the element's `text` later changes to `Cancel`, replay still resolves the
same `submit_button` and passes. Use a text-only Locator, or an `expect`
element Locator, to verify the label.

When identity fields still match repeated elements, a Locator can add a stable ancestor scope and/or zero-based ordinal:

```json
{
  "text": "Item",
  "index": 1,
  "within": { "resourceId": "results_list" }
}
```

`within` resolves first and limits matching to that element's descendants. `index` is then applied to the remaining candidates in Layout traversal order, after every supplied identity field has narrowed the set. The Recorder and `generation manual` prefer a unique identity, then a stable ancestor scope, and use `index` when identical candidates remain. During Replay, a target Action whose Locator is only absent polls fresh Layout snapshots at 100 ms intervals up to `idle.timeoutMs`; this covers controls rendered shortly after Activity readiness. An unresolved scope, a missing identity match, or an out-of-range index then returns `LOCATOR_NOT_FOUND`. Multiple matches without an index return `LOCATOR_AMBIGUOUS` immediately, and indexed semantic-evidence drift also fails immediately. TapHound never guesses a target.

A `click` or `longClick` acts on the nearest element, starting with the match itself, that has the `clickable` or `longClickable` capability; a `swipe` needs a `scrollable` match with bounds. The touch lands on the matched element's own center (or on the capable element's center when the match lies outside it), so a label inside a clickable row opens that row even when another control covers the row's center. A capable element that is disabled fails the step instead of being skipped. Generation, the Replay of a generated Journey, and External Flow steps apply these rules and fail with `ACTION_FAILED` when no capable element handles the action (Generation rejects such a proposal with `ACTION_UNSUPPORTED`). A recorded Journey's Replay taps the match's center without the capability check, because the Recorder only offers targets that already have it.

Newly recorded or generated indexed steps may also contain Core-owned
`evidence` with a versioned `semanticSha256`. The digest excludes coordinates,
window/parser IDs, focus, and other transient state. Replay recomputes it for
the element selected by `index` and returns `LOCATOR_NOT_FOUND` before mutation
when represented semantic content changed; annotated fallback cannot bypass
that mismatch. The field is optional; steps without `evidence` keep their
existing ordinal behavior. Authors and Agents should not calculate it
themselves.

## Action

- `click`: targets a `locator` or a semantic `anchor`, performs an ADB tap.
- `longClick`: targets a `locator` or a semantic `anchor`, accepts a positive
  integer `durationMs`, default 800.
- `touchPolicy` (optional, `click` and `longClick` only): the single value
  `"element"` touches the located element itself when neither it nor any
  ancestor reports `clickable` (`longClickable` for `longClick`), as with
  RecyclerView item-touch listeners and WebView DOM nodes. The touch point is
  the center of the element's bounds clipped to every ancestor's bounds and
  to the display (WebView nodes often report boxes that overflow their
  WebView); an empty intersection or a disabled element fails with
  `ACTION_FAILED`. The step requires a `locator` (no `anchor`, no annotated
  `fallback`) and must prove its effect with an `element` or `activity`
  `expect`, or with `activity.after` different from `activity.before`.
  Replay (both policies) fails with `ACTION_FAILED` before touching when the
  `expect` already holds on the pre-action layout. Generation additionally
  rejects the proposal with `ACTION_UNSUPPORTED` when the target already has
  a capable ancestor and with `EXPECT_UNSUPPORTED` when its expectation
  already holds; proposals must carry the `expect`, because they learn the
  after Activity only by executing. Without `touchPolicy`, a target with no
  capable ancestor keeps failing closed.
- `inputText`: requires non-empty `text`, typed into the current focus. When an
  `anchor` is supplied, Core resolves it first and taps the anchor point to
  focus the field before typing; an anchor without bounds fails with
  `ANCHOR_NOT_FOUND`.
- `direction` (`swipe` and `scrollTo`) is the finger direction: `up` drags
  from the bottom toward the top of the element and reveals content below,
  `down` reveals content above, `left` reveals content to the right, and
  `right` reveals content to the left.
- `swipe`: targets a `locator` or a semantic `anchor`, plus `direction`;
  `distancePercent` is in `(0, 1]`, default 0.6; `durationMs` default 300. The
  Recorder only shows elements that Android CLI marks as scrollable and that
  provide bounds; a hand-written Journey that only locates an element without
  bounds will terminate with `ACTION_FAILED` and will not guess a swipe region.
- `scrollTo`: targets a `locator` or a semantic `anchor`, plus a scroll
  container `container` and `direction`; `maxSwipes` ranges from 1 to 30,
  default 20; `distancePercent` and `durationMs` default to 0.6 and 300
  respectively. Replay deterministically resolves the target (resolving an
  `anchor` to its element bounds) before and after each swipe, stopping once the
  target appears uniquely, without clicking the target; exceeding the limit
  returns `SCROLL_TARGET_NOT_FOUND`. When the container subtree is unchanged
  after 2 consecutive swipes, the container is at its edge in that
  direction: the step stops early with `SCROLL_TARGET_NOT_FOUND` and a
  message naming the direction instead of spending the rest of
  `maxSwipes`. The container must be unique and provide
  bounds; annotated fallback is not supported.
- `back`: performs the ADB BACK keyevent.
- `wait`: performs only Layout stability detection, with no fixed sleep. A
  conditional wait adds `until: { "element": <locator> }` together with a
  positive `timeoutMs`; Replay then polls the Layout until the locator resolves
  uniquely (matching `expect` element semantics, enabled state not required)
  and fails with `WAIT_TIMEOUT` when the element does not appear in time. The
  two fields must be provided together. This is the cross-device
  synchronization primitive, e.g. waiting on the receiver device for a message
  the sender device just sent. An optional `markerId` declares the start of an
  explicit Logcat observation window. It is timestamped after the wait's
  before-Activity/process checks. Marker IDs must be
  unique; Logcat expectations may reference only a marker declared in this or
  an earlier wait step.
- `bridge`: executes a cross-application flow. Core clicks the `triggerLocator`,
  detects that the foreground escaped the target package, optionally executes
  deterministic `externalSteps` (or resolves a named `flow`) inside the escaped
  package, waits for the foreground to return, and captures the post-return
  snapshot. Requires `scenario`, `description`, `triggerLocator`, and
  `returnTimeoutMs`. When `flow` or `externalSteps` is present the committed step
  carries `replayMode: "auto"`; otherwise `replayMode: "manual"`. See
  [Cross-Application Bridge](#cross-application-bridge) below.

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

## Semantic Anchor Targeting

`click`, `longClick`, `swipe`, `scrollTo`, and `inputText` steps may express
their target with a semantic Knowledge `anchor` (an id from
`.taphound/knowledge/anchors/`) instead of, or alongside, `locator`. Replay
resolves the anchor against the fresh layout first using alias-free element
locator identity (window and Activity identities fail closed); when the anchor
does not resolve and the step also carries a `locator`, that locator is used as
an explicit fallback and the report records
`anchor: { status: "locatorFallback" }`. An anchor-only step that fails resolves
with `ANCHOR_NOT_FOUND` (or `ANCHOR_AMBIGUOUS` when more than one element
matches); a step that targets an anchor while verify has no anchor resolver
configured also fails closed.

- `click`, `longClick`, and `swipe` resolve the anchor to a point (and bounds)
  before executing the mutation; `swipe` still requires bounds.
- `scrollTo` resolves the anchor target to its element bounds before swiping,
  stopping once it appears uniquely. An anchor-only scroll target that never
  appears resolves with `SCROLL_TARGET_NOT_FOUND` after `maxSwipes`; an
  ambiguous anchor returns `ANCHOR_AMBIGUOUS`.
- `inputText` resolves the anchor and taps its point to focus the field before
  typing; an anchor element without bounds fails with `ANCHOR_NOT_FOUND`.

`anchor` is not allowed on `back`, `wait`, or `bridge` steps.

## Replay Mode

Each step may carry an optional `replayMode` field:

- `"auto"` (default when omitted): Core executes the action deterministically
  during replay. All non-bridge steps use this mode, and bridge steps that carry
  `flow` or `externalSteps` also use `"auto"` so the external portion is replayed
  without a human operator.
- `"manual"`: the step is committed with `replayMode: "manual"`. During replay,
  Core clicks the trigger, then a human operator completes the external-app
  portion and the operator confirms return. Bridge steps without `flow` or
  `externalSteps` use this mode.

Steps without `replayMode` are treated as `"auto"`. The field exists so bridge
steps can opt into operator-driven replay.

## Cross-Application Bridge

The `bridge` action lets Core own the trigger click and the return detection for
flows that leave the target package — for example opening the system camera,
image picker, or file picker. A bridge step can run in two replay modes:

- **Manual** (`replayMode: "manual"`): no `flow` or `externalSteps`. A human
  operator completes the external action during replay.
- **Auto** (`replayMode: "auto"`): carries `flow` (a named External Flow bound
  at `generation start`) or inline `externalSteps`. Core replays the external
  steps deterministically inside the escaped package with no operator.

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
- `returnTimeoutMs`: positive integer. Total budget Core waits for the
  foreground to return to the target package after the trigger click. When
  `externalSteps` or `flow` is present, this budget covers escape detection,
  external-step execution, and return wait combined.
- `escapeTimeoutMs`: optional positive integer (default `3000`). Maximum time
  Core waits for the foreground to leave the target package after the trigger
  click before failing with `BRIDGE_NO_ESCAPE`.
- `flow`: optional name of a bound External Flow (e.g.,
  `camera/photo-capture`). When present, Core resolves the flow's steps from
  the session binding and stamps them into the committed step's
  `externalSteps`. Mutually exclusive with `externalSteps`.
- `externalSteps`: optional array of deterministic steps to execute inside the
  escaped package. Populated by Core from the resolved `flow`, or written
  inline by the Recorder. Mutually exclusive with `flow`. See
  [External Steps](#external-steps) below.
- `replayMode`: `"auto"` when `flow` or `externalSteps` is present, otherwise
  `"manual"`. Committed automatically by Core; Agents should not set it
  manually.
- `escapedPackageName`: filled by Core during generation. Records the package
  that the foreground escaped to. Required when `flow` or `externalSteps` is
  present. Present in committed Journey steps but not in proposals. Replay
  fails with `EXTERNAL_PACKAGE_MISMATCH` when the trigger escapes to a
  different package than the one recorded.

### External Steps

An `externalSteps` entry is a deterministic step executed inside the escaped
package. Each entry supports the same action set as a regular Journey step
(`click`, `longClick`, `inputText`, `swipe`, `scrollTo`, `back`, `wait`) plus
an optional `expectedActivity` checkpoint:

```json
{
  "action": "click",
  "locator": { "resourceId": "com.android.camera2:id/shutter_button" },
  "expectedActivity": "com.android.camera2.CameraActivity"
}
```

External-step locators must use `resourceId` (v1 restricts external steps to
XML-only resource IDs for deterministic replay; Compose UI is not supported).
Annotated fallback is not available for external steps. A locator that does not
resolve uniquely fails with `EXTERNAL_LOCATOR_STRICTNESS`.

### External Flows

An External Flow is a reusable, named sequence of `externalSteps` stored as a
JSON document. Built-in flows ship under `assets/external-flows/`; project
flows live under `.taphound/flows/external/`. List them with:

```bash
taphound journey list-flows --project . --include-external --json
```

Bind one or more flows to a generation session at start time:

```bash
taphound generation start --external-flow camera/photo-capture ...
```

Core hashes each bound flow into the session. When `generation bridge --flow
<name>` is called, Core resolves the flow by name and session hash, stamps its
steps into the committed Journey step as `externalSteps`, and commits with
`replayMode: "auto"`. If the flow file changed since binding, the step fails
with `EXTERNAL_FLOW_STALE`. If the flow name is not bound to the session, the
step fails with `EXTERNAL_FLOW_NOT_FOUND`.

To generate a project-level camera flow that matches your connected device,
run `taphound align camera`. It probes the device's default camera app and
writes `.taphound/flows/external/camera/photo-capture.json` with the correct
package, stable capture/review Activities, shutter button resourceId, and
confirm button resourceId. It generates a shutter-only flow only when the
camera demonstrably leaves the foreground after capture; if the camera remains
foreground without a deterministic confirm locator, alignment fails instead
of publishing an incomplete flow. See `taphound align camera --help` for
options.

### Generation Flow

1. Core observes the current layout and builds a bridge proposal bound to the
   session revision and snapshot.
2. Risk confirmation is required (like `generation manual`). The Agent calls
   `generation bridge` and a human approves the challenge.
3. Core clicks the `triggerLocator`, then polls the foreground for up to
   `escapeTimeoutMs` (default 3 seconds). If the foreground does not leave the
   target package, the step fails with `BRIDGE_NO_ESCAPE`.
4. For built-in scenarios, Core validates the escaped package against the known
   system package list. A mismatch fails with `SCENARIO_PACKAGE_MISMATCH`.
   `custom` scenarios skip this check.
5. If `--flow` was supplied, Core resolves the External Flow from the session
   binding. If `externalSteps` would be empty (e.g., the flow has no steps),
   Core still proceeds to return detection. Each external step is executed
   deterministically inside the escaped package; a failure fails with
   `EXTERNAL_STEP_FAILED`, `EXTERNAL_PACKAGE_MISMATCH`,
   `EXTERNAL_ACTIVITY_MISMATCH`, or `EXTERNAL_LOCATOR_STRICTNESS`.
6. Core polls the foreground for up to `returnTimeoutMs`. If the foreground does
   not return to the target package, the step fails with `BRIDGE_NOT_RETURNED`.
7. After return, Core waits for layout stability and captures the post-return
   snapshot. The committed step carries `replayMode` (`"auto"` when
   `externalSteps` is non-empty, else `"manual"`), `escapedPackageName`, and the
   stamped `externalSteps`.

### Replay Flow

During replay, `StepRunner` executes the bridge step:

1. Resolves `triggerLocator` (must be clickable).
2. Clicks the trigger via `actionExecutor.execute`.
3. Polls for foreground escape (`escapeTimeoutMs` or 3 seconds). No escape →
   `BRIDGE_NO_ESCAPE`.
4. **Auto mode only**: executes each `externalSteps` entry in order against the
   escaped package. Locator resolution uses `resourceId` only (no annotated
   fallback); a mismatch fails with `LOCATOR_NOT_FOUND`. An `expectedActivity`
   checkpoint that does not match fails with `EXTERNAL_ACTIVITY_MISMATCH`.
5. Polls for foreground return (`returnTimeoutMs`). Timeout →
   `BRIDGE_NOT_RETURNED`.
6. Waits for layout stability and continues to the next step.

In **manual mode** (no `externalSteps`), the human operator is responsible for
completing the external-app action (taking a photo, picking an image, etc.)
before the foreground returns. In **auto mode**, no operator is needed; Core
replays the external steps deterministically. A non-interactive `finalize`
(meaning no TTY) rejects any Journey containing a `replayMode: "manual"` step
with `MANUAL_STEP_REQUIRED`; auto-mode bridge steps do not trigger this guard.

### CLI

```bash
# Manual bridge (human completes external action during replay)
taphound generation bridge \
  --project . \
  --session <id> \
  --scenario photoCapture \
  --trigger-locator '{"resourceId":"com.example.app:id/camera_button"}' \
  --return-timeout-ms 60000 \
  --json

# Auto bridge (Core replays a bound External Flow deterministically)
taphound generation bridge \
  --project . \
  --session <id> \
  --scenario photoCapture \
  --trigger-locator '{"resourceId":"com.example.app:id/camera_button"}' \
  --flow camera/photo-capture \
  --return-timeout-ms 60000 \
  --escape-timeout-ms 3000 \
  --json
```

For full examples see:
- [`examples/bridge-camera.journey.json`](../examples/bridge-camera.journey.json) (manual)
- [`examples/bridge-camera-with-flow.journey.json`](../examples/bridge-camera-with-flow.journey.json) (auto, named flow)
- [`examples/bridge-pick-image.journey.json`](../examples/bridge-pick-image.journey.json) (auto, inline externalSteps)
- [`examples/bridge-pick-file.journey.json`](../examples/bridge-pick-file.journey.json) (manual)

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
  "enabled": true,
  "timeoutMs": 3000
}
```

Optional predicates assert the resolved element's state. `enabled` compares the
element's `enabled` flag exactly; `clickable: true` requires the element to be
clickable, `clickable: false` requires it to be non-clickable (an element
without a `clickable` attribute counts as non-clickable). Predicates are
evaluated on every poll, so an expectation such as `enabled: true` also acts
as a wait-until-enabled with the declared `timeoutMs`.

`absent: true` inverts the expectation: it passes when the locator matches
zero elements and fails when the element (or an ambiguous multi-match) is
still present at timeout. Ambiguity is never treated as absence. `absent`
cannot be combined with `enabled` or `clickable` predicates. An absent
expectation passes on the first poll that observes zero matches, so place it
on a step after the state has settled; it does not wait for a still-present
element to disappear before starting to evaluate.

```json
{
  "type": "element",
  "locator": { "resourceId": "keyboard_container" },
  "absent": true,
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

Logcat is matched only within this step's `[T0, T1]` window. `match` may be
`literal` or `regex`; the regex must be valid. Collection starts from at most
one retained device-buffer line (`logcat -T 1`) and is scoped to the App PID
set before a generation action mutates the device. A retained matching line is
sufficient for this positive, first-match expectation even if other scoped
lines rolled out of the bounded buffer. If no match remains and scoped evidence
was dropped, evaluation fails closed and reports `droppedLines`,
`droppedBytes`, and `lastDroppedAtMs`. For a full executable example see
[`examples/search.journey.json`](../examples/search.journey.json).

### `logcatEvent`

```json
{
  "type": "logcatEvent",
  "tag": "SearchViewModel",
  "event": "resultsReady",
  "fields": { "query": "hello" },
  "correlation": { "key": "requestId", "value": "fixed-test-id" },
  "unique": true,
  "window": { "from": "marker", "markerId": "search-start" },
  "timeoutMs": 3000
}
```

The app must write a threadtime Logcat message containing a JSON object such
as `{"event":"resultsReady","fields":{"query":"hello","requestId":"fixed-test-id"}}`.
The tag, event, declared fields, and correlation value match exactly; fields
are scalar strings, numbers, or booleans. Unparsed and out-of-PID lines never
match. `unique` must be `true`, with exactly one matching event across the
declared window. TapHound watches until the timeout to detect duplicates, even
if the first event arrives early. Zero matches fail with
`EXPECT_LOGCAT_FAILED`; multiple matches fail with
`EXPECT_LOGCAT_AMBIGUOUS`. Buffer loss inside the declared window remains an
incomplete-evidence failure because uniqueness can no longer be proven.
Legacy `logcat` remains positive first-match.

`window.from` is `stepStart` by default, `runStart` for the current Replay,
or `marker` for an explicit `wait.markerId`. Marker windows can cross steps.
Every marker reference must point to this or a preceding wait step. Generation
proposals only accept `stepStart`, because their session does not bind a
Replay run start or Journey markers. Recorder does not invent business
expectations. Raw values remain in Logcat artifacts, not the event summary
in the report; avoid using sensitive fields in protocol inputs.

### Event Capture and Replay Binding

Only a uniquely matched step `logcatEvent` may capture a value. Declare
`"capture": {"name":"requestId","field":"requestId","valueType":"identifier"}`
in its expectation. `field` selects one key under the event's JSON `fields`;
alternatively `"group":"correlation"` selects the declared correlation key.
Choose exactly one. Types are `identifier` (ASCII letters, digits, `_`, `-`,
1–64 characters), `string` (1–128 printable characters), or `integer`
(a safe JSON integer, rendered as decimal text). At most 16 distinct captures
are allowed per Journey. An invalid, missing or duplicated capture fails
closed with `EXPECT_LOGCAT_FAILED`.

Later steps on the same device may use an **exact** `${requestId}` value in
`inputText.text`, a direct step `locator.text`, or
`logcatEvent.correlation.value`. No partial interpolation, expressions, other
locator identities, nested locators, checkpoints, bridge/external actions, or
generation proposal references are permitted. Unknown, forward, and
cross-device names fail schema validation or Replay before mutation.
Bindings stay in this Replay's memory; an independent `verify` or generation
`finalize` re-extracts them from its own matched events. Reports store only
the capture name/type/length, source step and window, and matched line SHA-256.
They retain the original `${name}` locator request, never the resolved value.
Raw values may still occur in the device's Logcat artifact; treat those
artifacts as sensitive.

### Expect Semantics

Each `expect` type evaluates against live device state with strict equality
semantics; TapHound never applies fuzzy, prefix, or case-insensitive matching.

- **`activity`**: polls `currentActivity` for the configured package and
  compares the result against `value` with exact full-string equality. No
  prefix, suffix, or substring matching is applied. A shorter alias or a
  trailing fragment never matches the fully qualified class name.
- **`element`**: resolves `locator` through the same Locator engine used for
  Actions, with `requireEnabled` disabled, and requires the result to be
  unique. Both an ambiguous match (more than one candidate without `index`)
  and no element matching surface as `EXPECT_ELEMENT_FAILED`; the Locator
  engine's internal `LOCATOR_AMBIGUOUS`/`LOCATOR_NOT_FOUND` is reduced to a
  boolean by `expect` and is not surfaced separately. The Locator
  short-circuit rules above apply, so a multi-field Locator that already
  resolves uniquely through `resourceId` will not also assert `text`.
  Optional `enabled`/`clickable` predicates compare the resolved element's
  state exactly on every poll (a missing `clickable` attribute counts as
  `false`); a predicate that never matches within `timeoutMs` fails with
  `EXPECT_ELEMENT_FAILED` and the failure message reports the expected and
  actual state. `absent: true` passes only on zero matches and fails closed
  on found, ambiguous, or evidence-mismatch resolutions.
- **`logcat`**: `tag` is compared with exact full-string equality, preserving
  the full logger prefix. For example, a `tag` of `IM.SendMailActivity`
  matches only logcat lines whose tag is exactly `IM.SendMailActivity`; a
  partial `SendMailActivity` value does not match. `level` is compared
  exactly (e.g. `I` matches only `I`, not `INFO`). When `match` is
  `literal`, `pattern` is matched as a substring of the logcat message; when
  `match` is `regex`, `pattern` is compiled into a `RegExp` and matched
  partially (`.test`). Matching is restricted to logcat lines emitted within
  this step's `[T0, T1]` window.

## Idempotency and Repeat Runs

TapHound captures no runtime variables during Replay: there is no extracted
temp file, no captured dynamic ID, and no substitution into subsequent steps.
Each Journey must therefore target stable, unique business identifiers chosen
by the author (for example `resourceId: "order_1712345678"` rather than "the
order I just created"). When the business key is genuinely dynamic and cannot
be pinned in advance, the Journey cannot deterministically replay that edge
and the author must either redesign the test fixture or delegate the side
effect to an external Workflow.

For list-shaped targets where replay may create additional rows on each run,
prefer a `text`-only Locator with a stable unique label, or scope with
`within` and fall back to `index: 0` only when the list genuinely contains
identical candidates. `index: 0` selects the first row in Layout traversal
order regardless of how many rows accumulated, which keeps repeat runs stable
without pinning a specific ordinal that later runs may invalidate.

TapHound does not clean up business data. Every committed step's Action
produces real side effects on the device and on the backing service. Repeat
runs of the same Journey accumulate those side effects (extra rows, sent
messages, captured photos). Cleanup is the Journey author's or the external
Workflow's responsibility, not Core's; TapHound only records, replays, and
verifies the deterministic UI path.

## Idle Tuning

Each Replay step waits for the screen to stabilize before resolving the next
Locator and evaluating expectations. The `idle` block in
`.taphound/config.json` controls that wait (full field reference and
per-profile recommendations: [config-schema.md](config-schema.md)):

```json
"idle": {
  "strategy": "hybrid",
  "pollIntervalMs": 300,
  "stablePolls": 3,
  "timeoutMs": 15000
}
```

`pollIntervalMs`, `stablePolls`, and `timeoutMs` are required. `strategy`
defaults to `"hybrid"`.

### Strategy Selection

| Strategy | When to use | Backend | Behavior |
|----------|-------------|---------|----------|
| `hybrid` (default) | General purpose; most apps | Starts on `frameStats` when `run.packageName` is known, otherwise on `uiautomator`; falls back to `uiautomator` after 2 consecutive frame-change polls | Fast frame-silence detection with a structural fallback for continuous animation |
| `layoutDiff` | Continuous-animation screens (loading spinners, animated backgrounds) | `uiautomator` from the start | Skips frame analysis; compares layout structure directly |
| `frameStats` | Frame silence is sufficient and the screen has no structural changes | `gfxFrameStats` only | Pure frame timing; no structural fallback. Not recommended as a standalone strategy for most apps |
| `structural` | Pure structural comparison; no frame analysis | `uiautomator` only | Compares the layout tree; ignores frame timing |

Implementation details that affect tuning:

- `hybrid` with a known `run.packageName` starts on `frameStats`; without a
  `packageName` it starts on `uiautomator` (structural).
- `hybrid` falls back to structural after `EARLY_BAIL_FRAME_CHANGES = 2`
  consecutive frame-change polls.
- When frame stats stay silent for `stablePolls` polls, `hybrid` confirms
  structurally with one unchanged diff across at least two structural
  captures taken during the same wait, instead of `stablePolls` more polls.
  Frame-stat polls always use the device's `dumpsys gfxinfo`, even when the
  UI backend (Appium) samples the structural phase itself.
- After fallback, `hybrid` requires
  `max(POST_FALLBACK_MIN_STABLE = 2, stablePolls - 1)` consecutive stable polls.
  This is the anti-jitter floor.
- Non-hybrid strategies on the structural backend require
  `max(2, stablePolls)` consecutive empty diffs.
- `frameStats` as a standalone strategy (not `hybrid`) has no structural
  fallback.
- `pollIntervalMs` runs from the start of one poll to the start of the next,
  so a slow structural capture shortens the following sleep instead of adding
  to it. A stable step still costs about `(polls - 1) × pollIntervalMs`, which
  is why a large interval (for example `1000`) dominates step time.
- Idle proves only that the tree stopped changing. A full-screen spinner is a
  static tree, so a post-action capture can show a loading state; bind the
  settled screen with an `element` expect on the loaded screen instead of
  raising idle timings.

### `stablePolls` Tradeoff

Lowering `stablePolls` from `3` to `2` removes one confirmation poll per
stable step on the simplest backend, but the actual saving depends on the
strategy and whether `hybrid` falls back:

- **Non-hybrid `structural` / `layoutDiff`:** lowering `3` to `2` saves
  **1 poll per step** (~`pollIntervalMs`, 300 ms at the default). These
  strategies require `max(2, stablePolls)` consecutive empty diffs on the
  structural backend, so the saving is exactly one confirmation poll.
- **`hybrid` without early-bail (the common stable-app path):** saves
  **2 polls per step** (~600 ms at the default). `hybrid` starts on
  `frameStats`, requires `stablePolls` consecutive empty frameStats polls,
  then ALWAYS transitions to the structural backend and requires
  `max(2, stablePolls)` MORE consecutive empty structural polls. So
  `stablePolls: 3` is 3 frameStats + max(2, 3) = 3 structural = 6 polls,
  while `stablePolls: 2` is 2 frameStats + max(2, 2) = 2 structural = 4
  polls. The saving is one fewer frameStats poll AND one fewer structural
  confirmation poll.
- **`hybrid` with early-bail (frame changes detected):** saves **0 polls**.
  After `hybrid` falls back from `frameStats`, it requires
  `max(POST_FALLBACK_MIN_STABLE = 2, stablePolls - 1)` consecutive stable
  polls. Both `stablePolls: 3` (max(2, 2) = 2) and `stablePolls: 2`
  (max(2, 1) = 2) hit the anti-jitter floor, so the structural confirmation
  cost is identical.

Note that `hybrid` always confirms on the structural backend even when
`frameStats` was quiet: it transitions after `stablePolls` consecutive empty
`frameStats` polls and then needs structural confirmation. The total saving
across a Journey scales with the step count on the non-early-bail path.

For apps with no continuous animations, `stablePolls: 2` is safe and
recommended. Apps with continuous animations or slow rendering may require
`stablePolls: 3`.

### `pollIntervalMs`

Each poll is itself a `uiautomator` dump or a `gfxFrameStats` sample; the
interval is the sleep between polls, not the poll duration. For the structural
backend, poll duration dominates (uiautomator dump latency), so reducing
`pollIntervalMs` has limited effect. For `frameStats`, the interval matters
more, since samples are cheaper than full layout dumps.

### Reading `IDLE_TIMEOUT` Failures

`IDLE_TIMEOUT` failures are self-diagnosing: the failure message ends with a
parenthesized tuning recommendation derived from the recorded idle telemetry
(structured fields stay in the step report's `idle` block and the
`layout-diff.json` artifact):

- **Frame activity never settled** under `hybrid`/`frameStats`: continuous
  animation keeps frame stats busy. Switch `idle.strategy` to `layoutDiff`.
- **Layout differences kept appearing** (`lastDiff` non-empty): the screen
  genuinely churns. Raise `idle.timeoutMs` if the churn settles, or switch to
  `layoutDiff` if it animates continuously.
- **UI snapshot captures consumed most of the idle budget**: each poll
  performs its own capture, so a larger `idle.timeoutMs` is required for
  `idle.stablePolls` consecutive polls to fit; raise `ui.snapshotTimeoutMs`
  when individual dumps are slow.
- **No layout change detected but the budget ended**: the wait was structurally
  stable yet never accumulated `idle.stablePolls` consecutive stable polls in
  time. Raise `idle.timeoutMs` or lower `idle.stablePolls`/`pollIntervalMs`.

Follow the recommendation instead of blind-retrying: a timeout caused by
continuous animation never resolves by waiting longer.

## Reusable Flow Composition

Journey v2 remains the only runtime Replay protocol. Reuse is an authoring
layer that resolves strict Flow and Journey Source documents into a complete,
flat Journey v2 before verification.

Reusable Flows live under `.taphound/flows/`:

The first resolved Flow step must start at a stable Activity that cold launch
deterministically reaches. Do not require a transient Splash Activity to remain
foreground. A reusable launch anchor such as `core/launch-home` is a
`wait: Home -> Home` step with an `element` expectation for a unique Home
control, as shown in
[`flow.example.json`](../assets/skills/taphound-journey-generator/templates/flow.example.json).

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
Journey v2.

List reusable prefixes with `taphound journey list-flows --project . --json`.
For AI generation, `generation start --base-flow chat/open-thread` performs a
clean cold-start replay before session creation, binds the Flow resolution and
verification hashes, and lets planning begin at the Flow exit Activity.
