import { describe, expect, it } from "vitest";

import {
  idleTimeoutAdvice,
  withIdleAdvice
} from "../../../src/application/wait/idle-advice.js";
import type { IdleTimeoutResult } from "../../../src/application/wait/idle-advice.js";

function timeout(
  overrides: Partial<IdleTimeoutResult> = {}
): IdleTimeoutResult {
  return {
    status: "timeout",
    code: "IDLE_TIMEOUT",
    polls: 4,
    durationMs: 1000,
    lastDiff: [],
    strategy: "hybrid",
    fallbackUsed: false,
    frameActivityDetected: false,
    samplingDurationMs: 400,
    ...overrides
  };
}

describe("idleTimeoutAdvice", () => {
  it("recommends layoutDiff when frame activity never settles", () => {
    const advice = idleTimeoutAdvice(timeout({
      strategy: "hybrid",
      frameActivityDetected: true
    }));

    expect(advice).toContain("frame activity never settled");
    expect(advice).toContain("\"layoutDiff\"");
  });

  it("recommends waiting or layoutDiff when layout keeps changing", () => {
    const advice = idleTimeoutAdvice(timeout({
      lastDiff: [{ resource: "com.example.app:id/progress" }]
    }));

    expect(advice).toContain("layout differences kept appearing");
    expect(advice).toContain("idle.timeoutMs");
    expect(advice).toContain("\"layoutDiff\"");
  });

  it("recommends a larger budget when captures consume the idle window", () => {
    const advice = idleTimeoutAdvice(timeout({
      polls: 2,
      durationMs: 1000,
      samplingDurationMs: 850
    }));

    expect(advice).toContain("UI snapshot captures consumed most of the idle budget");
    expect(advice).toContain("idle.timeoutMs");
    expect(advice).toContain("ui.snapshotTimeoutMs");
  });

  it("recommends poll tuning when the budget ends before stable polls", () => {
    const advice = idleTimeoutAdvice(timeout({
      polls: 3,
      durationMs: 1000,
      samplingDurationMs: 300
    }));

    expect(advice).toContain("no layout change was detected");
    expect(advice).toContain("idle.stablePolls");
    expect(advice).toContain("pollIntervalMs");
  });

  it("appends the advice to the base failure message", () => {
    const message = withIdleAdvice(
      "Layout did not become stable before timeout",
      timeout({ frameActivityDetected: true })
    );

    expect(message).toMatch(/^Layout did not become stable before timeout \(/);
    expect(message).toMatch(/\)$/);
  });
});
