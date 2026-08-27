import { describe, expect, it, vi, type Mock } from "vitest";

import {
  AlignService,
  type AlignCameraResult,
  type AlignCameraWrittenResult
} from "../../../src/application/align/align-service.js";
import {
  CameraProbeError,
  type CameraProbePort,
  type CameraProbeResult
} from "../../../src/ports/camera-probe.js";
import type { AlignPromptPort } from "../../../src/ports/align-prompt.js";
import type {
  ExternalFlowRegistry,
  WriteExternalFlowInput,
  WriteExternalFlowResult
} from "../../../src/ports/external-flow-registry.js";
import type { AdbPort, DeviceInfo } from "../../../src/ports/adb.js";

const probeResult: CameraProbeResult = {
  packageName: "com.android.camera",
  activityName: "com.android.camera.CameraActivity",
  shutterResourceId: "com.android.camera:id/shutter_button",
  shutterContentDescription: "快门按钮",
  confirmResourceId: "com.android.camera:id/btn_done",
  confirmContentDescription: "完成",
  confirmActivityName: "com.android.camera.ReviewActivity"
};

function makeProbe(result: CameraProbeResult = probeResult): CameraProbePort {
  return { probe: vi.fn(() => Promise.resolve(result)) };
}

function makePrompt(confirm: boolean): AlignPromptPort {
  return { confirmWrite: vi.fn(() => Promise.resolve(confirm)) };
}

function makeRegistry(overwritten = false): {
  registry: ExternalFlowRegistry;
  writeMock: Mock<(input: WriteExternalFlowInput) => Promise<WriteExternalFlowResult>>;
} {
  const writeMock = vi.fn<(input: WriteExternalFlowInput) => Promise<WriteExternalFlowResult>>(
    () => Promise.resolve({
      path: ".taphound/flows/external/camera/photo-capture.json",
      overwritten
    })
  );
  const registry: ExternalFlowRegistry = {
    read: vi.fn(),
    list: vi.fn(),
    write: writeMock
  };
  return { registry, writeMock };
}

function makeAdb(devices: DeviceInfo[]): AdbPort {
  const adb: AdbPort = {
    devices: vi.fn(() => Promise.resolve(devices)),
    foregroundComponent: vi.fn(() => Promise.resolve({
      packageName: "com.example.app",
      activity: ".MainActivity"
    })),
    currentActivity: vi.fn(),
    isInstalled: vi.fn(),
    launchActivity: vi.fn(),
    startActivityByIntent: vi.fn(),
    resolveLauncherActivity: vi.fn(() => Promise.resolve(undefined)),
    forceStop: vi.fn(),
    appProcesses: vi.fn(),
    windowTopology: vi.fn(),
    tap: vi.fn(),
    longClick: vi.fn(),
    swipe: vi.fn(),
    back: vi.fn(),
    inputText: vi.fn(),
    startLogcat: vi.fn(),
    dumpLogcat: vi.fn()
  };
  return adb;
}

function written(result: AlignCameraResult): AlignCameraWrittenResult {
  if (result.status !== "written") {
    throw new Error(`Expected written status, got ${result.status}`);
  }
  return result;
}

function writeArg(
  writeMock: Mock<(input: WriteExternalFlowInput) => Promise<WriteExternalFlowResult>>
): WriteExternalFlowInput {
  const arg = writeMock.mock.calls[0]?.[0];
  if (arg === undefined) {
    throw new Error("registry.write was not called");
  }
  return arg;
}

