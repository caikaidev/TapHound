# Launch Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat `run.activity` only as the Android launch entry point, let Recorder start from the stable post-launch page, and let Verify wait for the first Journey step's expected Activity.

**Architecture:** Add a focused `ActivityWaiter` application service for bounded, abort-aware startup Activity polling with process-liveness checks. Recorder will remove its exact launch-Activity comparison and use the existing `IdleWaiter` before prompting; Verify will use `ActivityWaiter` before its baseline layout and existing `StepRunner`.

**Tech Stack:** TypeScript 6, Node.js ESM/NodeNext, Vitest 4, existing `AdbPort`, `Clock`, and `IdleWaiter` abstractions.

## Global Constraints

- `run.activity` remains required and is passed unchanged as the Android CLI launch entry point.
- Recorder records the actual stable post-launch Activity; it must not require that Activity to equal `run.activity`.
- Verify waits no longer than `idle.timeoutMs` for the first Journey step's `activity.before`.
- Polling uses `idle.pollIntervalMs`, checks the configured app process, and honors `AbortSignal`.
- Missing process and readiness timeout map to `APP_LAUNCH_FAILED`.
- No config, Journey, or report schema changes.
- Preserve all build, evidence collection, primary-failure, and atomic publication behavior.
- Keep ESM `.js` import suffixes and explicit function return types.
- Do not stage or commit unrelated pre-existing working-tree changes.

## File Structure

- Create `src/application/runtime/activity-waiter.ts`: bounded startup Activity and process-liveness polling.
- Create `test/application/runtime/activity-waiter.test.ts`: unit contract for ready, timeout, process exit, and cancellation results.
- Modify `src/application/recorder/recorder-service.ts`: replace exact launch-Activity readiness with process and startup-layout stability.
- Modify `test/application/recorder/recorder-service.test.ts`: cover redirected landing Activity and startup instability.
- Modify `src/application/runtime/verify-runtime.ts`: wait for the first Journey step Activity before baseline layout.
- Modify `test/application/runtime/verify-runtime.test.ts`: cover redirect success, timeout, process exit, and updated orchestration order.

---

### Task 1: Add the Startup Activity Waiter

**Files:**
- Create: `src/application/runtime/activity-waiter.ts`
- Create: `test/application/runtime/activity-waiter.test.ts`

**Interfaces:**
- Consumes: `AdbPort.currentActivity`, `AdbPort.pid`, `Clock.now`, and `Clock.sleep`.
- Produces:

```ts
export interface ActivityWaitOptions {
  packageName: string;
  deviceSerial: string;
  expectedActivity: string;
  pollIntervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type ActivityWaitResult =
  | { status: "ready"; actual: string; durationMs: number }
  | { status: "timeout"; actual?: string | undefined; durationMs: number }
  | { status: "processMissing"; actual?: string | undefined; durationMs: number }
  | { status: "cancelled"; actual?: string | undefined; durationMs: number };

export class ActivityWaiter {
  public constructor(adb: AdbPort, clock: Clock);
  public wait(options: ActivityWaitOptions): Promise<ActivityWaitResult>;
}
```

- [ ] **Step 1: Write failing readiness tests**

Create `test/application/runtime/activity-waiter.test.ts` with tests equivalent to:

