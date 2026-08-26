---
schemaVersion: 1
kind: taphound.journeyBrief
caseId: CASE-002
---

# Goal

Open Search, submit an empty query, and verify validation.

## Preconditions

- Start from an independent cold launch.
- Use the approved `search-basic` fixture.

## Expected Journey

1. Open Search from Home.
2. Leave the query empty.
3. Submit the query.
4. Observe the empty-query validation state.

## Assertions

- `SearchActivity` remains foreground.
- The `empty_query_error` element is visible.

## Implementation Hints

- Home entry resource ID: `open_search`.
- Submit resource ID: `submit_search`.
- Relevant module: `:feature:search`.

## Constraints

- Do not use coordinates or visual guessing.
- Final Replay must pass.

## Evidence References

- `feature/search/src/main/java/com/example/search/SearchScreen.kt`
- `feature/search/src/main/res/layout/search_screen.xml`
