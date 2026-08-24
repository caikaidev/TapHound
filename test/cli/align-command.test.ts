import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import type { AlignCameraResult } from "../../src/application/align/align-service.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

interface AlignTestHarness {
  dependencies: CliDependencies;
  stdout: BufferOutput;
  stderr: BufferOutput;
  exitCodes: number[];
  alignCameraMock: ReturnType<typeof vi.fn>;
}

function harness(result: AlignCameraResult): AlignTestHarness {
  const stdout = new BufferOutput();
  const stderr = new BufferOutput();
  const exitCodes: number[] = [];
  const alignCameraMock = vi.fn(() => Promise.resolve(result));
  const dependencies: CliDependencies = {
    doctor: { run: vi.fn(() => Promise.reject(new Error("unused"))) },
    recorder: { record: vi.fn(() => Promise.reject(new Error("unused"))) },
    verifier: { verify: vi.fn(() => Promise.reject(new Error("unused"))) },
    projectDescriber: { describe: vi.fn(() => Promise.reject(new Error("unused"))) },
    contextValidator: { validate: vi.fn(() => Promise.reject(new Error("unused"))) },
    contextLoader: { load: vi.fn(), readIndex: vi.fn() },
    contextRefresher: { refresh: vi.fn() },
    init: { install: vi.fn() },
    initPrompt: { selectAgents: vi.fn() },
    align: { alignCamera: alignCameraMock },
    generationStarter: { start: vi.fn(() => Promise.reject(new Error("unused"))) },
    runtimeObserver: { observe: vi.fn(() => Promise.reject(new Error("unused"))) },
    workspaceLayout: fakeWorkspaceLayout(),
    readJson: vi.fn(() => Promise.resolve({
      version: 1,
      run: { packageName: "com.example.app", activity: ".MainActivity" },
      idle: { pollIntervalMs: 200, stablePolls: 2, timeoutMs: 5000 },
      artifactsDir: ".taphound/build/runs"
    })),
    cwd: () => "/project",
    stdout,
    stderr,
    setExitCode: (code): void => { exitCodes.push(code); }
  };
  return { dependencies, stdout, stderr, exitCodes, alignCameraMock };
}

const writtenResult: AlignCameraResult = {
  status: "written",
  exitCode: 0,
  flow: {
    name: "camera/photo-capture",
    path: ".taphound/flows/external/camera/photo-capture.json",
    steps: 3,
    overwritten: false
  },
  probe: {
    packageName: "com.android.camera",
    activityName: "com.android.camera.CameraActivity",
    shutterResourceId: "com.android.camera:id/shutter_button",
    confirmResourceId: "com.android.camera:id/btn_done"
  },
  deviceSerial: "DEVICE1"
};

describe("taphound align camera command", () => {
  it("emits single JSON on success with --json", async () => {
    const test = harness(writtenResult);
    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "align", "camera", "--json"
    ]);
    const output = JSON.parse(test.stdout.value) as AlignCameraResult;
    expect(output.status).toBe("written");
    expect(output.exitCode).toBe(0);
    expect(test.exitCodes).toEqual([0]);
  });

  it("writes human-readable output without --json", async () => {
    const test = harness(writtenResult);
    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "align", "camera"
    ]);
    expect(test.stdout.value).toContain("Wrote camera/photo-capture flow");
    expect(test.exitCodes).toEqual([0]);
  });

  it("emits cancelled JSON with exit code 2 when user declines", async () => {
    const test = harness({ status: "cancelled", exitCode: 2 });
    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "align", "camera", "--json"
    ]);
    const output = JSON.parse(test.stdout.value) as AlignCameraResult;
    expect(output.status).toBe("cancelled");
    expect(output.exitCode).toBe(2);
    expect(test.exitCodes).toEqual([2]);
  });

  it("emits error JSON with exit code 2 when AlignError is thrown", async () => {
    const test = harness(writtenResult);
    const { AlignError } = await import("../../src/application/align/align-service.js");
    test.alignCameraMock.mockRejectedValueOnce(
      new AlignError("ALIGN_SHUTTER_NOT_FOUND", "No shutter button found")
    );
    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "align", "camera", "--json"
    ]);
    const output = JSON.parse(test.stdout.value) as {
      status: string; exitCode: number; failure: { code: string; message: string };
    };
    expect(output.status).toBe("error");
    expect(output.exitCode).toBe(2);
    expect(output.failure.code).toBe("ALIGN_SHUTTER_NOT_FOUND");
    expect(test.exitCodes).toEqual([2]);
  });

  it("passes --device and --force to the service", async () => {
    const test = harness(writtenResult);
    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "align", "camera",
      "--device", "DEVICE2", "--force", "--json"
    ]);
    expect(test.alignCameraMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceSerial: "DEVICE2",
        force: true,
        json: true
      })
    );
  });

  it("emits CONFIG_INVALID with exit code 2 when config is unreadable", async () => {
    const test = harness(writtenResult);
    (test.dependencies.readJson as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ENOENT")
    );
    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "align", "camera", "--json"
    ]);
    const output = JSON.parse(test.stdout.value) as {
      status: string; exitCode: number; failure: { code: string };
    };
    expect(output.status).toBe("error");
    expect(output.failure.code).toBe("CONFIG_INVALID");
    expect(test.exitCodes).toEqual([2]);
  });
});
