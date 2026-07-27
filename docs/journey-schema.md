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

The priority is fixed as `resourceId`, `text`, then `contentDescription`. Replay starts from the first field that has matches and uses subsequent fields to disambiguate; zero matches return `LOCATOR_NOT_FOUND`, multiple matches return `LOCATOR_AMBIGUOUS`, and the target is never guessed.

## Action

- `click`: requires `locator`, performs an ADB tap.
- `longClick`: requires `locator`, accepts a positive integer `durationMs`, default 800.
- `inputText`: requires non-empty `text`, typed into the current focus.
- `swipe`: requires `locator`, `direction`; `distancePercent` is in `(0, 1]`, default 0.6; `durationMs` default 300. The Recorder only shows elements that Android CLI marks as scrollable and that provide bounds; a hand-written Journey that only locates an element without bounds will terminate with `ACTION_FAILED` and will not guess a swipe region.
- `scrollTo`: requires a target `locator`, a scroll container `container`, and `direction`; `maxSwipes` ranges from 1 to 30, default 20; `distancePercent` and `durationMs` default to 0.6 and 300 respectively. Replay deterministically resolves the target before and after each swipe, stopping once the target appears uniquely, without clicking the target; exceeding the limit returns `SCROLL_TARGET_NOT_FOUND`. The container must be unique and provide bounds; annotated fallback is not supported.
- `back`: performs the ADB BACK keyevent.
- `wait`: performs only Layout stability detection, with no fixed sleep.

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
