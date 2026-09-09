import { describe, expect, it } from "vitest";

import {
  FakeRuntimeBackend,
  FakeRuntimeSession
} from "../../../src/adapters/runtime/fake-runtime-backend.js";
import { SharedSessionRuntimeBackend } from "../../../src/adapters/runtime/shared-session-runtime-backend.js";
import type { RuntimeBackend } from "../../../src/ports/runtime-backend.js";

describe("SharedSessionRuntimeBackend", () => {
  it("exposes the wrapped descriptor, capabilities, and device list", async () => {
    const inner = new FakeRuntimeBackend();
    const backend = new SharedSessionRuntimeBackend(inner);

    expect(backend.descriptor).toBe(inner.descriptor);
    expect(backend.capabilities).toEqual(inner.capabilities);
    await expect(backend.listDevices()).resolves.toBe(inner.devices);
  });

  it("memoizes one session per device serial", async () => {
    const inner = new FakeRuntimeBackend();
    const backend = new SharedSessionRuntimeBackend(inner);

    const first = await backend.openSession({ deviceSerial: "emulator-5554" });
    const second = await backend.openSession({ deviceSerial: "emulator-5554" });
    const other = await backend.openSession({ deviceSerial: "emulator-5556" });

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(inner.openCalls).toEqual([
      { deviceSerial: "emulator-5554" },
      { deviceSerial: "emulator-5556" }
    ]);
  });

  it("evicts a failed session open so a retry can recover", async () => {
    const fake = new FakeRuntimeBackend();
    let failures = 0;
    let calls = 0;
    const inner: RuntimeBackend = {
      descriptor: fake.descriptor,
      capabilities: fake.capabilities,
      listDevices: () => Promise.resolve(fake.devices),
      openSession: (options) => {
        calls += 1;
        failures += 1;
        if (failures === 1) {
          return Promise.reject(new Error("connection refused"));
        }
        return Promise.resolve(new FakeRuntimeSession({
          descriptor: fake.descriptor,
          deviceSerial: options.deviceSerial
        }));
      }
    };
    const backend = new SharedSessionRuntimeBackend(inner);

    await expect(backend.openSession({ deviceSerial: "emulator-5554" }))
      .rejects.toThrow("connection refused");
    const session = await backend.openSession({ deviceSerial: "emulator-5554" });
    expect(session.descriptor.id).toBe("adb");
    expect(calls).toBe(2);
  });

  it("closes every memoized session on close", async () => {
    const inner = new FakeRuntimeBackend();
    const backend = new SharedSessionRuntimeBackend(inner);
    await backend.openSession({ deviceSerial: "emulator-5554" });
    await backend.openSession({ deviceSerial: "emulator-5556" });

    await backend.close();

    expect(inner.sessions.map((session) => session.calls)).toEqual([
      expect.arrayContaining(["close"]),
      expect.arrayContaining(["close"])
    ]);
    await backend.openSession({ deviceSerial: "emulator-5554" });
    expect(inner.openCalls).toHaveLength(3);
    expect(inner.sessions[2]?.calls).not.toContain("close");
  });
});
