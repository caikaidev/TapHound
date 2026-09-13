# Semantic Anchor (V0.5)

An Anchor is a **Semantic UI Reference**, not a single selector. It carries an
ordered **candidate chain**; resolution walks the chain deterministically and
records *how* it matched, so a Journey survives XML→Compose migrations,
resource-id renames, and layout moves as long as one candidate still matches.

## Model

```json
{
  "version": 1,
  "id": "search.submit",
  "status": "observed",
  "roles": ["actionable"],
  "identity": { "kind": "element", "locator": { "resourceId": "search_submit" } },
  "candidates": [
    { "kind": "composeSemantics", "locator": { "text": "Search" } },
    { "kind": "resourceId", "locator": { "resourceId": "search_submit" } },
    { "kind": "contentDescription", "locator": { "contentDescription": "Search" } },
    { "kind": "visibleText", "locator": { "text": "Search" } },
    { "kind": "visualMatch", "locator": { "text": "Search" } }
  ]
}
```

## Resolution rules (`KnowledgeAnchorResolver`)

1. Candidates run in declaration order; **the first unique match wins**.
2. The win records `resolvedBy { kind, confidence }`:
   - `primary` — the first candidate of the chain matched;
   - `fallback` — a later candidate matched (visible in the report, never
     silent).
3. An anchor without `candidates` keeps the legacy behavior: its single
   `identity.locator` is treated as the primary candidate (kind inferred
   from the locator fields).
4. **`visualMatch` is never resolved by Core.** If nothing before it matches,
   resolution is `visualOnly` and fails closed with
   `RUNTIME_CAPABILITY_MISSING` (exit code 3) — visual matching stays an
   external multimodal layer driven by the Playbook Escalation Policy, never
   a Core default (`docs/playbook.md`, `docs/source-of-truth.md`).
5. Ambiguity at any candidate fails closed — Core never picks heuristically
   (matches the fixed locator-priority rule).

## Confidence in the report

Step reports carry the resolution itself:

```json
"locator": {
  "status": "found",
  "matchedBy": "anchor",
  "anchorId": "search.submit",
  "anchor": {
    "status": "resolved",
    "resolvedBy": { "kind": "visibleText", "confidence": "fallback" }
  }
}
```

A `fallback` resolution is the signal V0.5 measures: the anchor still works,
but its primary signal degraded. Feature Map and Benchmark runs can use this
to prioritize anchor hardening (add a higher-priority candidate) without
breaking Journeys.

## Failure semantics

| Resolution | Meaning | Verdict impact |
|---|---|---|
| `found` | a candidate matched uniquely | proceeds; report records kind+confidence |
| `notFound` | no candidate matched, no visualMatch | `ANCHOR_NOT_FOUND` |
| `ambiguous` | a candidate matched multiple elements | `ANCHOR_AMBIGUOUS` |
| `visualOnly` | only visualMatch could resolve | `RUNTIME_CAPABILITY_MISSING` (capability boundary, external reviewer) |

## Migration path

1. Keep existing Anchors untouched — legacy behavior is unchanged.
2. Add `candidates` in priority order when an Anchor becomes brittle
   (e.g. a resource-id rename is announced).
3. Keep `visualMatch` last and only when a multimodal reviewer is available
   under the Escalation Policy; Core will never attempt it.