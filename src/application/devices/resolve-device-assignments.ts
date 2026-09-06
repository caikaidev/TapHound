import type { FailureCode } from "../../domain/failure.js";

export interface DeviceAssignment {
  role: string;
  deviceSerial: string;
}

export type DeviceAssignmentFailureCode = Extract<
  FailureCode,
  "CONFIG_INVALID" | "DEVICE_UNAVAILABLE" | "DEVICE_ROLE_UNMAPPED"
>;

export type DeviceAssignmentResolution =
  | { ok: true; assignments: DeviceAssignment[] }
  | {
      ok: false;
      code: DeviceAssignmentFailureCode;
      message: string;
      missingRoles?: string[];
    };

export interface ResolveDeviceAssignmentsInput {
  declaredRoles: readonly string[];
  explicit: readonly DeviceAssignment[];
  onlineSerials: readonly string[];
}

function failure(
  code: DeviceAssignmentFailureCode,
  message: string,
  missingRoles?: string[]
): DeviceAssignmentResolution {
  return {
    ok: false,
    code,
    message,
    ...(missingRoles === undefined ? {} : { missingRoles })
  };
}

export function resolveDeviceAssignments(
  input: ResolveDeviceAssignmentsInput
): DeviceAssignmentResolution {
  const { declaredRoles, explicit, onlineSerials } = input;

  const duplicateRole = explicit.find((mapping, index) => explicit.some(
    (other, otherIndex) => otherIndex > index && other.role === mapping.role
  ));
  if (duplicateRole !== undefined) {
    return failure(
      "CONFIG_INVALID",
      `Duplicate --device mapping for role: ${duplicateRole.role}`
    );
  }

  const unknownRole = explicit.find(
    (mapping) => !declaredRoles.includes(mapping.role)
  );
  if (unknownRole !== undefined) {
    return failure(
      "CONFIG_INVALID",
      `Device role is not declared by the journey: ${unknownRole.role}`
    );
  }

  const reusedSerial = explicit.find((mapping, index) => explicit.some(
    (other, otherIndex) => otherIndex > index
      && other.deviceSerial === mapping.deviceSerial
  ));
  if (reusedSerial !== undefined) {
    return failure(
      "CONFIG_INVALID",
      `Device serial is mapped to multiple roles: ${reusedSerial.deviceSerial}`
    );
  }

  const online = new Set(onlineSerials);
  const offlineSerial = explicit.find(
    (mapping) => !online.has(mapping.deviceSerial)
  );
  if (offlineSerial !== undefined) {
    return failure(
      "DEVICE_UNAVAILABLE",
      `Requested device is not online: ${offlineSerial.deviceSerial}`
    );
  }

  if (explicit.length === 0) {
    if (declaredRoles.length > 1) {
      return failure(
        "DEVICE_ROLE_UNMAPPED",
        `Journey declares multiple devices; map each role with --device <role>=<serial> for: ${declaredRoles.join(", ")}`,
        [...declaredRoles]
      );
    }
    if (onlineSerials.length !== 1) {
      return failure(
        "DEVICE_UNAVAILABLE",
        `Expected exactly one online device, found ${String(onlineSerials.length)}`
      );
    }
    const autoSerial = onlineSerials[0];
    const autoRole = declaredRoles[0];
    if (autoSerial === undefined || autoRole === undefined) {
      return failure(
        "DEVICE_UNAVAILABLE",
        "Expected exactly one online device, found 1"
      );
    }
    return {
      ok: true,
      assignments: [{ role: autoRole, deviceSerial: autoSerial }]
    };
  }

  const explicitRoles = new Set(explicit.map((mapping) => mapping.role));
  const missingRoles = declaredRoles.filter((role) => !explicitRoles.has(role));
  if (missingRoles.length > 0) {
    return failure(
      "DEVICE_ROLE_UNMAPPED",
      `No device mapping for journey role(s): ${missingRoles.join(", ")}`,
      missingRoles
    );
  }

  return {
    ok: true,
    assignments: declaredRoles.flatMap((role) => {
      const mapping = explicit.find((entry) => entry.role === role);
      return mapping === undefined
        ? []
        : [{ role, deviceSerial: mapping.deviceSerial }];
    })
  };
}
