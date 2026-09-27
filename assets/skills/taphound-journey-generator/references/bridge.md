# Cross-Application Bridge

When the Goal requires a cross-app flow (system camera, image/file picker,
share sheet), a regular `generation step` proposal fails with `PACKAGE_ESCAPE`.
Use `generation bridge` instead. Core clicks the trigger, detects the escape,
optionally executes a bound External Flow's steps inside the escaped package,
waits for return, and captures the post-return snapshot.

```bash
taphound generation bridge \
  --project <project> --session <generationId> \
  --scenario photoCapture \
  --trigger-locator '{"resourceId":"camera_button"}' \
  --flow camera/photo-capture \
  --return-timeout-ms 60000 --escape-timeout-ms 3000 \
  --compact --json
```

**Auto bridge** (deterministic): pass `--flow <name>` to bind a Phase 2
External Flow. The step commits with `replayMode: "auto"`. **Manual bridge**:
omit `--flow`; commits with `replayMode: "manual"` (human operator required
during finalize). Options: `--scenario` (`photoCapture`, `pickImage`,
`pickFile` built-in, or `custom` with `--description`), `--trigger-locator`
(inline JSON, must be clickable), `--return-timeout-ms`, `--escape-timeout-ms`
(default 3000; no escape fails with `BRIDGE_NO_ESCAPE`).

Bridge goes through risk confirmation like any step. Failure codes:
`BRIDGE_NO_ESCAPE`, `SCENARIO_PACKAGE_MISMATCH`, `BRIDGE_NOT_RETURNED`,
`EXTERNAL_FLOW_NOT_FOUND`, `EXTERNAL_FLOW_STALE`,
`EXTERNAL_PACKAGE_MISMATCH`, `EXTERNAL_ACTIVITY_MISMATCH`,
`EXTERNAL_STEP_FAILED`, `EXTERNAL_LOCATOR_STRICTNESS` (external steps require
`resourceId`-only locators), `MANUAL_STEP_REQUIRED` (non-interactive finalize
with manual replay — bind an External Flow or use a TTY).

A successful bridge returns `nextBinding` and `nextSnapshotRef` like any step.
