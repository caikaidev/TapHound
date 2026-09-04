import { describe, expect, it } from "vitest";

import {
  resolveDeviceAssignments,
  type DeviceAssignment
} from "../../../src/application/devices/resolve-device-assignments.js";

describe("resolveDeviceAssignments", () => {
  it("auto-maps the only online device for a single-role journey", () => {
    const result = resolveDeviceAssignments({
      declaredRoles: ["default"],
      explicit: [],
      onlineSerials: ["emulator-5554"]
    });

    expect(result).toEqual({
      ok: true,
      assignments: [{ role: "default", deviceSerial: "emulator-5554" }]
    });
  });

  it("fails with DEVICE_UNAVAILABLE when no mapping is given and the online device count is ambiguous", () => {
    for (const onlineSerials of [[], ["emu-1", "emu-2"]]) {
      const result = resolveDeviceAssignments({
        declaredRoles: ["default"],
        explicit: [],
        onlineSerials
      });

      expect(result).toEqual({
        ok: false,
        code: "DEVICE_UNAVAILABLE",
        message: `Expected exactly one online device, found ${String(onlineSerials.length)}`
      });
    }
  });

  it("fails with DEVICE_ROLE_UNMAPPED for a multi-role journey without explicit mappings", () => {
    const result = resolveDeviceAssignments({
      declaredRoles: ["sender", "receiver"],
      explicit: [],
      onlineSerials: ["emu-1", "emu-2"]
    });

    expect(result).toEqual({
      ok: false,
      code: "DEVICE_ROLE_UNMAPPED",
      message: "Journey declares multiple devices; map each role with --device <role>=<serial> for: sender, receiver",
      missingRoles: ["sender", "receiver"]
    });
  });

  it("maps explicit assignments in journey declaration order", () => {
    const result = resolveDeviceAssignments({
      declaredRoles: ["sender", "receiver"],
      explicit: [
        { role: "receiver", deviceSerial: "emu-2" },
        { role: "sender", deviceSerial: "emu-1" }
      ],
      onlineSerials: ["emu-1", "emu-2"]
    });

    expect(result).toEqual({
      ok: true,
      assignments: [
        { role: "sender", deviceSerial: "emu-1" },
        { role: "receiver", deviceSerial: "emu-2" }
      ]
    });
  });

  it("rejects duplicate explicit mappings for the same role", () => {
    const result = resolveDeviceAssignments({
      declaredRoles: ["sender", "receiver"],
      explicit: [
        { role: "sender", deviceSerial: "emu-1" },
        { role: "sender", deviceSerial: "emu-2" },
        { role: "receiver", deviceSerial: "emu-3" }
      ],
      onlineSerials: ["emu-1", "emu-2", "emu-3"]
    });

    expect(result).toEqual({
      ok: false,
      code: "CONFIG_INVALID",
      message: "Duplicate --device mapping for role: sender"
    });
  });

  it("rejects an explicit mapping for a role the journey does not declare", () => {
    const result = resolveDeviceAssignments({
      declaredRoles: ["default"],
      explicit: [{ role: "sender", deviceSerial: "emu-1" }],
      onlineSerials: ["emu-1"]
    });

    expect(result).toEqual({
      ok: false,
      code: "CONFIG_INVALID",
      message: "Device role is not declared by the journey: sender"
    });
  });

  it("rejects the same serial mapped to multiple roles", () => {
    const result = resolveDeviceAssignments({
      declaredRoles: ["sender", "receiver"],
      explicit: [
        { role: "sender", deviceSerial: "emu-1" },
        { role: "receiver", deviceSerial: "emu-1" }
      ],
      onlineSerials: ["emu-1"]
    });

    expect(result).toEqual({
      ok: false,
      code: "CONFIG_INVALID",
      message: "Device serial is mapped to multiple roles: emu-1"
    });
  });

  it("rejects an explicit serial that is not online", () => {
    const result = resolveDeviceAssignments({
      declaredRoles: ["default"],
      explicit: [{ role: "default", deviceSerial: "emu-9" }],
      onlineSerials: ["emu-1"]
    });

    expect(result).toEqual({
      ok: false,
      code: "DEVICE_UNAVAILABLE",
      message: "Requested device is not online: emu-9"
    });
  });

  it("names only the missing roles when explicit mappings cover a subset", () => {
    const result = resolveDeviceAssignments({
      declaredRoles: ["sender", "receiver", "observer"],
      explicit: [
        { role: "sender", deviceSerial: "emu-1" },
        { role: "observer", deviceSerial: "emu-3" }
      ],
      onlineSerials: ["emu-1", "emu-3"]
    });

    expect(result).toEqual({
      ok: false,
      code: "DEVICE_ROLE_UNMAPPED",
      message: "No device mapping for journey role(s): receiver",
      missingRoles: ["receiver"]
    });
  });

  it("accepts unused online devices when explicit mappings are complete", () => {
    const result = resolveDeviceAssignments({
      declaredRoles: ["default"],
      explicit: [{ role: "default", deviceSerial: "emu-2" }],
      onlineSerials: ["emu-1", "emu-2", "emu-3"]
    });

    expect(result).toEqual({
      ok: true,
      assignments: [{ role: "default", deviceSerial: "emu-2" }]
    });
  });

  it("uses structural typing for assignment inputs", () => {
    const explicit: DeviceAssignment[] = [
      { role: "default", deviceSerial: "emu-1" }
    ];
    const result = resolveDeviceAssignments({
      declaredRoles: ["default"],
      explicit,
      onlineSerials: ["emu-1"]
    });

    expect(result.ok).toBe(true);
  });
});
