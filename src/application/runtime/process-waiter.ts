import {
  appProcessPids,
  primaryAppPid
} from "../../domain/app-process.js";
import type { AdbPort } from "../../ports/adb.js";
import type { Clock } from "../../ports/clock.js";

export interface ProcessWaitOptions {
  packageName: string;
  deviceSerial: string;
  pollIntervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type ProcessWaitResult =
  | {
      status: "ready";
      pid: number;
      pids: readonly number[];
      durationMs: number;
    }
  | { status: "timeout"; durationMs: number }
  | { status: "cancelled"; durationMs: number };

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export class ProcessWaiter {
  public constructor(
    private readonly adb: AdbPort,
    private readonly clock: Clock
  ) {}

  public async wait(
    options: ProcessWaitOptions
  ): Promise<ProcessWaitResult> {
    const startedAt = this.clock.now();

    for (;;) {
      if (isAborted(options.signal)) {
        return {
          status: "cancelled",
          durationMs: this.clock.now() - startedAt
        };
      }

      const elapsed = this.clock.now() - startedAt;
      const remainingMs = options.timeoutMs - elapsed;
      if (remainingMs <= 0) {
        return { status: "timeout", durationMs: elapsed };
      }

      let pid: number | null;
      let pids: readonly number[];
      try {
        const processes = await this.adb.appProcesses({
          packageName: options.packageName,
          deviceSerial: options.deviceSerial,
          timeoutMs: remainingMs,
          ...(options.signal === undefined ? {} : { signal: options.signal })
        });
        pid = primaryAppPid(processes, options.packageName);
        pids = appProcessPids(processes);
      } catch (error) {
        if (isAborted(options.signal)) {
          return {
            status: "cancelled",
            durationMs: this.clock.now() - startedAt
          };
        }
        throw error;
      }
      if (pid !== null) {
        return {
          status: "ready",
          pid,
          pids,
          durationMs: this.clock.now() - startedAt
        };
      }

      const elapsedAfterPoll = this.clock.now() - startedAt;
      if (elapsedAfterPoll >= options.timeoutMs) {
        return { status: "timeout", durationMs: elapsedAfterPoll };
      }

      try {
        await this.clock.sleep(
          Math.min(
            options.pollIntervalMs,
            options.timeoutMs - elapsedAfterPoll
          ),
          options.signal
        );
      } catch (error) {
        if (isAborted(options.signal)) {
          return {
            status: "cancelled",
            durationMs: this.clock.now() - startedAt
          };
        }
        throw error;
      }
    }
  }
}
