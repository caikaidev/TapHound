import { describe, expect, it, vi } from "vitest";

import {
  ProjectConfigurationError,
  ProjectDescriber
} from "../../../src/application/project/project-describer.js";
import type { AndroidCliPort } from "../../../src/ports/android-cli.js";
import { runtimeConfig } from "../../fakes/runtime-fixture.js";

function androidCli(
  description: Awaited<ReturnType<AndroidCliPort["describeProject"]>>
): AndroidCliPort {
  return {
    describeProject: vi.fn(() => Promise.resolve(description)),
    runApp: vi.fn(),
    layout: vi.fn(),
    layoutDiff: vi.fn(),
    captureScreen: vi.fn(),
    resolveScreen: vi.fn()
  };
}

describe("ProjectDescriber", () => {
  it("returns normalized stable project and artifact facts", async () => {
    const cli = androidCli({
      apkPath: "/project/app/build/outputs/apk/debug/app-debug.apk",
      metadataPaths: [
        "/project/app/build/outputs/apk/debug/output-metadata.json"
      ],
      packageName: "com.example.app"
    });

    const result = await new ProjectDescriber(cli).describe({
      projectRoot: "/project",
      config: runtimeConfig
    });

    expect(result).toEqual({
      projectRoot: "/project",
      packageName: "com.example.app",
      buildTask: ":app:assembleDebug",
      artifactTarget: "app",
      variant: "debug",
      launchActivity: "com.example.app.MainActivity",
      apkPath: "/project/app/build/outputs/apk/debug/app-debug.apk",
      metadataPaths: [
        "/project/app/build/outputs/apk/debug/output-metadata.json"
      ],
      metadataPackageName: "com.example.app"
    });
    expect(cli.describeProject).toHaveBeenCalledWith({
      projectDir: "/project",
      target: "app",
      variant: "debug"
    });
  });

  it("forwards cancellation and omits unavailable metadata package", async () => {
    const cli = androidCli({
      apkPath: "/project/app-debug.apk",
      metadataPaths: []
    });
    const signal = new AbortController().signal;

    const result = await new ProjectDescriber(cli).describe({
      projectRoot: "/project",
      config: runtimeConfig,
      signal
    });

    expect(result).not.toHaveProperty("metadataPackageName");
    expect(cli.describeProject).toHaveBeenCalledWith({
      projectDir: "/project",
      target: "app",
      variant: "debug",
      signal
    });
  });

  it("rejects metadata that conflicts with the configured package", async () => {
    const cli = androidCli({
      apkPath: "/project/app-debug.apk",
      metadataPaths: ["/project/output-metadata.json"],
      packageName: "com.other.app"
    });

    await expect(new ProjectDescriber(cli).describe({
      projectRoot: "/project",
      config: runtimeConfig
    })).rejects.toEqual(expect.objectContaining<ProjectConfigurationError>({
      name: "ProjectConfigurationError",
      message: "Configured Package com.example.app conflicts with Android metadata com.other.app"
    }));
  });
});
