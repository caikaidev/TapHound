# Verification-Only Scope Design

## Problem

TapHound owns a build step it should not own. `VerifyRuntime` and
`RecorderService` both run `./gradlew <task>`, then call `android describe` to
resolve an APK path, then launch through `android run --apks=...`. That forces
every TapHound user to own an executable Gradle wrapper, an Android build
toolchain, and a build configuration (`build.task`, `artifact.target`,
`artifact.variant`) that has nothing to do with replaying a Journey.

Compiling and installing an APK is an independent task. The realistic loop is
owned by the agent: edit code, build, install, verify, repeat. TapHound belongs
only in the last step.

A second problem surfaces at the same layer. Logcat is scoped to a single PID
obtained from `pidof <package>`. Multi-process applications lose every log line
from their secondary processes, and applications that rename their main process
through `android:process` produce false launch and crash failures.

## Scope Boundary

TapHound assumes the application is already installed on the selected device.
It asserts installation, cold-starts the application over ADB, replays, and
publishes a report. It never builds and never installs.

`android` CLI remains required for `layout`, `screen capture`, and
`screen resolve`. Gradle is removed from the product entirely.

## Launch Semantics

The launch prologue for both verify and record becomes:

1. Assert the configured package is installed
   (`adb shell pm path <package>`). A missing package is `APP_NOT_INSTALLED`.
2. Start Logcat.
3. `adb shell am force-stop <package>` for a deterministic cold start.
4. `adb shell am start -W -n <package>/<activity>`.
5. Wait for the application process, then for the readiness Activity.

`am start` exits 0 on some launch failures, so a launch is considered failed
when the command fails or stdout matches `/^Error(:| type)/m`.

`forceStop` before launch replaces the implicit reset that reinstalling through
`android run` used to provide.

## Configuration

`build` and `artifact` are removed from `taphound.config.json`. The schema stays
at `version: 1`; because it is strict, stale configs fail loudly with an
unknown-key error rather than silently ignoring dead fields.

```json
{
  "version": 1,
  "run": { "packageName": "com.example.app", "activity": ".MainActivity" },
  "idle": { "pollIntervalMs": 200, "stablePolls": 2, "timeoutMs": 5000 },
  "artifactsDir": ".taphound/runs"
}
```

## Project Facts

`project describe` no longer calls `android describe`, so it reports only
config-derived facts: `projectRoot`, `packageName`, `launchActivity`. The
generation `projectHash` binding hashes that narrowed object. Existing
generation sessions invalidate, which is acceptable before release.

## Failure Taxonomy

`BUILD_FAILED` is removed. `APP_NOT_INSTALLED` is added with exit code `3` and
report status `error`, matching the other environment failures, and is
reportable by `doctor`.

`layers.build` is removed from the report. The report `schemaVersion` becomes
`2`. `APP_NOT_INSTALLED` is attributed to the `run` layer.

## Doctor

The `gradle` wrapper check is removed. A new `app` check asserts the configured
package is installed on the selected device. It reports `notRun` when no device
was selected or no package was supplied, so `doctor` still works without a
readable config.

Because the wrapper probe was the only use of the project root, `DoctorService`
now takes an options object with `packageName`, `requestedDevice`, and `signal`.

Failure precedence: a failed `node`, `adb`, `android`, or `permissions` check
yields `ENVIRONMENT_MISSING_TOOL`; otherwise a failed device check yields
`DEVICE_UNAVAILABLE`; otherwise a failed app check yields `APP_NOT_INSTALLED`.

## Multi-Process Applications

`pidof <package>` is replaced by process enumeration over
`adb shell ps -A -o PID,NAME`, filtered to processes named exactly `<package>`
or prefixed `<package>:`, sorted by ascending PID.

A single call therefore serves both needs:

- The primary PID, used everywhere PID identity is load-bearing (`StepRunner`
  cross-step comparison, `runtime-snapshot.pid`, generation PID guards), is the
  exact-name match when present, otherwise the lowest PID. This fixes
  applications whose main process is renamed, which `pidof` could not find at
  all.
- The full PID set, used only to scope collected log lines.

`adb logcat --pid=` accepts one PID, so scoping stays a post-filter over a PID
set inside `LogcatCollector`. `scopeToPids` unions into the existing set and is
refreshed at each step's existing process check, so processes spawned mid-
journey join the scope. The dead `pid` option on the Logcat port is removed.

Crash detection keeps its current meaning: the primary process PID disappeared.
Secondary process failures still surface through Logcat evidence and explicit
`expect.logcat` assertions.

## Acceptance

Opt-in device acceptance no longer builds. Both acceptance scripts precheck
`adb shell pm path <package>` and fail with explicit build-and-install
instructions when the demo application is absent. The demo Gradle project and
its wrapper hash contract assertions stay: the demo is the application under
test, built outside TapHound.

## Test Coverage

- ADB `appProcesses` parsing, filtering, and ordering; `isInstalled`;
  `launchActivity` argument arrays.
- `primaryAppPid` selection, including a renamed main process and multiple
  same-named processes.
- `LogcatCollector.scopeToPids` union behavior and multi-PID filtering.
- Verify reports `APP_NOT_INSTALLED` when the package is absent, performs
  force-stop before launch, and no longer has a build phase or `build` layer.
- Doctor `app` check states and failure-code precedence.
- Config, report, examples, and documentation contracts reflect the removed
  build fields, the removed failure code, and report `schemaVersion` 2.
