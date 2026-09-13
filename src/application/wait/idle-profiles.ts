import type {
  DeviceIdleProfile
} from "../../domain/config.js";
import type {
  AdbPort,
  AppIdentity,
  DeviceIdentity
} from "../../ports/adb.js";

export type IdleStrategyName = "hybrid" | "layoutDiff" | "frameStats" | "structural";

export interface IdleSettings {
  strategy?: IdleStrategyName | undefined;
  pollIntervalMs: number;
  stablePolls: number;
  timeoutMs: number;
  ignoreCursorBlink?: boolean | undefined;
  ignoreLayoutDrift?: boolean | undefined;
}

function matchesDevice(
  profile: DeviceIdleProfile,
  identity: DeviceIdentity
): boolean {
  const match = profile.match;
  if (
    match.manufacturer !== undefined
    && match.manufacturer.toLowerCase() !== identity.manufacturer.toLowerCase()
  ) {
    return false;
  }
  if (
    match.model !== undefined
    && match.model.toLowerCase() !== identity.model.toLowerCase()
  ) {
    return false;
  }
  if (match.sdkLevel !== undefined && match.sdkLevel !== identity.sdkLevel) {
    return false;
  }
  return true;
}

export function resolveIdlePolicy(
  idle: IdleSettings & { deviceProfiles?: readonly DeviceIdleProfile[] | undefined },
  identity: DeviceIdentity | undefined
): IdleSettings {
  if (identity === undefined || idle.deviceProfiles === undefined) {
    return idle;
  }
  const matches = idle.deviceProfiles.filter(
    (profile) => matchesDevice(profile, identity)
  );
  if (matches.length === 0) {
    return idle;
  }
  const merged: IdleSettings = {
    strategy: idle.strategy,
    pollIntervalMs: idle.pollIntervalMs,
    stablePolls: idle.stablePolls,
    timeoutMs: idle.timeoutMs,
    ...(idle.ignoreCursorBlink === undefined
      ? {}
      : { ignoreCursorBlink: idle.ignoreCursorBlink }),
    ...(idle.ignoreLayoutDrift === undefined
      ? {}
      : { ignoreLayoutDrift: idle.ignoreLayoutDrift })
  };
  for (const profile of matches) {
    if (profile.ignoreCursorBlink !== undefined) {
      merged.ignoreCursorBlink = profile.ignoreCursorBlink;
    }
    if (profile.ignoreLayoutDrift !== undefined) {
      merged.ignoreLayoutDrift = profile.ignoreLayoutDrift;
    }
    if (profile.strategy !== undefined) {
      merged.strategy = profile.strategy;
    }
    if (profile.pollIntervalMs !== undefined) {
      merged.pollIntervalMs = profile.pollIntervalMs;
    }
    if (profile.stablePolls !== undefined) {
      merged.stablePolls = profile.stablePolls;
    }
    if (profile.timeoutMs !== undefined) {
      merged.timeoutMs = profile.timeoutMs;
    }
  }
  return merged;
}

export function deviceIdentityResolver(
  adb: Pick<AdbPort, "deviceIdentity">,
  identity: Omit<AppIdentity, "signal">
): () => Promise<DeviceIdentity | undefined> {
  return (): Promise<DeviceIdentity | undefined> => {
    const current = adb.deviceIdentity;
    if (current === undefined) {
      return Promise.resolve(undefined);
    }
    const requested = { ...identity };
    return current(requested).catch((): undefined => undefined);
  };
}