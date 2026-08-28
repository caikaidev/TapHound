# Generate Next Proposed Step

You are generating the next proposed step in a TapHound journey. You have:

- **Goal**: the user's natural-language description of the test scenario.
- **Project Context Index**: the compact module catalog.
- **Selected module summaries**: only the shards cryptographically bound at
  `generation start`, containing known Activities, screens, elements,
  transitions, and Logcat candidates.
- **Snapshot**: the current device state from `generation observe --json`,
  including the `layout` array (all visible UI elements with their
  properties) and the current `activity`.
- **Completed steps**: a list of steps that have already succeeded in this
  session.
- **Base Flow**: optional bound reusable prefix metadata. Its exit Activity is
  the generation starting checkpoint; its navigation is already complete.

## Layout Structure

`snapshot.layout` is an array of root `LayoutElement` objects, not a flat
element list. Every element has recursive `children`; traverse the complete
tree when finding a target. `LayoutElement.id` is an internal parser identity
and is never a Locator field. Use only `resourceId`, `text`, and
`contentDescription`, in that priority order, plus `within` and `index` when
needed.

## Your Task

Determine the next single action that advances the Goal. Output one proposed
step JSON object (without the `binding` field — the caller adds binding from
the observe result).

## How to Decide

1. **Identify what remains**: Compare the Goal against completed steps. What
   is the next logical action? Do not regenerate navigation already supplied by
   the bound Base Flow.

2. **Verify Context coverage**: Find `snapshot.activity` in the selected
   module summaries. If no selected shard covers it, return
   `{"error":"context coverage missing","activity":"..."}`. Do not read or
   add an unbound shard after session start.

3. **Verify hierarchy completeness**: Inspect `snapshot.windowHierarchy`
   when present. If its status is `incomplete`, do not propose any action,
   including Back or Wait. Return
   `{"error":"window hierarchy incomplete","diagnostics":[...],"recovery":[...]}`
   using the snapshot's exact diagnostics and recovery values. If the status
   is `unknown`, continue only with elements already present in
   `snapshot.layout`; never infer missing PopupWindow, dialog, or overlay
   controls from the screenshot.

4. **Find the target element**: Look through `snapshot.layout` for an element
   that matches the next intended action:
   - Match by `resourceId` first (highest priority).
   - If no `resourceId` match, match by `text`.
   - If no `text` match, match by `contentDescription`.
   - If identity fields still match multiple live elements, first add `within`
     with a deterministic ancestor Locator when available. Add zero-based
     `index` only when identical candidates remain in that scope.
   - Do not add Locator `evidence`. Core derives versioned semantic evidence
     from the bound snapshot when it persists a resolvable indexed step.
   - The element must be `enabled: true`.
   - For `click`: prefer `clickable: true` elements.
   - For `inputText`: the target should be `focusable: true` (an EditText).
     Do not include a `locator` for `inputText` — the Core uses the focused
     element.
   - For `swipe`: the target should be `scrollable: true` with `bounds`.
   - For `scrollTo`: specify both `locator` (target) and `container`
     (scrollable parent).

5. **Detect cross-app transitions**: Before proposing a `click` on a trigger
   that opens an external app, check whether the element clearly initiates a
   cross-app transition (e.g., a camera button, "choose from gallery", "attach
   file", share sheet). If so, return a `bridge` signal (see **Cross-app
   flows** in Rules) instead of a `click`. If an External Flow was bound at
   `generation start --external-flow` and its `escapedPackageName` matches the
   scenario, include `"flow": "<name>"` in the bridge signal so the caller can
   pass `--flow` to `generation bridge` for deterministic auto replay.

6. **Determine activity.before**: This is `snapshot.activity` (the current
   Activity class). The proposed step only includes `activity.before` —
   never `activity.after`. The Core determines the after-Activity from
   live device observation after executing the action.

