# TapHound Report Schema v4

TapHound Report is written to `.taphound/build/runs/<runId>/` by default, or to
the configured `<artifactsDir>/<runId>/`. The configured path must remain
under `.taphound/build/`. The same rule applies to `verify --reports`.

```text
report.json
summary.txt
screenshot-<role>.png
ui-hierarchy-<role>.json
logcat-<role>.txt
checkpoints/<id>-<condition-index>-ui.json
steps/001-logcat.txt
steps/001-layout-diff.json
steps/001-fallback-annotated.png
```

Only the optional evidence actually produced appears in `artifacts`. The report directory is first written to a temporary location and published via an atomic rename once complete.

## Top-Level Fields

- `schemaVersion`: currently `4`. Historical v2/v3 reports are not read.
- `runId`, `startedAt`, `finishedAt`, `durationMs`.
- `status`: `passed`, `failed`, `error`, or `manualRequired`.
- `project`: project root directory, Package, and launch Activity.
- `journey`: name and SHA-256 of the normalized content.
- `environment`: `devices` plus `tools`. Each device entry carries the Journey
  `role`, the resolved `deviceSerial`, the bound `uiBackend` descriptor
  (`id`, adapter/engine versions, and configuration hash), and optional
  `uiCache` counters for the run-scoped observation cache. Roles are unique,
  at least one device is present, and artifact roles must reference a declared
  device.
- `layers`: `run`, `structural`, `activityCheckpoint`, `explicitExpect`, `collection`.
- `steps`: per-step Action, Locator, Idle, Activity, Expect, and log-slice
  results. Locator results retain the requested Locator identity, not only the
  field that matched. Each step records the `device` role that executed it.
- `checkpoints` (optional): evaluated named Journey Checkpoints in execution
  order, with `id`, optional after-step `stepIndex`, aggregate `status`
  (`passed`, `failed`, `unresolved`), and each Activity, Screen, visible-element,
  absent-element, or structured Logcat event condition with its own status and
  requested identity. `allOf` conditions include `startedAtMs`, successful
  `matchedAtMs`, and evidence references; UI facts reference fresh Checkpoint
  snapshots. Event facts contain match count, optional matched-line SHA-256,
  window start, and the scoped Logcat artifact reference, not the raw matched
  message. The declared event fields remain in the requested condition identity.
  An unexecuted Checkpoint is not recorded. Failures use
  `CHECKPOINT_FAILED` or `CHECKPOINT_UNRESOLVED` (exit 1); the report remains
  V4 and final artifacts are still collected.
- `screens`: structured Knowledge Screen outcomes (`matched`, `ambiguous`,
  `unresolved`) when produced by verification. Contract hooks and evaluated
  Screen Checkpoints emit `matched` outcomes when detection is unambiguous.
- `artifacts`: paths to the report, summary, per-device screenshots and logs
  (`screenshots`/`uiHierarchies`/`logcats` arrays of `{role, path}`), and step
  logs. UI hierarchy entries refer to actual serialized final snapshots.
- `fallbackUsed`: whether any step used an explicit annotated fallback.
- `primaryFailure`: the first primary failure.
- `secondaryErrors`: collection or internal secondary errors that occurred after the primary failure.
- `logcatEvidence` (optional): `{role,status:"incomplete",droppedLines,droppedBytes,lastDroppedAtMs?}`
  when bounded Logcat buffering discarded unparsed or App-PID lines. Drops
  belonging only to unrelated parsed PIDs do not mark scoped evidence
  incomplete. A requirement needing whole-run Logcat evidence cannot pass.
  Structured-event windows starting after the last relevant drop can still be
  complete. A legacy positive `logcat` expectation may pass from a retained
  matching line because it does not assert absence or uniqueness.
  The retained raw artifact includes unparsed diagnostics and scoped app-PID
  lines, not parsed logs from unrelated packages.

A post-processing failure must not overwrite `primaryFailure`. For example, when a screenshot fails after a Locator failure, the Locator remains the primary failure and the screenshot issue goes into `secondaryErrors`.

## Fixed Failure Codes

