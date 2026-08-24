import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemExternalFlowRegistry
} from "../../../src/adapters/filesystem/external-flow-registry.js";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "taphound-ext-flow-write-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(
    (path) => rm(path, { recursive: true, force: true })
  ));
});

const validFlow = {
  version: 1 as const,
  kind: "externalFlow" as const,
  name: "camera/photo-capture",
  description: "Test flow",
  escapedPackageName: "com.android.camera",
  expectedEscapeActivity: "com.android.camera.CameraActivity",
  includes: [],
  steps: [
    {
      action: "wait" as const,
      expectedActivity: "com.android.camera.CameraActivity"
    },
    {
      action: "click" as const,
      locator: { resourceId: "com.android.camera:id/shutter_button" },
      expectedActivity: "com.android.camera.CameraActivity"
    }
  ]
};

describe("FileSystemExternalFlowRegistry.write", () => {
  it("writes a new flow atomically to .taphound/flows/external/<name>.json", async () => {
    const projectRoot = await tempDir();
    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);

    const result = await registry.write({
      projectRoot,
      name: "camera/photo-capture",
      flow: validFlow
    });

    expect(result.overwritten).toBe(false);
    const written = JSON.parse(
      await readFile(join(projectRoot, ".taphound/flows/external/camera/photo-capture.json"), "utf8")
    ) as typeof validFlow;
    expect(written.name).toBe("camera/photo-capture");
    // No .tmp file left behind
    const dir = join(projectRoot, ".taphound/flows/external/camera");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries).toEqual(["photo-capture.json"]);
  });

  it("refuses to overwrite without force", async () => {
    const projectRoot = await tempDir();
    await mkdir(join(projectRoot, ".taphound/flows/external/camera"), { recursive: true });
    await writeFile(
      join(projectRoot, ".taphound/flows/external/camera/photo-capture.json"),
      JSON.stringify(validFlow, null, 2)
    );
    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);

    await expect(registry.write({
      projectRoot,
      name: "camera/photo-capture",
      flow: validFlow
    })).rejects.toThrow(/already exists/i);
  });

  it("overwrites with force", async () => {
    const projectRoot = await tempDir();
    await mkdir(join(projectRoot, ".taphound/flows/external/camera"), { recursive: true });
    await writeFile(
      join(projectRoot, ".taphound/flows/external/camera/photo-capture.json"),
      JSON.stringify({ ...validFlow, description: "old" }, null, 2)
    );
    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);

    const result = await registry.write({
      projectRoot,
      name: "camera/photo-capture",
      flow: { ...validFlow, description: "new" },
      force: true
    });

    expect(result.overwritten).toBe(true);
    const written = JSON.parse(
      await readFile(join(projectRoot, ".taphound/flows/external/camera/photo-capture.json"), "utf8")
    ) as { description: string };
    expect(written.description).toBe("new");
  });

  it("rejects a flow whose declared name does not match the file name", async () => {
    const projectRoot = await tempDir();
    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);

    await expect(registry.write({
      projectRoot,
      name: "camera/photo-capture",
      flow: { ...validFlow, name: "wrong/name" }
    })).rejects.toThrow(/declares name/);
  });

  it("rejects a symlinked target file", async () => {
    const projectRoot = await tempDir();
    const outside = await tempDir();
    await mkdir(join(projectRoot, ".taphound/flows/external/camera"), { recursive: true });
    await symlink(
      join(outside, "real.json"),
      join(projectRoot, ".taphound/flows/external/camera/photo-capture.json")
    );
    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);

    await expect(registry.write({
      projectRoot,
      name: "camera/photo-capture",
      flow: validFlow,
      force: true
    })).rejects.toThrow(/symlink/i);
  });

  it("rejects an invalid flow schema", async () => {
    const projectRoot = await tempDir();
    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);

    await expect(registry.write({
      projectRoot,
      name: "camera/photo-capture",
      // intentionally missing steps
      flow: {
        version: 1,
        kind: "externalFlow",
        name: "camera/photo-capture",
        description: "bad",
        escapedPackageName: "com.android.camera",
        includes: [],
        steps: []
      } as unknown as typeof validFlow
    })).rejects.toThrow();
  });

  it("created flow is readable by the same registry", async () => {
    const projectRoot = await tempDir();
    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);

    await registry.write({
      projectRoot,
      name: "camera/photo-capture",
      flow: validFlow
    });

    const record = await registry.read({
      projectRoot,
      name: "camera/photo-capture"
    });
    expect(record.source).toBe("project");
    expect(record.flow.name).toBe("camera/photo-capture");
  });
});
