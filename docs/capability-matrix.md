# TapHound Capability Matrix

One page answering "what can TapHound assert, how do Locators match, how do
generation revisions advance, and how do KLog tags map" — without reading
`dist/` sources. Source of truth for the semantics summarized here:
`src/domain/journey.ts` (expectations), `src/domain/layout.ts` and
`src/application/locator/locator-resolver.ts` (Locators),
`src/application/generation/` (revisions), `docs/journey-schema.md` (protocol).

## What can be asserted

Every Journey step structurally checks its before/after Activity. On top of
that, a step may carry one explicit `expect`:

| Capability | How | Notes |
|---|---|---|
| Activity is (still) foreground | `expect: { type: "activity", value, timeoutMs }` | Optionally scoped by `packageName` |
| Element exists | `expect: { type: "element", locator, timeoutMs }` | Polled until `timeoutMs` |
| Element enabled / disabled | `expect: { type: "element", locator, enabled: true\|false, timeoutMs }` | Read from the layout `enabled` field; poll lets a late enable settle |
| Element clickable / not clickable | `expect: { type: "element", locator, clickable: true\|false, timeoutMs }` | `clickable` treats a missing field as `false` |
| Element is gone | `expect: { type: "element", locator, absent: true, timeoutMs }` | Passes when the Locator no longer resolves; cannot combine with `enabled`/`clickable` (schema-rejected) |
| Logcat line seen | `expect: { type: "logcat", tag, pattern, match, timeoutMs }` | `tag` matches **exactly**; `pattern` is a substring (`match: "literal"`, default) or a regex (`match: "regex"`) |
| Unique logcat event | `expect: { type: "logcatEvent", ... }` | Fail-closed on any relevant scoped drop in the event window |

Assertion blind spots (by design or not yet implemented):

- **Alpha / opacity / partial overlay** — not present in UI snapshots; cannot
  be asserted. Express the user-visible consequence (an `enabled: false` or
  `absent` predicate) instead.
- **"Click a disabled element and nothing happens"** — a passing Journey
  cannot click a disabled target (click resolves with
  `requireEnabled: true` and fails with `ACTION_FAILED`). Express the negative
  check as an `enabled: false` element expectation plus an unchanged Activity
  expectation on a separate step.
- **`annotatedLabel` is a locator fallback, not an assertion.** It only
  applies to `click`/`longClick` steps that explicitly opt in.

## Locator matching semantics

Locator fields: `resourceId`, `text`, `contentDescription`.

| Rule | Behavior |
|---|---|
| Field priority | Default (`combine: "priority"` or unset) tries fields in order `resourceId` → `text` → `contentDescription`; the first field with at least one match becomes the candidate set, later fields only narrow an ambiguous (>1) candidate set. A narrowing that empties the set fails `LOCATOR_NOT_FOUND` ("fields conflict") |
| All-fields AND | `combine: "all"` requires **every** provided field to match the same element |
| Match modes | `exact` (default), `contains`, `startsWith`, `regex` — set globally with `match`, or per field with `matchBy: { resourceId, text, contentDescription }` |
| Regex | `match: "regex"` compiles the pattern against the raw field value; invalid regexes are schema-rejected |
| Ordinal | `index` disambiguates remaining candidates; in generation, `index` requires paired semantic `evidence`, and replay recomputes it before mutation |
| Scope | `within` restricts candidates to descendants of the scope element's match; the scope element itself is **not** included (ancestor chains exclude self) |
| Ambiguity | More than one surviving candidate fails `LOCATOR_AMBIGUOUS`; zero fail `LOCATOR_NOT_FOUND`. TapHound never picks heuristically |

## UI tree fidelity

TapHound matches Locators and checks capabilities against the layout of the
selected `ui.backend`, never against a raw `uiautomator dump`. The backends
see the same accessibility data but shape it differently, so study the tree
with `taphound observe` or `generation observe` on the backend the Journey
will run with.

| Observation | Consequence |
|---|---|
| Backends expose different hierarchies: a raw `uiautomator dump` shows the `android.webkit.WebView` wrapper nodes that the Appium UiAutomator2 tree omits | Ancestor chains, `within` scopes, and "nearest clickable ancestor" conclusions drawn from a raw dump may not hold in Replay |
| RecyclerView rows handled by an item-touch listener and WebView DOM nodes report no `clickable` element anywhere in their ancestor chain | `click`/`longClick` fail closed (`ACTION_UNSUPPORTED` in Generation, `ACTION_FAILED` in Replay) unless the step opts into `touchPolicy: "element"` with an outcome `expect` (see `docs/journey-schema.md`) |
| WebView DOM bounds follow the CSS box, not the rendered pixels (a 60 px image reported as 1533 px tall), and may overflow the WebView and the display | `touchPolicy: "element"` touches the center of the bounds clipped to every ancestor and the display; that point can still miss small content, so the step's `expect` must be one only the intended target can cause |
| Field reports show content such as an open DrawerLayout drawer missing from a raw dump while present in `taphound observe` | Assert drawer contents only from TapHound snapshots |
| System UIAutomator captures are slower than Appium captures (field report: about 2.7 s against 0.5–1.2 s per capture) | Choose the backend before `generation start`; the session binds it, and later commands must use the same `--config` |

## Generation revision rules

Session revisions advance atomically with persisted evidence. A proposal must
bind the exact current `baseRevision` and `snapshotHash`; a stale binding
fails `SNAPSHOT_STALE`.

| Operation | Revision effect |
|---|---|
| `generation observe` | Binds the new snapshot at `revision + 1` |
| `generation step` (successful) | Advances `+2` from the proposal's `baseRevision` (freshness re-observe + step commit) |
| `generation config idle` patch | Advances the revision; the next proposal must bind the new revision |
| `generation step --replace <index>` | Replays the stored prefix, truncates, advances the revision, binds a fresh post-replay snapshot |

Net effect: one full observe→step cycle moves the next proposal's
`baseRevision` forward by **3**. Always copy `nextBinding.baseRevision` and
`nextBinding.snapshotHash` (or the observe output) into the next envelope
instead of computing revisions manually.

## KLog tag mapping

Android `Log`/KLog source tags are prefixed at runtime by the IM logger: a
source `TAG` of `MailPageFragment` appears in logcat as tag
`IM.MailPageFragment`. A `logcat` expectation's `tag` matches the **full
runtime tag exactly** — include the `IM.` prefix. Literal patterns match as
substrings of the fully decorated message (KLog adds `[, , -1]:`-style
decorations), so prefer a stable substring.

## Feedback reconciliation

Tracked in `docs/feedback/taphound-feedback.md`. Landed in the current
workstream: element predicates (`enabled`/`clickable`), `absent`, multi-field
AND Locators (`combine: "all"`), per-field `matchBy`, Locator `regex` match,
and this capability matrix.
