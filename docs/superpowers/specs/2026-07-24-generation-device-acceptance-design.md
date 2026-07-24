# Generation Device Acceptance — Phase 1 Design

Date: 2026-07-24
Status: Approved

## Goal

Provide a real-device, end-to-end acceptance path for the AI Journey Core
generation protocol that was merged in `feat/ai-journey-core`. This validates
that `generation start → observe → step×4 → finalize → verified` runs
deterministically on a real Android device against the existing
`taphound-android-demo`.

## Scope

Phase 1 covers the happy path only:

- `generation start` creates a Core-owned session.
- `generation observe` captures an authoritative runtime snapshot.
- Four `generation step` invocations replay the same deterministic flow as
  `examples/taphound-android-demo/journeys/search.json`:
  1. `click open_search` (MainActivity → SearchActivity, expect element
     `search_input`).
  2. `click search_input` (SearchActivity → SearchActivity).
  3. `inputText "hello world"` (SearchActivity → SearchActivity).
  4. `click submit_search` (SearchActivity → SearchActivity, expect logcat
     `tag=SearchViewModel level=I pattern="submitted query=hello world"`).
- `generation finalize` performs one full replay and publishes a verified
  immutable bundle plus an exported Journey and sidecar meta.

Out of scope: `confirm`, `manual`, recovery/failure paths, variable templates,
multi-device selection logic beyond a single optional override. These belong to
later phases.

## New Files

### `scripts/acceptance-generation.mjs`

A single opt-in script modeled on `scripts/acceptance-device.mjs`.

Behavior:

1. If `TAPHOUND_ACCEPTANCE_DEVICE !== "1"`, print a skip message to stderr and
   exit 0.
2. Verify `dist/cli/main.js` exists (require `npm run build` first).
3. Verify `examples/taphound-android-demo/gradlew` is executable.
4. Compute SHA-256 of five demo source files at runtime and write
   `examples/taphound-android-demo/.taphound/context/project-context.json`:
   - `app/src/main/AndroidManifest.xml`
   - `app/src/main/java/dev/taphound/demo/MainActivity.kt`
   - `app/src/main/java/dev/taphound/demo/SearchActivity.kt`
   - `app/src/main/res/layout/activity_main.xml`
   - `app/src/main/res/layout/activity_search.xml`
   All with `confidence: "sourceConfirmed"`.
5. Run `generation start --project <demo> --config <config> --context <ctx>
   --device <serial> --json` and capture `generationId`.
6. For each of the four predefined steps:
   a. Run `generation observe --project <demo> --session <id> --json`; capture
      the returned `snapshot` object and `binding` (`generationId`,
      `baseRevision`, `snapshotHash`).
   b. Build a strict envelope `{version:1, proposal, snapshot}` where
      `proposal` is the predefined step template with its `binding` field set
      to the just-observed binding. Write it to a temporary file.
   c. Run `generation step --project <demo> --session <id> --input <envelope>
      --json` and assert the result `status` is `"succeeded"`.
7. Run `generation finalize --project <demo> --session <id> --context <ctx>
   --output journeys/generated-search.json --device <serial> --json` and assert
   `status` is `"verified"`.
8. On any non-passing status or non-zero exit, write the failing command,
   exit code, and stdout/stderr to stderr and exit non-zero.

Device selection: read `TAPHOUND_DEVICE` env var; if unset, pass no `--device`
and let `doctor` select the single online device. If `doctor` reports
`DEVICE_UNAVAILABLE`, exit 3.

### `package.json`

Add `"acceptance:generation": "node scripts/acceptance-generation.mjs"` to
`scripts`.

## Predefined Step Templates

Each template is a constant in the script. Only `binding` is filled per
iteration from the observe result.

```
step1: click open_search, MainActivity→SearchActivity,
       expect element search_input timeoutMs 3000
step2: click search_input, SearchActivity→SearchActivity
step3: inputText "hello world", SearchActivity→SearchActivity
step4: click submit_search, SearchActivity→SearchActivity,
       expect logcat tag=SearchViewModel level=I
       pattern="submitted query=hello world" match=literal timeoutMs 3000
```

## Project Context Schema

```json
{
  "version": 1,
  "packageName": "dev.taphound.demo",
  "launchActivity": "dev.taphound.demo.MainActivity",
  "manifest": {
    "version": 1,
    "files": [
      { "path": "<relative>", "sha256": "<runtime>", "confidence": "sourceConfirmed" }
    ]
  },
  "interactionPolicy": {
    "allowedActions": ["click","longClick","inputText","swipe","scrollTo","back","wait"],
    "confirmationRequiredActions": [],
    "forbiddenActions": []
  }
}
```

Manifest paths are relative to the demo project root. SHA-256 values are
computed at runtime so the fixture stays valid when demo source changes.

## Constraints

- No changes to merged Core code; this is fixture and script only.
- Script uses `spawnSync` against `dist/cli/main.js`, `shell: false`, argument
  arrays — matching `acceptance-device.mjs` style.
- Envelope temp files are written under the OS temp dir and cleaned up.
- The generated `project-context.json` is written under the demo's
  `.taphound/context/` directory (already git-ignored as a build artifact).
- No unit tests for the script itself; it is opt-in device acceptance, matching
  `acceptance-device.mjs` precedent.
- Real-device acceptance remains explicitly opt-in via
  `TAPHOUND_ACCEPTANCE_DEVICE=1`.

## Success Criteria

A single run of `TAPHOUND_ACCEPTANCE_DEVICE=1 npm run acceptance:generation`
on a machine with one online Android device, after `npm run build`, exits 0
and produces:

- `.taphound/generations/<id>/` authoritative bundle with manifest, candidate
  and verified Journey, generation report, verification report/receipt, meta.
- `examples/taphound-android-demo/journeys/generated-search.json` and
  `generated-search.meta.json` exported sidecars.
- The finalize JSON on stdout has `status: "verified"`.
