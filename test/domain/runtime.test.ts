import { describe, expect, it } from "vitest";

import {
  RuntimeBackendChoiceSchema,
  RuntimeBackendDescriptorSchema,
  RuntimeBackendIdSchema,
  RuntimeCapabilitiesSchema,
  resolveRuntimeBackendId
} from "../../src/domain/runtime.js";

const validCapabilities = {
  layoutSnapshot: true,
  screenshot: true,
  annotatedScreens: true,
  frameStatsIdle: true,
  logs: true,
  processDiscovery: true,
  windowTopology: true,
  intentStart: true,
  foregroundActivity: true
};

const validDescriptor = {
  id: "adb",
  adapterVersion: "adb-runtime-v1",
  configSha256: "a".repeat(64),
  capabilities: validCapabilities
};

describe("runtime backend domain schema", () => {
  it("accepts every backend id and the full choice surface", () => {
    for (const id of ["adb", "mobile-mcp"] as const) {
      expect(RuntimeBackendIdSchema.parse(id)).toBe(id);
    }
    for (const choice of ["auto", "adb", "mobile-mcp"] as const) {
      expect(RuntimeBackendChoiceSchema.parse(choice)).toBe(choice);
    }
  });

  it("rejects unknown backend ids and choices", () => {
    expect(() => RuntimeBackendIdSchema.parse("appium")).toThrow();
    expect(() => RuntimeBackendChoiceSchema.parse("maestro")).toThrow();
  });

  it("resolves every choice deterministically", () => {
    expect(resolveRuntimeBackendId("auto")).toBe("adb");
    expect(resolveRuntimeBackendId("adb")).toBe("adb");
    expect(resolveRuntimeBackendId("mobile-mcp")).toBe("mobile-mcp");
  });

  it("round-trips a valid descriptor", () => {
    expect(RuntimeBackendDescriptorSchema.parse(validDescriptor))
      .toEqual(validDescriptor);
  });

  it("rejects a malformed descriptor hash and unknown ids", () => {
    expect(() => RuntimeBackendDescriptorSchema.parse({
      ...validDescriptor,
      configSha256: "not-a-hash"
    })).toThrow();
    expect(() => RuntimeBackendDescriptorSchema.parse({
      ...validDescriptor,
      id: "appium"
    })).toThrow();
  });

  it("rejects incomplete or unknown capability declarations", () => {
    expect(() => RuntimeCapabilitiesSchema.parse({
      ...validCapabilities,
      foregroundActivity: undefined
    })).toThrow();
    expect(() => RuntimeCapabilitiesSchema.parse({
      ...validCapabilities,
      touchInjection: true
    })).toThrow();
  });
});
