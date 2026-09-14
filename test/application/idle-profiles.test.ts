import { describe, expect, it, vi } from "vitest";

import {
  deviceIdentityResolver,
  resolveIdlePolicy
} from "../../src/application/wait/idle-profiles.js";
import type { DeviceIdentity } from "../../src/ports/adb.js";

const identity: DeviceIdentity = {
  manufacturer: "samsung",
  model: "SM-A5560",
  sdkLevel: 34
};

const baseIdle = {
  strategy: "hybrid" as const,
  pollIntervalMs: 200,
  stablePolls: 2,
  timeoutMs: 10000
};

describe("resolveIdlePolicy", () => {
  it("returns the policy unchanged without identity or profiles", () => {
    expect(resolveIdlePolicy(baseIdle, undefined)).toEqual(baseIdle);
    expect(resolveIdlePolicy(baseIdle, identity)).toEqual(baseIdle);
  });

  it("applies a matching manufacturer profile", () => {
    const merged = resolveIdlePolicy({
      ...baseIdle,
      deviceProfiles: [{
        match: { manufacturer: "Samsung" },
        ignoreCursorBlink: true,
        strategy: "frameStats",
        timeoutMs: 15000
      }]
    }, identity);
    expect(merged).toMatchObject({
      strategy: "frameStats",
      timeoutMs: 15000,
      ignoreCursorBlink: true
    });
    expect(merged.pollIntervalMs).toBe(200);
  });

  it("matches model and sdkLevel together", () => {
    const merged = resolveIdlePolicy({
      ...baseIdle,
      deviceProfiles: [{
        match: { model: "sm-a5560", sdkLevel: 34 },
        ignoreCursorBlink: true
      }]
    }, identity);
    expect(merged.ignoreCursorBlink).toBe(true);
  });

  it("keeps the policy when no profile matches", () => {
    const merged = resolveIdlePolicy({
      ...baseIdle,
      deviceProfiles: [{
        match: { manufacturer: "google" },
        ignoreCursorBlink: true
      }]
    }, identity);
    expect(merged.ignoreCursorBlink).toBeUndefined();
    expect(merged.strategy).toBe("hybrid");
  });

  it("lets later profiles override earlier matches", () => {
    const merged = resolveIdlePolicy({
      ...baseIdle,
      deviceProfiles: [
        { match: { manufacturer: "samsung" }, timeoutMs: 15000 },
        { match: { model: "SM-A5560" }, timeoutMs: 20000 }
      ]
    }, identity);
    expect(merged.timeoutMs).toBe(20000);
  });

  it("resolves a device identity through the adb port and swallows errors", async () => {
    const resolve = deviceIdentityResolver({
      deviceIdentity: vi.fn(() => Promise.resolve(identity))
    }, {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      timeoutMs: 5000
    });
    await expect(resolve()).resolves.toEqual(identity);
  });

  it("preserves the receiver for a stateful adb port", async () => {
    const adb = {
      marker: "bound",
      deviceIdentity(): Promise<DeviceIdentity> {
        if (this.marker !== "bound") {
          throw new Error("deviceIdentity lost its receiver");
        }
        return Promise.resolve(identity);
      }
    };
    const resolve = deviceIdentityResolver(adb, {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    });

    await expect(resolve()).resolves.toEqual(identity);
  });

  it("resolves undefined when the adb port lacks deviceIdentity", async () => {
    const resolve = deviceIdentityResolver({}, {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      timeoutMs: 5000
    });
    await expect(resolve()).resolves.toBeUndefined();
  });

  it("resolves undefined when the lookup fails", async () => {
    const resolve = deviceIdentityResolver({
      deviceIdentity: vi.fn(() => Promise.reject(new Error("adb down")))
    }, {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      timeoutMs: 5000
    });
    await expect(resolve()).resolves.toBeUndefined();
  });
});