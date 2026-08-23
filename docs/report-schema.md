# TapHound Report Schema v2

TapHound Report is written to `.taphound/build/runs/<runId>/` by default, or to
the configured `<artifactsDir>/<runId>/`. A custom path may be outside
`.taphound`; if it is inside `.taphound`, it must remain under
`.taphound/build/`. The same rule applies to `verify --reports`.

```text
report.json
summary.txt
screenshot.png
logcat.txt
steps/001-logcat.txt
steps/001-layout-diff.json
steps/001-fallback-annotated.png
```

Only the optional evidence actually produced appears in `artifacts`. The report directory is first written to a temporary location and published via an atomic rename once complete.

## Top-Level Fields

- `schemaVersion`: currently `2`.
- `runId`, `startedAt`, `finishedAt`, `durationMs`.
- `status`: `passed`, `failed`, or `error`.
- `project`: project root directory, Package, and launch Activity.
- `journey`: name and SHA-256 of the normalized content.
- `environment`: device serial number and Node, ADB, Android CLI versions.
- `layers`: `run`, `structural`, `activityCheckpoint`, `explicitExpect`, `collection`.
- `steps`: per-step Action, Locator, Idle, Activity, Expect, and log-slice results.
- `artifacts`: paths to the report, summary, screenshot, full log, and step logs.
- `fallbackUsed`: whether any step used an explicit annotated fallback.
- `primaryFailure`: the first primary failure.
- `secondaryErrors`: collection or internal secondary errors that occurred after the primary failure.

A post-processing failure must not overwrite `primaryFailure`. For example, when a screenshot fails after a Locator failure, the Locator remains the primary failure and the screenshot issue goes into `secondaryErrors`.

## Fixed Failure Codes

- `CONFIG_INVALID`
- `ENVIRONMENT_MISSING_TOOL`
- `DEVICE_UNAVAILABLE`
- `APP_NOT_INSTALLED`
- `APP_LAUNCH_FAILED`
- `APP_CRASHED`
- `LOCATOR_NOT_FOUND`
- `LOCATOR_AMBIGUOUS`
- `SCROLL_TARGET_NOT_FOUND`
- `ACTION_FAILED`
- `IDLE_TIMEOUT`
- `ACTIVITY_BEFORE_MISMATCH`
- `ACTIVITY_AFTER_MISMATCH`
- `EXPECT_ACTIVITY_FAILED`
- `EXPECT_ELEMENT_FAILED`
- `EXPECT_LOGCAT_FAILED`
- `BRIDGE_NO_ESCAPE`
- `BRIDGE_NOT_RETURNED`
- `MANUAL_STEP_REQUIRED`
- `COLLECTION_FAILED`
- `INTERNAL_ERROR`

## Process Exit Codes

- `0`: verification passed, or the Recorder was safely cancelled by the user.
- `1`: the project under verification did not meet requirements, e.g. Replay, Activity, or Expect failure.
- `2`: invalid config, Journey, or CLI arguments.
- `3`: tools, permissions, app not installed, or device environment unavailable.
- `4`: TapHound internal error or an unclassifiable cancellation.

The JSON `exitCode` of `taphound verify --json` matches the process exit code. Success or a normal verification failure includes `report`, `reportPath`, and `summaryPath`; config, environment, or internal errors that occur before the report is generated use `failure.code` and `failure.message`.

## Step Failure Evidence

Each step records monotonic time, duration, and the step Logcat path. Idle
evidence records poll count and, when available, total wait duration,
sampling-command duration, requested strategy, final stability backend,
whether hybrid structural fallback was used, and whether frame activity was
detected. The Locator report
includes matched fields and fallback evidence; on Idle timeout the last Layout
Diff is saved; Activity and Expect each record the expected value, actual
result, and fixed failure code. A `scrollTo` step records a
`scroll: { swipesUsed, maxSwipes }` summary and does not populate `locator`;
`idle` is populated only when an Idle timeout occurs during scrolling (and the
corresponding `steps/NNN-layout-diff.json` is written), while other scroll
failures (such as `SCROLL_TARGET_NOT_FOUND`, `LOCATOR_AMBIGUOUS`, or a missing
container) do not populate `idle`.
