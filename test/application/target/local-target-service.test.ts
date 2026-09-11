import { describe, expect, it, vi } from "vitest";

import { LocalTargetService } from "../../../src/application/target/local-target-service.js";

describe("LocalTargetService", () => {
  it("builds a TapHoundConfig from a target entry with defaults", () => {
    const service = new LocalTargetService({
      identityStore: {
        readIdentity: vi.fn(() => Promise.resolve(null)),
        writeIdentity: vi.fn(() => Promise.resolve()),
        ensureWorkspace: vi.fn(() => Promise.resolve())
      },
      fingerprint: vi.fn(() => Promise.resolve({ hash: "a".repeat(64) }))
    });
    const config = service.configForTarget({
      entry: { run: { packageName: "com.example.app" } } as never,
      resolvedPath: "/real/app",
      workspaceRoot: "/ws"
    });
    expect(config.run.packageName).toBe("com.example.app");
    expect(config.run.activity).toBe(".MainActivity");
    expect(config.idle.strategy).toBe("hybrid");
    expect(config.artifactsDir).toBe("/ws/runs");
  });

  it("honors an explicit per-target idle policy", () => {
    const service = new LocalTargetService({
      identityStore: {
        readIdentity: vi.fn(() => Promise.resolve(null)),
        writeIdentity: vi.fn(() => Promise.resolve()),
        ensureWorkspace: vi.fn(() => Promise.resolve())
      },
      fingerprint: vi.fn(() => Promise.resolve({ hash: "a".repeat(64) }))
    });
    const config = service.configForTarget({
      entry: {
        run: { packageName: "com.example.app" },
        idle: { strategy: "layoutDiff", pollIntervalMs: 300, stablePolls: 2, timeoutMs: 8000 }
      } as never,
      resolvedPath: "/real/app",
      workspaceRoot: "/ws"
    });
    expect(config.idle.strategy).toBe("layoutDiff");
    expect(config.idle.pollIntervalMs).toBe(300);
  });
});