describe("AlignService.alignCamera", () => {
  it("writes a 3-step flow when probe finds shutter+confirm and user confirms", async () => {
    const probe = makeProbe();
    const prompt = makePrompt(true);
    const { registry, writeMock } = makeRegistry();
    const adb = makeAdb([{ serial: "DEVICE1", status: "device" }]);
    const service = new AlignService({ adb, probe, prompt, registry });

    const result = written(await service.alignCamera({
      projectRoot: "/project",
      json: false
    }));

    expect(result.exitCode).toBe(0);
    expect(result.flow.steps).toBe(3);
    expect(result.flow.overwritten).toBe(false);
    expect(writeMock).toHaveBeenCalledTimes(1);
    const arg = writeArg(writeMock);
    expect(arg.name).toBe("camera/photo-capture");
    expect(arg.flow.steps).toHaveLength(3);
    expect(arg.flow.steps[1]).toMatchObject({
      locator: { resourceId: "com.android.camera:id/shutter_button" }
    });
    expect(arg.flow.steps[2]).toMatchObject({
      locator: { resourceId: "com.android.camera:id/btn_done" },
      expectedActivity: "com.android.camera.ReviewActivity"
    });
  });

  it("writes a 2-step flow when probe finds shutter only (auto-accept)", async () => {
    const probe = makeProbe({
      ...probeResult,
      confirmResourceId: undefined,
      confirmContentDescription: undefined
    });
    const prompt = makePrompt(true);
    const { registry, writeMock } = makeRegistry();
    const adb = makeAdb([{ serial: "DEVICE1", status: "device" }]);
    const service = new AlignService({ adb, probe, prompt, registry });

    const result = written(await service.alignCamera({
      projectRoot: "/project",
      json: false
    }));

    expect(result.flow.steps).toBe(2);
    expect(writeArg(writeMock).flow.steps).toHaveLength(2);
  });

  it("returns cancelled status when user declines the confirm prompt", async () => {
    const probe = makeProbe();
    const prompt = makePrompt(false);
    const { registry, writeMock } = makeRegistry();
    const adb = makeAdb([{ serial: "DEVICE1", status: "device" }]);
    const service = new AlignService({ adb, probe, prompt, registry });

    const result = await service.alignCamera({
      projectRoot: "/project",
      json: false
    });

    expect(result.status).toBe("cancelled");
    expect(result.exitCode).toBe(2);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("skips the prompt and writes when json=true", async () => {
    const probe = makeProbe();
    const prompt = makePrompt(false);
    const { registry, writeMock } = makeRegistry();
    const adb = makeAdb([{ serial: "DEVICE1", status: "device" }]);
    const service = new AlignService({ adb, probe, prompt, registry });

    const result = written(await service.alignCamera({
      projectRoot: "/project",
      json: true
    }));

    expect(result.status).toBe("written");
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prompt.confirmWrite)).not.toHaveBeenCalled();
  });

  it("passes force=true to registry.write when --force is given", async () => {
    const probe = makeProbe();
    const prompt = makePrompt(true);
    const { registry, writeMock } = makeRegistry(true);
    const adb = makeAdb([{ serial: "DEVICE1", status: "device" }]);
    const service = new AlignService({ adb, probe, prompt, registry });

    const result = written(await service.alignCamera({
      projectRoot: "/project",
      force: true,
      json: false
    }));

    expect(result.flow.overwritten).toBe(true);
    expect(writeArg(writeMock).force).toBe(true);
  });

  it("throws AlignError ALIGN_FLOW_EXISTS when registry.write rejects with 'already exists'", async () => {
    const probe = makeProbe();
    const prompt = makePrompt(true);
    const { registry, writeMock } = makeRegistry();
    writeMock.mockRejectedValueOnce(
      new Error("External Flow already exists: camera/photo-capture")
    );
    const adb = makeAdb([{ serial: "DEVICE1", status: "device" }]);
    const service = new AlignService({ adb, probe, prompt, registry });

    await expect(service.alignCamera({
      projectRoot: "/project",
      json: false
    })).rejects.toMatchObject({ code: "ALIGN_FLOW_EXISTS" });
  });

  it("throws AlignError ALIGN_DEVICE_UNAVAILABLE when no devices online", async () => {
    const probe = makeProbe();
    const prompt = makePrompt(true);
    const { registry } = makeRegistry();
    const adb = makeAdb([]);
    const service = new AlignService({ adb, probe, prompt, registry });

    await expect(service.alignCamera({
      projectRoot: "/project",
      json: false
    })).rejects.toMatchObject({ code: "ALIGN_DEVICE_UNAVAILABLE" });
  });

  it("maps CameraProbeError to AlignError", async () => {
    const probe: CameraProbePort = {
      probe: vi.fn(() => Promise.reject(new CameraProbeError(
        "ALIGN_CONFIRM_NOT_FOUND",
        "No deterministic confirm button"
      )))
    };
    const prompt = makePrompt(true);
    const { registry } = makeRegistry();
    const adb = makeAdb([{ serial: "DEVICE1", status: "device" }]);
    const service = new AlignService({ adb, probe, prompt, registry });

    await expect(service.alignCamera({
      projectRoot: "/project",
      json: true
    })).rejects.toMatchObject({
      code: "ALIGN_CONFIRM_NOT_FOUND"
    });
  });

  it("throws AlignError ALIGN_DEVICE_UNAVAILABLE when 2+ devices online and no --device", async () => {
    const probe = makeProbe();
    const prompt = makePrompt(true);
    const { registry } = makeRegistry();
    const adb = makeAdb([
      { serial: "DEVICE1", status: "device" },
      { serial: "DEVICE2", status: "device" }
    ]);
    const service = new AlignService({ adb, probe, prompt, registry });

    await expect(service.alignCamera({
      projectRoot: "/project",
      json: false
    })).rejects.toMatchObject({ code: "ALIGN_DEVICE_UNAVAILABLE" });
  });

  it("uses --device serial when provided", async () => {
    const probe = makeProbe();
    const prompt = makePrompt(true);
    const { registry } = makeRegistry();
    const adb = makeAdb([
      { serial: "DEVICE1", status: "device" },
      { serial: "DEVICE2", status: "device" }
    ]);
    const service = new AlignService({ adb, probe, prompt, registry });

    const result = written(await service.alignCamera({
      projectRoot: "/project",
      deviceSerial: "DEVICE2",
      json: true
    }));

    expect(result.status).toBe("written");
    expect(vi.mocked(probe.probe)).toHaveBeenCalledWith(
      expect.objectContaining({ deviceSerial: "DEVICE2" })
    );
  });

  it("throws AlignError ALIGN_DEVICE_UNAVAILABLE when --device not found", async () => {
    const probe = makeProbe();
    const prompt = makePrompt(true);
    const { registry } = makeRegistry();
    const adb = makeAdb([{ serial: "DEVICE1", status: "device" }]);
    const service = new AlignService({ adb, probe, prompt, registry });

    await expect(service.alignCamera({
      projectRoot: "/project",
      deviceSerial: "MISSING",
      json: true
    })).rejects.toMatchObject({ code: "ALIGN_DEVICE_UNAVAILABLE" });
  });
});