- `CONFIG_INVALID`
- `ENVIRONMENT_MISSING_TOOL`
- `DEVICE_UNAVAILABLE`
- `UI_BACKEND_UNAVAILABLE`
- `RUNTIME_CAPABILITY_MISSING`
- `UI_SNAPSHOT_FAILED`
- `UI_SNAPSHOT_INVALID`
- `APP_NOT_INSTALLED`
- `APP_LAUNCH_FAILED`
- `APP_CRASHED`
- `LOCATOR_NOT_FOUND`
- `LOCATOR_AMBIGUOUS`
- `ANCHOR_NOT_FOUND`
- `ANCHOR_AMBIGUOUS`
- `SCROLL_TARGET_NOT_FOUND`
- `ACTION_FAILED`
- `IDLE_TIMEOUT`
- `ACTIVITY_BEFORE_MISMATCH`
- `ACTIVITY_AFTER_MISMATCH`
- `EXPECT_ACTIVITY_FAILED`
- `EXPECT_ELEMENT_FAILED`
- `EXPECT_LOGCAT_FAILED`
- `EXPECT_LOGCAT_AMBIGUOUS`
- `BRIDGE_NO_ESCAPE`
- `BRIDGE_NOT_RETURNED`
- `WAIT_TIMEOUT`
- `DEVICE_ROLE_UNMAPPED`
- `EXTERNAL_FLOW_NOT_FOUND`
- `EXTERNAL_FLOW_STALE`
- `EXTERNAL_LOCATOR_STRICTNESS`
- `EXTERNAL_PACKAGE_MISMATCH`
- `EXTERNAL_ACTIVITY_MISMATCH`
- `EXTERNAL_STEP_FAILED`
- `MANUAL_STEP_REQUIRED`
- `CONTEXT_INVALID`
- `CONTEXT_STALE`
- `BRIEF_INVALID`
- `CONTEXT_MODULE_NOT_FOUND`
- `CONTEXT_MODULE_INCOMPLETE`
- `CONTEXT_SCHEMA_INVALID`
- `CONTEXT_IDENTITY_MISMATCH`
- `PROJECT_ROOT_UNREADABLE`
- `PROJECT_ROOT_NOT_DIRECTORY`
- `EVIDENCE_SECRET_PATH`
- `EVIDENCE_NOT_FOUND`
- `EVIDENCE_UNREADABLE`
- `EVIDENCE_NOT_FILE`
- `EVIDENCE_PATH_ESCAPE`
- `EVIDENCE_CHANGED_IDENTITY`
- `EVIDENCE_TOO_LARGE`
- `EVIDENCE_HASH_MISMATCH`
- `ALIGN_DEVICE_UNAVAILABLE`
- `ALIGN_CAMERA_INTENT_FAILED`
- `ALIGN_CAMERA_NOT_LAUNCHED`
- `ALIGN_SHUTTER_NOT_FOUND`
- `ALIGN_SHUTTER_AMBIGUOUS`
- `ALIGN_SHUTTER_NO_RESOURCE_ID`
- `ALIGN_CONFIRM_NOT_FOUND`
- `ALIGN_CONFIRM_AMBIGUOUS`
- `ALIGN_CONFIRM_NO_RESOURCE_ID`
- `ALIGN_FLOW_EXISTS`
- `CONTRACT_INVALID`
- `CONTRACT_JOURNEY_MISSING`
- `CONTRACT_JOURNEY_DRIFT`
- `CONTRACT_EVIDENCE_INSUFFICIENT`
- `CONTRACT_KNOWLEDGE_UNAVAILABLE`
- `REPLAY_POLICY_UNAVAILABLE`
- `CHECKPOINT_FAILED`
- `CHECKPOINT_UNRESOLVED`
- `BASELINE_INCOMPARABLE`
- `BASELINE_EMPTY`
- `GIT_ROOT_NOT_FOUND`
- `GIT_REF_INVALID`
- `COLLECTION_FAILED`
- `INTERNAL_ERROR`

## Process Exit Codes

