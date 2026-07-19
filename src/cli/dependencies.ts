import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdbAdapter } from "../adapters/adb/adb-adapter.js";
import { AndroidCliAdapter } from "../adapters/android-cli/android-cli-adapter.js";
import { SystemClock } from "../adapters/clock/system-clock.js";
import { FileSystemArtifactStore } from "../adapters/filesystem/artifact-store.js";
import { FileSystemJourneyWriter } from "../adapters/filesystem/journey-writer.js";
import { GradleAdapter } from "../adapters/gradle/gradle-adapter.js";
import { NodeProcessRunner } from "../adapters/process/node-process-runner.js";
import { InquirerRecorderPrompt } from "../adapters/prompt/inquirer-recorder-prompt.js";
import { DoctorService } from "../application/doctor/doctor-service.js";
import type { DoctorReport } from "../application/doctor/doctor-service.js";
import { RecorderService, type RecordInput, type RecordResult } from "../application/recorder/recorder-service.js";
import { ReportWriter } from "../application/report/report-writer.js";
import { VerifyRuntime, type VerifyInput, type VerifyResult } from "../application/runtime/verify-runtime.js";

export interface TextOutput {
  write: (content: string) => void;
}

export interface CliDependencies {
  doctor: {
    run: (
      projectRoot: string,
      signal?: AbortSignal,
      requestedDevice?: string
    ) => Promise<DoctorReport>;
  };
  recorder: {
    record: (input: RecordInput) => Promise<RecordResult>;
  };
  verifier: {
    verify: (input: VerifyInput) => Promise<VerifyResult>;
  };
  readJson: (path: string) => Promise<unknown>;
  cwd: () => string;
  stdout: TextOutput;
  stderr: TextOutput;
  setExitCode: (code: number) => void;
}

function runId(): string {
  return `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
}

export function createProductionDependencies(): CliDependencies {
  const runner = new NodeProcessRunner();
  const adb = new AdbAdapter(runner);
  const androidCli = new AndroidCliAdapter(runner);
  const gradle = new GradleAdapter(runner);
  const clock = new SystemClock();
  return {
    doctor: new DoctorService({
      runner,
      adb,
      nodeVersion: process.version,
      checkGradleWrapper: async (projectRoot): Promise<boolean> => {
        try {
          await access(join(projectRoot, "gradlew"), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
      checkAndroidPermissions: async (
        deviceSerial,
        signal
      ): Promise<{
        status: "passed" | "failed";
        message?: string | undefined;
      }> => {
        const directory = await mkdtemp(join(tmpdir(), "apr-doctor-"));
        try {
          const result = await androidCli.captureScreen({
            outputPath: join(directory, "screen.png"),
            deviceSerial,
            ...(signal === undefined ? {} : { signal })
          });
          if (
            result.exitCode !== 0
            || result.spawnError !== undefined
            || result.cancelled
            || result.timedOut
          ) {
            return {
              status: "failed" as const,
              message: result.stderr.trim()
                || result.spawnError
                || "Android screen capture permission probe failed"
            };
          }
          return { status: "passed" as const };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }),
    recorder: new RecorderService({
      gradle,
      androidCli,
      adb,
      clock,
      prompt: new InquirerRecorderPrompt(),
      journeyWriter: new FileSystemJourneyWriter()
    }),
    verifier: new VerifyRuntime({
      gradle,
      androidCli,
      adb,
      clock,
      artifactStore: new FileSystemArtifactStore(),
      reportWriter: new ReportWriter(),
      now: () => new Date(),
      createRunId: runId
    }),
    readJson: async (path): Promise<unknown> => JSON.parse(
      await readFile(path, "utf8")
    ) as unknown,
    cwd: () => process.cwd(),
    stdout: {
      write: (content): void => {
        process.stdout.write(content);
      }
    },
    stderr: {
      write: (content): void => {
        process.stderr.write(content);
      }
    },
    setExitCode: (code): void => {
      process.exitCode = code;
    }
  };
}