```ts
import { describe, expect, it, vi } from "vitest";

import { ActivityWaiter } from "../../../src/application/runtime/activity-waiter.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import { runtimeFixture } from "../../fakes/runtime-fixture.js";

const options = {
  packageName: "com.example.app",
  deviceSerial: "emulator-5554",
  expectedActivity: "com.example.app.HomeActivity",
  pollIntervalMs: 100,
  timeoutMs: 300
};

describe("ActivityWaiter", () => {
  it("waits through a transient Activity", async () => {
    const runtime = runtimeFixture();
    const clock = new FakeClock();
    vi.mocked(runtime.adb.pid).mockResolvedValue(42);
    vi.mocked(runtime.adb.currentActivity)
      .mockResolvedValueOnce("com.example.app.SplashActivity")
      .mockResolvedValueOnce("com.example.app.HomeActivity");

    await expect(new ActivityWaiter(runtime.adb, clock).wait(options))
      .resolves.toEqual({
        status: "ready",
        actual: "com.example.app.HomeActivity",
        durationMs: 100
      });
    expect(clock.sleeps).toEqual([100]);
  });

  it("returns the last Activity on timeout", async () => {
    const runtime = runtimeFixture();
    const clock = new FakeClock();
    vi.mocked(runtime.adb.pid).mockResolvedValue(42);
    vi.mocked(runtime.adb.currentActivity)
      .mockResolvedValue("com.example.app.SplashActivity");

    await expect(new ActivityWaiter(runtime.adb, clock).wait({
      ...options,
      timeoutMs: 200
    })).resolves.toEqual({
      status: "timeout",
      actual: "com.example.app.SplashActivity",
      durationMs: 200
    });
  });

  it("stops when the configured App process exits", async () => {
    const runtime = runtimeFixture();
    const clock = new FakeClock();
    vi.mocked(runtime.adb.pid)
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(null);
    vi.mocked(runtime.adb.currentActivity)
      .mockResolvedValue("com.example.app.SplashActivity");

    await expect(new ActivityWaiter(runtime.adb, clock).wait(options))
      .resolves.toMatchObject({
        status: "processMissing",
        actual: "com.example.app.SplashActivity"
      });
  });

  it("honors an already aborted signal", async () => {
    const runtime = runtimeFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(new ActivityWaiter(runtime.adb, new FakeClock()).wait({
      ...options,
      signal: controller.signal
    })).resolves.toEqual({
      status: "cancelled",
      durationMs: 0
    });
    expect(runtime.adb.pid).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```bash
npm test -- test/application/runtime/activity-waiter.test.ts
```

Expected: FAIL because `src/application/runtime/activity-waiter.ts` does not exist.

- [ ] **Step 3: Implement the minimal waiter**

Create `src/application/runtime/activity-waiter.ts`. The loop must:

```ts
const startedAt = this.clock.now();
let actual: string | undefined;

for (;;) {
  if (options.signal?.aborted === true) {
    return {
      status: "cancelled",
      durationMs: this.clock.now() - startedAt,
      ...(actual === undefined ? {} : { actual })
    };
  }

  const elapsed = this.clock.now() - startedAt;
  const commandTimeoutMs = Math.max(1, options.timeoutMs - elapsed);
  const identity = {
    packageName: options.packageName,
    deviceSerial: options.deviceSerial,
    timeoutMs: commandTimeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  };

  if (await this.adb.pid(identity) === null) {
    return {
      status: "processMissing",
      durationMs: this.clock.now() - startedAt,
      ...(actual === undefined ? {} : { actual })
    };
  }

  actual = await this.adb.currentActivity(identity);
  if (actual === options.expectedActivity) {
    return {
      status: "ready",
      actual,
      durationMs: this.clock.now() - startedAt
    };
  }

  const elapsedAfterPoll = this.clock.now() - startedAt;
  if (elapsedAfterPoll >= options.timeoutMs) {
    return { status: "timeout", actual, durationMs: elapsedAfterPoll };
  }

  try {
    await this.clock.sleep(
      Math.min(options.pollIntervalMs, options.timeoutMs - elapsedAfterPoll),
      options.signal
    );
  } catch (error) {
    if (options.signal?.aborted === true) {
      return {
        status: "cancelled",
        actual,
        durationMs: this.clock.now() - startedAt
      };
    }
    throw error;
  }
}
```

Include imports with `.js` suffixes, constructor parameter properties, and explicit return types consistent with neighboring wait services.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run:

```bash
npm test -- test/application/runtime/activity-waiter.test.ts
npm run typecheck
npm run lint
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit the isolated waiter**

