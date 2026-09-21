import { randomUUID } from "node:crypto";

import type { ProcessRunner } from "../../ports/process-runner.js";

export const DEVICE_LAYOUT_TEMP_PREFIX = "/data/local/tmp/taphound-uiautomator-";
export const DEVICE_LAYOUT_TEMP_GLOB = `${DEVICE_LAYOUT_TEMP_PREFIX}*.xml`;

export const DEVICE_LAYOUT_TEMP_SWEEP_TIMEOUT_MS = 5000;

export function createDeviceLayoutPath(): string {
  return `${DEVICE_LAYOUT_TEMP_PREFIX}${randomUUID()}.xml`;
}

export async function sweepDeviceLayoutTemp(
  runner: ProcessRunner,
  deviceSerial: string,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted === true) {
    return;
  }
  await runner.run({
    executable: "adb",
    args: ["-s", deviceSerial, "shell", "rm", "-f", DEVICE_LAYOUT_TEMP_GLOB],
    timeoutMs: DEVICE_LAYOUT_TEMP_SWEEP_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal })
  }).catch((): undefined => undefined);
}
