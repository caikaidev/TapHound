# Generate Next Proposed Step

You are generating the next proposed step in a TapHound journey. You have:

- **Goal**: the user's natural-language description of the test scenario.
- **Project Context**: the JSON you generated in Phase 1 (known UI elements,
  locators, interaction policy).
- **Snapshot**: the current device state from `generation observe --json`,
  including the `layout` array (all visible UI elements with their
  properties) and the current `activity`.
- **Completed steps**: a list of steps that have already succeeded in this
  session.

## Your Task

Determine the next single action that advances the Goal. Output one proposed
step JSON object (without the `binding` field — the caller adds binding from
the observe result).

## How to Decide

1. **Identify what remains**: Compare the Goal against completed steps. What
   is the next logical action?

2. **Find the target element**: Look through `snapshot.layout` for an element
   that matches the next intended action:
   - Match by `resourceId` first (highest priority).
   - If no `resourceId` match, match by `text`.
   - If no `text` match, match by `contentDescription`.
   - The element must be `enabled: true`.
   - For `click`: prefer `clickable: true` elements.
   - For `inputText`: the target should be `focusable: true` (an EditText).
     Do not include a `locator` for `inputText` — the Core uses the focused
     element.
   - For `swipe`: the target should be `scrollable: true` with `bounds`.
   - For `scrollTo`: specify both `locator` (target) and `container`
     (scrollable parent).

3. **Determine activity.before**: This is `snapshot.activity` (the current
   Activity class). The proposed step only includes `activity.before` —
   never `activity.after`. The Core determines the after-Activity from
   live device observation after executing the action.

4. **Add expect (optional)**: Only if there is a deterministic, verifiable
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

## Rules

- Never use coordinates, visual guessing, or annotated-label fallback.
- The proposed step only includes `activity.before`, never `activity.after`.
  The Core determines `after` from live device observation.
- Locator priority is fixed: `resourceId` > `text` > `contentDescription`.
  Do not use multiple fields simultaneously unless that is the only way to
  disambiguate.
- The `snapshot.layout` from `observe` is the live device layout — it is
  the source of truth for element matching, not the static XML files from
  Context generation. The same `resourceId` may appear in different layout
  XML files, but only one layout is active at runtime. Match against what
  `observe` returns.
- Activities from library/feature modules are valid navigation targets.
  Use the fully qualified class name from the manifest or source.
- Do not include `binding` — the caller adds it from the observe result.
- Do not include `fallback` — proposals do not support fallback.
- If no actionable element matches the Goal, return:
  `{"error": "no matching element", "reason": "..."}`
- If the Goal appears complete, return `{"complete": true}` instead of a
  step.
