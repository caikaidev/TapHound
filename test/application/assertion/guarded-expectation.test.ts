import { describe, expect, it, vi } from "vitest";

import {
  GuardedExpectationObservations,
  settledExpectationForeground
} from "../../../src/application/assertion/guarded-expectation.js";
import type { LayoutElement } from "../../../src/domain/layout.js";

const settledLayout: readonly LayoutElement[] = [
  { id: "settled", resourceId: "settled", enabled: true, children: [] }
];
const liveLayout: readonly LayoutElement[] = [
  { id: "live", resourceId: "live", enabled: true, children: [] }
];

class Cancelled extends Error {}

describe("GuardedExpectationObservations", () => {
  it("reuses the settled Layout once, then observes live", async () => {
    const layout = vi.fn(
      (): Promise<{ layout: readonly LayoutElement[] }> => (
        Promise.resolve({ layout: liveLayout })
      )
    );
    const observations = new GuardedExpectationObservations(
      { activity: (): Promise<string> => Promise.resolve("Main"), layout },
      { layout: settledLayout }
    );
    const boundary = observations.boundary();

    await expect(boundary.layout?.({ timeoutMs: 10 }))
      .resolves.toEqual({ status: "observed", layout: settledLayout });
    expect(layout).not.toHaveBeenCalled();
    await expect(boundary.layout?.({ timeoutMs: 10 }))
      .resolves.toEqual({ status: "observed", layout: liveLayout });
    expect(observations.lastLayoutObservation()).toEqual({ layout: liveLayout });
  });

  it("turns a guard violation into a failed observation", async () => {
    const boundary = new GuardedExpectationObservations({
      activity: (): Promise<string> => Promise.reject(new Error("foreground changed")),
      layout: (): Promise<{ layout: readonly LayoutElement[] }> => Promise.reject(new Error("process changed"))
    }).boundary();

    await expect(boundary.activity?.({ timeoutMs: 10 }))
      .resolves.toEqual({ status: "failed", message: "foreground changed" });
    await expect(boundary.layout?.({ timeoutMs: 10 }))
      .resolves.toEqual({ status: "failed", message: "process changed" });
  });

  it("propagates errors the engine marks as control flow", async () => {
    const boundary = new GuardedExpectationObservations({
      activity: (): Promise<string> => Promise.reject(new Cancelled("cancelled")),
      layout: (): Promise<{ layout: readonly LayoutElement[] }> => Promise.resolve({ layout: liveLayout }),
      rethrow: (error): boolean => error instanceof Cancelled
    }).boundary();

    await expect(boundary.activity?.({ timeoutMs: 10 }))
      .rejects.toBeInstanceOf(Cancelled);
  });
});

describe("settledExpectationForeground", () => {
  it("treats screen expectations as proof and log expectations as none", () => {
    expect(settledExpectationForeground(
      { type: "activity", value: "Detail", timeoutMs: 10 },
      "Main"
    )).toEqual({ activity: "Detail", proven: true });
    expect(settledExpectationForeground(
      { type: "element", locator: { resourceId: "ok" }, timeoutMs: 10 },
      "Main"
    )).toEqual({ activity: "Main", proven: true });
    expect(settledExpectationForeground(
      { type: "logcat", tag: "App", pattern: "ready", match: "literal", timeoutMs: 10 },
      "Main"
    )).toEqual({ activity: "Main", proven: false });
  });
});
