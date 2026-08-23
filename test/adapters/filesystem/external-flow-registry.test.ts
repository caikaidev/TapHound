import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemExternalFlowRegistry
} from "../../../src/adapters/filesystem/external-flow-registry.js";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "taphound-ext-flow-"));
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
  version: 1,
  kind: "externalFlow",
  name: "test/click-ok",
  description: "Test flow that clicks an OK button",
  escapedPackageName: "com.example.external",
  expectedEscapeActivity: "com.example.external.MainActivity",
  includes: [],
  steps: [
    {
      action: "click",
      locator: { resourceId: "com.example.external:id/ok_button" },
      expectedActivity: "com.example.external.MainActivity"
    }
  ]
};

function flowJson(name: string): string {
  return `${JSON.stringify({ ...validFlow, name }, null, 2)}\n`;
}

describe("FileSystemExternalFlowRegistry", () => {
  it("reads a project External Flow from .taphound/flows/external/", async () => {
    const projectRoot = await tempDir();
    const dir = join(projectRoot, ".taphound/flows/external/test");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "click-ok.json"), flowJson("test/click-ok"));

    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);
    const record = await registry.read({
      projectRoot,
      name: "test/click-ok"
    });

    expect(record.source).toBe("project");
    expect(record.flow.name).toBe("test/click-ok");
    expect(record.flow.escapedPackageName).toBe("com.example.external");
    expect(record.flow.steps).toHaveLength(1);
    expect(record.bytes.byteLength).toBeGreaterThan(0);
  });

  it("reads a built-in External Flow when no project flow exists", async () => {
    const projectRoot = await tempDir();
    const builtinRoot = await tempDir();
    await writeFile(
      join(builtinRoot, "camera-photo.json"),
      flowJson("camera-photo")
    );

    const registry = new FileSystemExternalFlowRegistry(builtinRoot);
    const record = await registry.read({
      projectRoot,
      name: "camera-photo"
    });

    expect(record.source).toBe("builtin");
    expect(record.flow.name).toBe("camera-photo");
  });

  it("project flow takes precedence over built-in flow of the same name", async () => {
    const projectRoot = await tempDir();
    await mkdir(join(projectRoot, ".taphound/flows/external"), { recursive: true });
    await writeFile(
      join(projectRoot, ".taphound/flows/external/shared.json"),
      flowJson("shared")
    );

    const builtinRoot = await tempDir();
    const builtinFlow = {
      ...validFlow,
      name: "shared",
      description: "Built-in version"
    };
    await writeFile(
      join(builtinRoot, "shared.json"),
      `${JSON.stringify(builtinFlow, null, 2)}\n`
    );

    const registry = new FileSystemExternalFlowRegistry(builtinRoot);
    const record = await registry.read({
      projectRoot,
      name: "shared"
    });

    expect(record.source).toBe("project");
    expect(record.flow.description).toBe("Test flow that clicks an OK button");
  });

  it("throws when neither project nor built-in flow exists", async () => {
    const projectRoot = await tempDir();
    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);

    await expect(registry.read({
      projectRoot,
      name: "nonexistent"
    })).rejects.toThrow(/not found/i);
  });

  it("rejects a flow whose declared name does not match the file name", async () => {
    const projectRoot = await tempDir();
    await mkdir(join(projectRoot, ".taphound/flows/external"), { recursive: true });
    await writeFile(
      join(projectRoot, ".taphound/flows/external/wrong-name.json"),
      flowJson("actual-name")
    );

    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);

    await expect(registry.read({
      projectRoot,
      name: "wrong-name"
    })).rejects.toThrow(/declares name/);
  });

  it("lists both project and built-in flows with deduplication", async () => {
    const projectRoot = await tempDir();
    await mkdir(join(projectRoot, ".taphound/flows/external/nested"), { recursive: true });
    await writeFile(
      join(projectRoot, ".taphound/flows/external/project-only.json"),
      flowJson("project-only")
    );
    await writeFile(
      join(projectRoot, ".taphound/flows/external/nested/deep.json"),
      flowJson("nested/deep")
    );
    await writeFile(
      join(projectRoot, ".taphound/flows/external/shared.json"),
      flowJson("shared")
    );

    const builtinRoot = await tempDir();
    await writeFile(join(builtinRoot, "builtin-only.json"), flowJson("builtin-only"));
    await writeFile(join(builtinRoot, "shared.json"), flowJson("shared"));

    const registry = new FileSystemExternalFlowRegistry(builtinRoot);
    const entries = await registry.list(projectRoot);

    const names = entries.map((e) => `${e.name}:${e.source}`);
    expect(names).toContain("project-only:project");
    expect(names).toContain("nested/deep:project");
    expect(names).toContain("shared:project");
    expect(names).toContain("builtin-only:builtin");
    expect(names).not.toContain("shared:builtin");
    expect(entries).toHaveLength(4);
  });

  it("rejects symlinked project External Flow catalogs", async () => {
    const projectRoot = await tempDir();
    const outside = await tempDir();
    await mkdir(join(projectRoot, ".taphound/flows"), { recursive: true });
    await symlink(outside, join(projectRoot, ".taphound/flows/external"));

    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);

    await expect(registry.list(projectRoot)).rejects.toThrow(
      /escape|safe directory/i
    );
  });

  it("reports invalid JSON as an invalid catalog entry", async () => {
    const projectRoot = await tempDir();
    await mkdir(join(projectRoot, ".taphound/flows/external"), { recursive: true });
    await writeFile(
      join(projectRoot, ".taphound/flows/external/broken.json"),
      "{ not valid json"
    );

    const builtinRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);
    const entries = await registry.list(projectRoot);

    const broken = entries.find((e) => e.name === "broken");
    expect(broken).toBeDefined();
    expect(broken?.status).toBe("invalid");
    expect(broken?.failure).toBeDefined();
  });

  it("validates the built-in camera/photo-capture flow", async () => {
    const builtinRoot = join(process.cwd(), "assets", "external-flows");
    const projectRoot = await tempDir();
    const registry = new FileSystemExternalFlowRegistry(builtinRoot);
    const record = await registry.read({
      projectRoot,
      name: "camera/photo-capture"
    });

    expect(record.source).toBe("builtin");
    expect(record.flow.name).toBe("camera/photo-capture");
    expect(record.flow.escapedPackageName).toBe("com.android.camera2");
    expect(record.flow.expectedEscapeActivity).toBe(
      "com.android.camera2.CameraActivity"
    );
    expect(record.flow.steps).toHaveLength(2);
    expect(record.flow.steps[0]?.action).toBe("wait");
    expect(record.flow.steps[1]?.action).toBe("click");
  });
});
