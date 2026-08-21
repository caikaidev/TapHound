import { describe, expect, it } from "vitest";

import { TapHoundConfigSchema } from "../../src/domain/config.js";
import {
  DEFAULT_ARTIFACTS_DIR,
  assertArtifactDirectory
} from "../../src/domain/workspace.js";

const validConfig = {
  version: 1,
  run: {
    packageName: "com.example.app",
    activity: ".MainActivity"
  },
  idle: {
    strategy: "hybrid" as const,
    pollIntervalMs: 200,
    stablePolls: 2,
    timeoutMs: 5000
  },
  artifactsDir: ".taphound/build/runs"
};

describe("TapHoundConfigSchema", () => {
  it("accepts the approved version 1 configuration", () => {
    expect(TapHoundConfigSchema.parse(validConfig)).toEqual(validConfig);
  });

  it("defaults the idle strategy to hybrid", () => {
    const config = structuredClone(validConfig);
    Reflect.deleteProperty(config.idle, "strategy");

    expect(TapHoundConfigSchema.parse(config).idle.strategy).toBe("hybrid");
  });

  it.each(["hybrid", "layoutDiff", "frameStats"] as const)(
    "accepts the %s idle strategy",
    (strategy) => {
      expect(TapHoundConfigSchema.parse({
        ...validConfig,
        idle: { ...validConfig.idle, strategy }
      }).idle.strategy).toBe(strategy);
    }
  );

  it("rejects an unknown idle strategy", () => {
    expect(() => TapHoundConfigSchema.parse({
      ...validConfig,
      idle: { ...validConfig.idle, strategy: "eventQueue" }
    })).toThrow();
  });

  it("requires a package name", () => {
    const config = structuredClone(validConfig);
    Reflect.deleteProperty(config.run, "packageName");

    expect(() => TapHoundConfigSchema.parse(config)).toThrow();
  });

  it("rejects unsupported versions", () => {
    expect(() => TapHoundConfigSchema.parse({ ...validConfig, version: 2 })).toThrow();
  });

  it.each(["pollIntervalMs", "stablePolls", "timeoutMs"] as const)(
    "requires a positive %s",
    (field) => {
      const config = structuredClone(validConfig);
      config.idle[field] = 0;

      expect(() => TapHoundConfigSchema.parse(config)).toThrow();
    }
  );

  it("defaults artifactsDir to the ephemeral build runs directory", () => {
    const config = structuredClone(validConfig);
    Reflect.deleteProperty(config, "artifactsDir");

    expect(TapHoundConfigSchema.parse(config).artifactsDir).toBe(
      DEFAULT_ARTIFACTS_DIR
    );
    expect(DEFAULT_ARTIFACTS_DIR).toBe(".taphound/build/runs");
  });

  it("keeps an explicit artifactsDir override", () => {
    expect(TapHoundConfigSchema.parse({
      ...validConfig,
      artifactsDir: "/tmp/taphound-runs"
    }).artifactsDir).toBe("/tmp/taphound-runs");
  });

  it.each([
    ".taphound",
    ".taphound/runs",
    ".taphound/journeys/runs",
    "./other/../.taphound/reports",
    ".taphound\\reports"
  ])("rejects report artifacts in the authoritative workspace at %s", (
    artifactsDir
  ) => {
    expect(() => TapHoundConfigSchema.parse({
      ...validConfig,
      artifactsDir
    })).toThrow(/must stay under \.taphound\/build/);
  });

  it.each([
    ".taphound/build",
    ".taphound/build/runs",
    "reports",
    "../shared-taphound-reports",
    "/tmp/taphound-runs"
  ])("accepts artifact output outside authority paths at %s", (artifactsDir) => {
    expect(TapHoundConfigSchema.parse({
      ...validConfig,
      artifactsDir
    }).artifactsDir).toBe(artifactsDir);
  });

  it("rejects an absolute artifact override into project authority paths", () => {
    expect(() => {
      assertArtifactDirectory(
        "/project",
        "/project/.taphound/journeys/reports"
      );
    }).toThrow(/must stay under \.taphound\/build/);
    expect(() => {
      assertArtifactDirectory(
        "/project",
        "/project/.taphound/build/custom-runs"
      );
    }).not.toThrow();
  });

  it("rejects an empty artifactsDir instead of falling back", () => {
    expect(() => TapHoundConfigSchema.parse({
      ...validConfig,
      artifactsDir: "   "
    })).toThrow();
  });

  it("rejects unknown fields instead of silently ignoring them", () => {
    expect(() => TapHoundConfigSchema.parse({ ...validConfig, device: "first" })).toThrow();
  });
});