Before committing, inspect `git status`, `git diff`, and `git diff --cached`; stage only the two Task 1 files.

```bash
git add src/application/runtime/activity-waiter.ts \
  test/application/runtime/activity-waiter.test.ts
git commit -m "feat: add bounded launch Activity waiter"
```

---

### Task 2: Let Recorder Start After a Launch Redirect

**Files:**
- Modify: `src/application/recorder/recorder-service.ts:106-190`
- Modify: `test/application/recorder/recorder-service.test.ts`

**Interfaces:**
- Consumes: existing `IdleWaiter.waitUntilIdle(config, signal)`.
- Produces: Recorder startup that requires a live app process and stable layout, but not equality with `run.activity`.

- [ ] **Step 1: Add a failing redirect test**

Add a Recorder test that overrides the Activity sequence so the first recorded
checkpoint begins after Splash:

```ts
it("records from the stable Activity reached after launch", async () => {
  const runtime = runtimeFixture();
  vi.mocked(runtime.adb.currentActivity)
    .mockResolvedValueOnce("com.example.app.HomeActivity")
    .mockResolvedValueOnce("com.example.app.SearchActivity");
  const recorderPrompt = prompt(["click", "finish"]);
  const journeyWriter = writer();
  const service = new RecorderService({
    gradle: runtime.gradle,
    androidCli: runtime.androidCli,
    adb: runtime.adb,
    clock: runtime.dependencies.clock,
    prompt: recorderPrompt,
    journeyWriter
  });

  const result = await service.record({
    config: runtimeConfig,
    projectRoot: "/project",
    deviceSerial: "emulator-5554",
    journeyName: "Authenticated search",
    outputPath: "/project/journeys/search.json"
  });

  expect(result).toMatchObject({ status: "completed", stepsRecorded: 1 });
  expect(journeyWriter.journeys[0]?.steps[0]?.activity).toEqual({
    before: "com.example.app.HomeActivity",
    after: "com.example.app.SearchActivity"
  });
});
```

Add startup process and stability tests:

```ts
it("does not prompt when the App process is missing after launch", async () => {
  const runtime = runtimeFixture();
  vi.mocked(runtime.adb.pid).mockResolvedValueOnce(null);
  const recorderPrompt = prompt(["finish"]);
  const journeyWriter = writer();
  const service = new RecorderService({
    gradle: runtime.gradle,
    androidCli: runtime.androidCli,
    adb: runtime.adb,
    clock: runtime.dependencies.clock,
    prompt: recorderPrompt,
    journeyWriter
  });

  await expect(service.record({
    config: runtimeConfig,
    projectRoot: "/project",
    deviceSerial: "emulator-5554",
    journeyName: "Missing process",
    outputPath: "/project/missing.json"
  })).resolves.toEqual({
    status: "failed",
    stepsRecorded: 0,
    message: "App process was not found after launch"
  });
  expect(recorderPrompt.selectAction).not.toHaveBeenCalled();
});
```

For startup instability, configure `stablePolls: 2`, `timeoutMs: 100`, return a
non-empty `layoutDiff` on every poll, and assert the result is
`{ status: "failed", stepsRecorded: 0, message: "Layout did not become stable before timeout" }`
before any prompt.

- [ ] **Step 2: Run the Recorder tests and confirm RED**

Run:

```bash
npm test -- test/application/recorder/recorder-service.test.ts
```

Expected: redirect test fails with `App did not reach the configured launch Activity`; startup stability expectations also fail because no pre-prompt idle wait exists.

- [ ] **Step 3: Change Recorder startup readiness**

In `RecorderService.record`:

1. Keep `launchActivity` for `androidCli.runApp`.
2. After a successful run, construct the existing `identity`.
3. Check only `await adb.pid(identity)`.
4. Construct `IdleWaiter` before startup readiness.
5. Call `androidCli.layout(...)` once to establish the baseline.
6. Call `idleWaiter.waitUntilIdle(config.idle, signal)` before the prompt loop.
7. Return cancellation or the existing stable-layout timeout result as appropriate.
8. Remove the initial `currentActivity` equality check.
9. Reuse the same `IdleWaiter` for recorded actions.

The core replacement should have this shape:

```ts
if (await this.dependencies.adb.pid(identity) === null) {
  return {
    status: "failed",
    stepsRecorded: 0,
    message: "App process was not found after launch"
  };
}

const idleWaiter = new IdleWaiter(
  this.dependencies.androidCli,
  this.dependencies.clock,
  input.deviceSerial
);
await this.dependencies.androidCli.layout({
  deviceSerial: input.deviceSerial,
  ...(input.signal === undefined ? {} : { signal: input.signal }),
  timeoutMs: input.config.idle.timeoutMs
});
const startupIdle = await idleWaiter.waitUntilIdle(
  input.config.idle,
  input.signal
);
if (startupIdle.status === "cancelled") {
  return { status: "cancelled", stepsRecorded: 0 };
}
if (startupIdle.status === "timeout") {
  return {
    status: "failed",
    stepsRecorded: 0,
    message: "Layout did not become stable before timeout"
  };
}
```

- [ ] **Step 4: Run Recorder tests and validators**

Run:

```bash
npm test -- test/application/recorder/recorder-service.test.ts
npm run typecheck
npm run lint
```

Expected: all commands exit `0`. Update existing call-order fixtures only where
the new startup idle wait intentionally adds calls.

- [ ] **Step 5: Commit Recorder readiness**

Inspect status and staged diff; stage only Task 2 files:

```bash
git add src/application/recorder/recorder-service.ts \
  test/application/recorder/recorder-service.test.ts
git commit -m "fix: record after transient launch Activity"
```

---

### Task 3: Wait for the Journey's First Activity During Verify

**Files:**
- Modify: `src/application/runtime/verify-runtime.ts:240-305`
- Modify: `test/application/runtime/verify-runtime.test.ts`

**Interfaces:**
- Consumes: `ActivityWaiter` from Task 1 and `journey.steps[0].activity.before`.
- Produces: bounded Journey-driven launch readiness before baseline layout and `StepRunner`.

- [ ] **Step 1: Add failing Verify redirect tests**

Add a passing redirect test with this Activity sequence:

```ts
it("waits for the first Journey Activity after a launch redirect", async () => {
  const test = runtimeFixture();
  vi.mocked(test.adb.currentActivity)
    .mockResolvedValueOnce("com.example.app.SplashActivity")
    .mockResolvedValueOnce("com.example.app.MainActivity")
    .mockResolvedValueOnce("com.example.app.MainActivity")
    .mockResolvedValueOnce("com.example.app.SearchActivity");

  const result = await new VerifyRuntime(test.dependencies).verify(input());

  expect(result).toMatchObject({ status: "passed", exitCode: 0 });
  expect(test.dependencies.clock).toMatchObject({ sleeps: [100] });
});
```

Add a timeout test:

```ts
it("fails launch readiness when the first Journey Activity is not reached", async () => {
  const test = runtimeFixture();
  vi.mocked(test.adb.currentActivity)
    .mockResolvedValue("com.example.app.SplashActivity");

  const result = await new VerifyRuntime(test.dependencies).verify(input());

  expect(result).toMatchObject({
    status: "failed",
    exitCode: 1,
    report: {
      primaryFailure: {
        code: "APP_LAUNCH_FAILED",
        phase: "readiness"
      },
      steps: []
    }
  });
  expect(result.report.primaryFailure?.message)
    .toContain("com.example.app.MainActivity");
  expect(result.report.primaryFailure?.message)
    .toContain("com.example.app.SplashActivity");
});
```

Add a process-exit test where the initial PID check returns `42`, the waiter
sees `42` once, then sees `null`; assert `APP_LAUNCH_FAILED`, no baseline layout,
and no replay action.