- `0`: verification passed, or the Recorder was safely cancelled by the user.
- `1`: the project under verification did not meet requirements, e.g. Replay, Activity, or Expect failure.
- `2`: invalid config, Journey, or CLI arguments.
- `3`: tools, permissions, app not installed, device environment unavailable, or the selected runtime backend lacks a capability the command needs (`RUNTIME_CAPABILITY_MISSING`).
- `4`: TapHound internal error or an unclassifiable cancellation.

The JSON `exitCode` of `taphound verify --json` matches the process exit code. Success or a normal verification failure includes `report`, `reportPath`, and `summaryPath`; config, environment, or internal errors that occur before the report is generated use `failure.code` and `failure.message`.

## Step Failure Evidence

Each step records monotonic time, duration, and the step Logcat path. Idle
evidence records poll count and, when available, total wait duration,
sampling-command duration, requested strategy, final stability `backendId`,
whether hybrid structural fallback was used, and whether frame activity was
detected. The Locator report
includes matched fields and fallback evidence; on Idle timeout the last Layout
Diff is saved; Activity and Expect each record the expected value, actual
result, and fixed failure code.

A passed, unique `logcatEvent` expectation can include `capture` (name,
type, value length, source step, declared window start and matched line SHA-256).
The raw bound value is not included in the report; requested Locators retain
their original `${name}` reference. A passed, hashed structured event may also
record `logcatEvent.requestErrorClass` when the app emits a valid
`fields.errorClass` (`client`, `auth`, `network`, `server`). Classification
uses only these references, not unstructured log text.

When a step targets a semantic Knowledge `anchor`, the Locator report records
`matchedBy: "anchor"`, the resolved `anchorId`, and an `anchor` sub-report whose
`status` is one of `"resolved"`, `"locatorFallback"`, or `"failed"`
(optionally with a `message`). `"resolved"` means the anchor mapped to an
element and no `locator` fallback ran; `"locatorFallback"` means the anchor did
not resolve and the step's `locator` was used as an explicit fallback;
`"failed"` means an anchor-only step could not resolve (reported as
`ANCHOR_NOT_FOUND` or `ANCHOR_AMBIGUOUS`). This evidence is written for
`click`, `longClick`, `swipe`, and `inputText` steps.

A `scrollTo` step records a
`scroll: { swipesUsed, maxSwipes }` summary and does not populate `locator`;
`idle` is populated only when an Idle timeout occurs during scrolling (and the
corresponding `steps/NNN-layout-diff.json` is written), while other scroll
failures (such as `SCROLL_TARGET_NOT_FOUND`, `ANCHOR_AMBIGUOUS`, or a missing
container) do not populate `idle`.

### Bridge and External Step Evidence

A `bridge` step records the trigger Locator, the escape detection
(`escapeTimeoutMs`), and the return wait (`returnTimeoutMs`). When
`externalSteps` is present (`replayMode: "auto"`), each external step's
action, Locator, and `expectedActivity` checkpoint are evaluated independently
against the escaped package. External-step failures use these codes:

- `EXTERNAL_PACKAGE_MISMATCH` — the foreground left `escapedPackageName` during
  an external step (exit code 1).
- `EXTERNAL_ACTIVITY_MISMATCH` — an external step's `expectedActivity` did not
  match the live foreground (exit code 1).
- `EXTERNAL_STEP_FAILED` — an external step's action failed, e.g. locator not
  found or action unsupported (exit code 1).
- `EXTERNAL_LOCATOR_STRICTNESS` — an external step locator lacks a
  `resourceId`; v1 requires XML-only resource IDs (exit code 2).
- `EXTERNAL_FLOW_NOT_FOUND` — `--flow` names a flow not bound to the session
  (exit code 2).
- `EXTERNAL_FLOW_STALE` — the bound flow file changed since `generation start`
  (exit code 2).
- `MANUAL_STEP_REQUIRED` — a non-interactive `finalize` (no TTY) encountered a
  `replayMode: "manual"` step. Bind an External Flow so the step commits with
  `replayMode: "auto"`, or run finalize in a terminal (exit code 2).
