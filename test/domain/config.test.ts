import { describe, expect, it } from "vitest";

import { AprConfigSchema } from "../../src/domain/config.js";

const validConfig = {
  version: 1,
  build: { task: ":app:assembleDebug" },
  artifact: { target: "app", variant: "debug" },
  run: {
    packageName: "com.example.app",
    activity: ".MainActivity"
  },
  idle: {
    pollIntervalMs: 200,
    stablePolls: 2,
    timeoutMs: 5000
  },
  artifactsDir: ".apr/runs"
};

describe("AprConfigSchema", () => {
  it("accepts the approved version 1 configuration", () => {
    expect(AprConfigSchema.parse(validConfig)).toEqual(validConfig);
  });

  it("requires a package name", () => {
    const config = structuredClone(validConfig);
    Reflect.deleteProperty(config.run, "packageName");

    expect(() => AprConfigSchema.parse(config)).toThrow();
  });

  it("rejects unsupported versions", () => {
    expect(() => AprConfigSchema.parse({ ...validConfig, version: 2 })).toThrow();
  });

  it.each(["pollIntervalMs", "stablePolls", "timeoutMs"] as const)(
    "requires a positive %s",
    (field) => {
      const config = structuredClone(validConfig);
      config.idle[field] = 0;

      expect(() => AprConfigSchema.parse(config)).toThrow();
    }
  );

  it("rejects unknown fields instead of silently ignoring them", () => {
    expect(() => AprConfigSchema.parse({ ...validConfig, device: "first" })).toThrow();
  });
});
