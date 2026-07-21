# Launch Readiness Design

## Problem

TapHound currently treats `run.activity` as both the Activity passed to Android
CLI for launching the app and the Activity that must still be resumed after
launch. Real applications commonly use a transient splash Activity and then
route to a login or authenticated home Activity. Recorder therefore rejects a
successful launch before the user can begin recording, and Verify cannot replay
a Journey whose first step begins after that redirect.

## Semantics

`run.activity` is the launch entry point only. It does not define the stable
post-launch Activity.

Recorder begins from the Activity that is actually resumed after launch and
layout stabilization. Verify uses the first Journey step's `activity.before` as
the deterministic post-launch readiness target.

## Recorder Flow

After build, APK description, and Android CLI launch:

1. Confirm the configured application process exists.
2. Capture a baseline layout and wait for layout stability using the configured
   idle settings.
3. Enter the prompt loop without comparing the current Activity to
   `run.activity`.
4. Continue recording each successful step's real `activity.before` and
   `activity.after` values.

If the process does not exist, recording fails with the existing launch error.
If the startup layout does not stabilize before `idle.timeoutMs`, recording
fails before prompting and does not write a partial Journey.

## Verify Flow

After build, APK description, Logcat startup, and Android CLI launch:

1. Confirm the configured application process exists.
2. Poll the resumed Activity until it equals the first Journey step's
   `activity.before`.
3. Use `idle.pollIntervalMs` as the polling interval and `idle.timeoutMs` as the
   deadline.
4. While polling, confirm that the application process remains alive.
5. Once the expected Activity appears, capture the baseline layout and continue
   through the existing `StepRunner`.

The wait is bounded and abort-aware. It does not change Journey step semantics;
`StepRunner` still performs the first step's normal before-Activity checkpoint.

## Failure Behavior

- A missing process during startup readiness remains `APP_LAUNCH_FAILED`.
- A timeout waiting for the first step Activity is `APP_LAUNCH_FAILED`.
- The timeout message includes the expected Activity and the last observed
  Activity.
- Cancellation follows the existing runtime cancellation behavior.
- Build, Android CLI launch, evidence collection, and report publication
  behavior remain unchanged.

## Compatibility

No config, Journey, or report schema changes are required. Journeys whose first
step begins on the configured launch Activity continue to work. Journeys can
now begin on login-dependent landing pages reached through a transient splash
Activity.

## Test Coverage

- Recorder accepts a launch redirect and records the redirected Activity as the
  first step's `activity.before`.
- Recorder still rejects a missing process and an unstable startup layout.
- Verify waits through intermediate Activities until the first step Activity.
- Verify reports `APP_LAUNCH_FAILED` when the expected first Activity is not
  reached before timeout.
- Verify reports launch failure if the process disappears while waiting.
- Existing fixed-Activity recorder and verification tests continue to pass.
