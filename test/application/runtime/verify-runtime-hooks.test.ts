import { describe, expect, it } from "vitest";

import {
  VerifyRuntime,
  type VerifyInput
} from "../../../src/application/runtime/verify-runtime.js";
import {
  runtimeConfig,
  runtimeFixture,
  runtimeJourney
} from "../../fakes/runtime-fixture.js";

function input(hooks?: NonNullable<VerifyInput["hooks"]>): VerifyInput {
  return {
    config: runtimeConfig,
    journey: runtimeJourney,
    projectRoot: "/project",
    devices: [{ role: "default", deviceSerial: "emulator-5554" }],
    toolVersions: { node: "24.3.0", adb: "1.0.41", android: "1.0.0" },
    ...(hooks === undefined ? {} : { hooks })
  };
}

describe("VerifyRuntime contract hooks", () => {
  it("keeps the run and its report identical when no hooks are configured", async () => {
    const plain = runtimeFixture();
    const plainResult = await new VerifyRuntime(plain.dependencies)
      .verify(input());

    const hooked = runtimeFixture();
    const hookedResult = await new VerifyRuntime(hooked.dependencies)
      .verify(input({
        beforeSteps: (): Promise<{ status: "passed" }> => Promise.resolve({ status: "passed" })
      }));

    expect(hookedResult.report).toEqual(plainResult.report);
    expect(hooked.order).toEqual(plain.order);
    expect(plainResult.hookOutcomes).toBeUndefined();
    expect(hookedResult.hookOutcomes).toEqual([{
      phase: "beforeSteps",
      deviceRole: "default",
      status: "passed"
    }]);
  });

  it("records hook outcomes without changing the report when the hook fails", async () => {
    const test = runtimeFixture();
    const result = await new VerifyRuntime(test.dependencies).verify(input({
      beforeSteps: (): Promise<{ status: "failed"; message: string }> => Promise.resolve({
        status: "failed",
        message: "precondition broke"
      })
    }));

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.report.status).toBe("passed");
    expect(result.report.primaryFailure).toBeUndefined();
    expect(result.hookOutcomes).toEqual([{
      phase: "beforeSteps",
      deviceRole: "default",
      status: "failed",
      message: "precondition broke"
    }]);
  });

  it("isolates a throwing hook into an unresolved outcome", async () => {
    const test = runtimeFixture();
    const result = await new VerifyRuntime(test.dependencies).verify(input({
      beforeSteps: (): Promise<{ status: "passed" }> => Promise.reject(
        new Error("hook exploded")
      )
    }));

    expect(result.status).toBe("passed");
    expect(result.report.status).toBe("passed");
    expect(result.report.secondaryErrors).toEqual([]);
    expect(result.hookOutcomes).toEqual([{
      phase: "beforeSteps",
      deviceRole: "default",
      status: "unresolved",
      message: "hook exploded"
    }]);
  });

  it("runs beforeSteps with the readiness snapshot and afterSteps with a fresh one", async () => {
    const test = runtimeFixture();
    const contexts: { phase: string; layoutCount: number }[] = [];
    const result = await new VerifyRuntime(test.dependencies).verify(input({
      beforeSteps: (context): Promise<{ status: "passed" }> => {
        contexts.push({ phase: "before", layoutCount: context.snapshot.roots.length });
        return Promise.resolve({ status: "passed" });
      },
      afterSteps: (context): Promise<{ status: "passed" }> => {
        contexts.push({ phase: "after", layoutCount: context.snapshot.roots.length });
        return Promise.resolve({ status: "passed" });
      }
    }));

    expect(result.status).toBe("passed");
    expect(contexts).toEqual([
      { phase: "before", layoutCount: 1 },
      { phase: "after", layoutCount: 1 }
    ]);
    expect(result.hookOutcomes).toEqual([
      { phase: "beforeSteps", deviceRole: "default", status: "passed" },
      { phase: "afterSteps", deviceRole: "default", status: "passed" }
    ]);
    const stepLayouts = test.order.filter((entry) => entry === "step-layout");
    expect(stepLayouts.length).toBe(3);
    expect(test.order.filter((entry) => entry === "baseline").length).toBe(1);
    expect(result.report.steps).toHaveLength(1);
  });
});