- [ ] **Step 2: Run Verify tests and confirm RED**

Run:

```bash
npm test -- test/application/runtime/verify-runtime.test.ts
```

Expected: redirect test fails on the existing exact launch-Activity comparison,
and timeout/process-exit behavior is absent.

- [ ] **Step 3: Integrate `ActivityWaiter`**

Import `ActivityWaiter` with a `.js` suffix. After the initial PID is found and
Logcat is scoped, replace the exact Activity comparison with:

```ts
const firstStep = input.journey.steps[0];
if (firstStep === undefined) {
  throw new Error("Journey requires at least one step");
}
const readiness = await new ActivityWaiter(
  this.dependencies.adb,
  this.dependencies.clock
).wait({
  packageName: input.config.run.packageName,
  deviceSerial: input.deviceSerial,
  expectedActivity: firstStep.activity.before,
  pollIntervalMs: input.config.idle.pollIntervalMs,
  timeoutMs: input.config.idle.timeoutMs,
  ...(input.signal === undefined ? {} : { signal: input.signal })
});

if (readiness.status === "processMissing") {
  setPrimary(
    "APP_LAUNCH_FAILED",
    "App process exited before reaching the first Journey Activity",
    "readiness"
  );
} else if (readiness.status === "timeout") {
  setPrimary(
    "APP_LAUNCH_FAILED",
    `Expected startup Activity ${firstStep.activity.before}, found ${readiness.actual ?? "none"} before timeout`,
    "readiness"
  );
} else if (readiness.status === "cancelled") {
  setPrimary(
    "INTERNAL_ERROR",
    "Verification was cancelled",
    "readiness"
  );
} else {
  await this.dependencies.androidCli.layout({
    deviceSerial: input.deviceSerial,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    timeoutMs: input.config.idle.timeoutMs
  });
  layers.run = "passed";
  layers.structural = "passed";
  layers.activityCheckpoint = "passed";
  layers.explicitExpect = "passed";
}
```

Keep the initial PID check because it provides the PID used to scope Logcat.
Update existing orchestration-order assertions to include the waiter's PID and
Activity calls.

- [ ] **Step 4: Run Verify tests and validators**

Run:

```bash
npm test -- test/application/runtime/activity-waiter.test.ts \
  test/application/runtime/verify-runtime.test.ts
npm run typecheck
npm run lint
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit Verify readiness**

Inspect status and staged diff; stage only Task 3 files:

```bash
git add src/application/runtime/verify-runtime.ts \
  test/application/runtime/verify-runtime.test.ts
git commit -m "fix: wait for Journey launch readiness"
```

---

### Task 4: Run the Complete Quality Gate

**Files:**
- Verify only; no additional source files should be required.

**Interfaces:**
- Consumes: completed Recorder and Verify readiness behavior.
- Produces: release-quality validation evidence.

- [ ] **Step 1: Run the complete automated gate**

```bash
npm test
npm run typecheck
npm run lint
npm run build
test -x dist/cli/main.js
npm run brand:render
git diff --exit-code -- assets/brand/png
taphound --help
```

Expected: all commands exit `0`, all Vitest files pass, brand rendering produces
no diff, and CLI help lists `doctor`, `record`, and `verify`.

- [ ] **Step 2: Run the real Recorder smoke**

From the target Android project with device `36021JEHN12004`:

```bash
taphound record \
  --project . \
  --device 36021JEHN12004 \
  --name "Search Flow" \
  --output journeys/search.json
```

Expected: the App may redirect away from its configured Splash Activity,
TapHound waits for a stable layout, and the Recorder action menu appears instead
of `App did not reach the configured launch Activity`.

- [ ] **Step 3: Review final repository state**

```bash
git status
git diff
git log --oneline -5
```

Confirm no generated reports, screenshots, device data, or unrelated files are
included in the implementation commits.
