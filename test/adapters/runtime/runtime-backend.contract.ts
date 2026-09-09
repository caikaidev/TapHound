import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";

import type {
  RuntimeBackend,
  RuntimeSession
} from "../../../src/ports/runtime-backend.js";
import type { CommandResult } from "../../../src/ports/process-runner.js";

const CAPABILITY_KEYS = [
  "annotatedScreens",
  "foregroundActivity",
  "frameStatsIdle",
  "intentStart",
  "layoutSnapshot",
  "logs",
  "processDiscovery",
  "screenshot",
  "windowTopology"
].sort();

export interface RuntimeBackendContractFixture {
  backend: RuntimeBackend;
  deviceSerial: string;
  packageName: string;
  launchActivity: string;
}

function expectCommandResult(value: CommandResult): void {
  expect(typeof value.exitCode).toBe("number");
  expect(value.exitCode).toBe(0);
  expect(typeof value.durationMs).toBe("number");
  expect(value.timedOut).toBe(false);
  expect(value.cancelled).toBe(false);
}

function placeholderResult(): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false
  };
}

export function describeRuntimeBackendContract(
  name: string,
  fixture: () => RuntimeBackendContractFixture
): void {
  // Capability gating is static per backend, so one collection-time read is
  // enough to decide which contract sections apply.
  const gating = fixture();
  const capabilities = gating.backend.capabilities;

  describe(`runtime backend contract: ${name}`, () => {
    let backend: RuntimeBackend;
    let session: RuntimeSession;
    let context: RuntimeBackendContractFixture;
    let screenshotDir: string;

    function screenshotOutputPath(): string {
      return join(screenshotDir, "screen.png");
    }

    beforeEach(async () => {
      context = fixture();
      backend = context.backend;
      session = await backend.openSession({
        deviceSerial: context.deviceSerial
      });
      screenshotDir = await mkdtemp(join(tmpdir(), "taphound-contract-"));
    });

    afterEach(async () => {
      await session.close();
      await rm(screenshotDir, { recursive: true, force: true });
    });

    it("exposes a stable descriptor with full capability declarations", () => {
      expect(backend.descriptor.configSha256).toMatch(/^[a-f\d]{64}$/);
      expect(backend.descriptor.adapterVersion.length).toBeGreaterThan(0);
      expect(Object.keys(backend.descriptor.capabilities).sort())
        .toEqual(CAPABILITY_KEYS);
      expect(backend.capabilities).toEqual(backend.descriptor.capabilities);
      expect(session.descriptor).toEqual(backend.descriptor);
    });

    it("lists devices with serial and status", async () => {
      const devices = await backend.listDevices();
      expect(devices.length).toBeGreaterThan(0);
      for (const device of devices) {
        expect(device.serial.length).toBeGreaterThan(0);
        expect(device.status.length).toBeGreaterThan(0);
      }
    });

    it("binds the session to the requested device", () => {
      expect(session.deviceSerial).toBe(context.deviceSerial);
    });

    it("answers installation queries", async () => {
      await expect(session.isInstalled({
        packageName: context.packageName
      })).resolves.toBe(true);
    });

    it("resolves launch and terminate as command results", async () => {
      expectCommandResult(await session.launchApp({
        packageName: context.packageName,
        activity: context.launchActivity
      }));
      expectCommandResult(await session.forceStop({
        packageName: context.packageName
      }));
    });

    it("opens the snapshot provider lazily and memoizes it", async () => {
      const first = await session.openUiSnapshots();
      const second = await session.openUiSnapshots();
      expect(second).toBe(first);
    });

    it("executes actions as command results", async () => {
      expectCommandResult(await session.tap({ x: 10, y: 20 }));
      expectCommandResult(await session.longClick({ x: 10, y: 20 }, 800));
      expectCommandResult(await session.swipe(
        { x: 10, y: 20 },
        { x: 10, y: 60 },
        300
      ));
      expectCommandResult(await session.back());
      expectCommandResult(await session.inputText("hello"));
    });

    it.runIf(capabilities.layoutSnapshot)(
      "captures layout snapshots with backend identity",
      async () => {
        const provider = await session.openUiSnapshots();
        const snapshot = await provider.capture({
          reason: "locate",
          timeoutMs: 5000
        });
        expect(snapshot.backend).toEqual(provider.descriptor);
        expect(snapshot.viewport.width).toBeGreaterThan(0);
        expect(snapshot.viewport.height).toBeGreaterThan(0);
        expect(Array.isArray(snapshot.roots)).toBe(true);
      }
    );

    it.runIf(capabilities.screenshot)(
      "captures screenshots as command results",
      async () => {
        expectCommandResult(await session.captureScreenshot({
          outputPath: screenshotOutputPath()
        }));
      }
    );

    it.runIf(capabilities.foregroundActivity)(
      "answers activity and foreground queries",
      async () => {
        const app = { packageName: context.packageName };
        const activity = await session.currentActivity?.(app);
        expect(activity === undefined || activity.length > 0).toBe(true);
        const foreground = await session.foregroundComponent?.(app);
        expect(
          foreground === undefined
          || foreground.packageName.length > 0
        ).toBe(true);
      }
    );

    it.runIf(capabilities.processDiscovery)(
      "lists app processes with integer pids",
      async () => {
        const processes = await session.appProcesses?.({
          packageName: context.packageName
        });
        expect(Array.isArray(processes)).toBe(true);
        for (const process of processes ?? []) {
          expect(Number.isInteger(process.pid)).toBe(true);
        }
      }
    );

    it.runIf(capabilities.logs)(
      "streams and dumps logcat as command results",
      async () => {
        const logcat = session.startLogcat?.({
          onStdoutLine: (): void => undefined
        });
        expect(logcat).toBeDefined();
        if (logcat !== undefined) {
          expectCommandResult(
            await logcat.started.then((result) => result ?? placeholderResult())
          );
          expectCommandResult(await logcat.stop());
        }
        expectCommandResult(
          await session.dumpLogcat?.({ maxLines: 100 }) ?? placeholderResult()
        );
      }
    );

    it("keeps capability-gated members consistent with declarations", () => {
      expect(session.annotatedScreens === undefined)
        .toBe(!capabilities.annotatedScreens);
      expect(session.startActivityByIntent === undefined)
        .toBe(!capabilities.intentStart);
      expect(session.currentActivity === undefined)
        .toBe(!capabilities.foregroundActivity);
      expect(session.foregroundComponent === undefined)
        .toBe(!capabilities.foregroundActivity);
      expect(session.appProcesses === undefined)
        .toBe(!capabilities.processDiscovery);
      expect(session.windowTopology === undefined)
        .toBe(!capabilities.windowTopology);
      expect(session.startLogcat === undefined).toBe(!capabilities.logs);
      expect(session.dumpLogcat === undefined).toBe(!capabilities.logs);
    });
  });
}