7. **Add expect (optional)**: Only if there is a deterministic, verifiable
   outcome:
   - `element`: a specific element should appear after the action (e.g., a
     search input field appears after clicking "open search").
   - `logcat`: a specific log line should be emitted (e.g., the source code
     shows `Log.i("SearchViewModel", "submitted query=" + query)` — use
     `tag: "SearchViewModel"`, `pattern: "submitted query=..."`,
     `match: "literal"`).
   - `activity`: a specific Activity should be foregrounded.
   - Do not add expectations you cannot verify from source code or Context.
   - Do not invent log patterns that don't exist in the source.

## Output Format

A single JSON object matching one of the step types in
`schemas/proposed-step-envelope.json` `$defs/ProposedStep`, but **without**
the `binding` field. The caller wraps it with binding and snapshot.

Example (click):
```json
{
  "action": "click",
  "locator": { "resourceId": "open_search" },
  "activity": {
    "before": "dev.taphound.demo.MainActivity"
  },
  "expect": {
    "type": "element",
    "locator": { "resourceId": "search_input" },
    "timeoutMs": 3000
  }
}
```

Example (inputText):
```json
{
  "action": "inputText",
  "text": "hello world",
  "activity": {
    "before": "dev.taphound.demo.SearchActivity"
  }
}
```

Example (bridge — auto replay with a bound External Flow):
```json
{
  "bridge": true,
  "scenario": "photoCapture",
  "triggerLocator": { "resourceId": "camera_button" },
  "flow": "camera/photo-capture",
  "description": "Capture photo via system camera",
  "activity": {
    "before": "dev.taphound.demo.ProfileActivity"
  }
}
```

Example (bridge — manual replay, no flow):
```json
{
  "bridge": true,
  "scenario": "pickFile",
  "triggerLocator": { "text": "Choose file" },
  "description": "Pick a file via system file picker",
  "activity": {
    "before": "dev.taphound.demo.ChatActivity"
  }
}
```

## Rules

- Never use coordinates, visual guessing, or annotated-label fallback.
- Never act when `snapshot.windowHierarchy.status` is `incomplete`.
- The proposed step only includes `activity.before`, never `activity.after`.
  The Core determines `after` from live device observation.
- Locator priority is fixed: `resourceId` > `text` > `contentDescription`.
  Do not use multiple fields simultaneously unless that is the only way to
  disambiguate. `within` limits matching to a deterministic ancestor's
  descendants; `index` is zero-based and applies only after all identity
  fields have narrowed the live Layout candidates.
- The `snapshot.layout` from `observe` is the live device layout — it is
  the source of truth for element matching, not the static XML files from
  Context generation. The same `resourceId` may appear in different layout
  XML files, but only one layout is active at runtime. Match against what
  `observe` returns.
- Activities from library/feature modules are valid navigation targets.
  Use the fully qualified class name from the manifest or source.
- Do not include `binding` — the caller adds it from the observe result.
- Do not include `fallback` — proposals do not support fallback.
- **Cross-app flows**: If the next action would open an external app (system
  camera, image/file picker, share sheet), do NOT propose a `click` step. That
  will fail with `PACKAGE_ESCAPE`. Instead, return:
  `{"bridge": true, "scenario": "photoCapture|pickImage|pickFile|custom",
  "triggerLocator": {...}, "description": "..." (required for custom)}`
  The caller will use `generation bridge` to execute it. Only return this when
  the target element clearly initiates a cross-app transition (e.g., a camera
  button, "choose from gallery", "attach file").
- When a bound External Flow matches the scenario, include `"flow": "<name>"`
  in the bridge signal. The caller passes `--flow <name>` to
  `generation bridge` so Core resolves the flow, stamps its steps as
  `externalSteps`, and commits with `replayMode: "auto"` for deterministic
  replay. If no flow is bound, omit `flow`; the step commits with
  `replayMode: "manual"` and needs a human operator during finalize.
- Do NOT include `externalSteps`, `escapedPackageName`, `replayMode`, or
  `escapeTimeoutMs` in the bridge proposal. Core fills these from the resolved
  flow and live device observation. The proposal only carries `flow` (the name)
  and the standard bridge fields.
- If no actionable element matches the Goal, return:
  `{"error": "no matching element", "reason": "..."}`
- If the Goal appears complete, return `{"complete": true}` instead of a
  step.
