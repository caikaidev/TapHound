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
