import { describe, expect, it } from "vitest";

import { SystemClock } from "../../../src/adapters/clock/system-clock.js";

describe("SystemClock", () => {
  it("uses a monotonic clock", () => {
    const clock = new SystemClock();
    const first = clock.now();
    const second = clock.now();

    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("honors an already aborted sleep", async () => {
    const clock = new SystemClock();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(clock.sleep(1000, controller.signal)).rejects.toThrow(
      "cancelled"
    );
  });
});
