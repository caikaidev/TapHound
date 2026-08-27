import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeProjectInventoryInspector } from "../../../src/adapters/filesystem/project-inventory-inspector.js";
import { compareStrings } from "../../../src/shared/strings.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-inventory-"));
  roots.push(root);
  return root;
}

function expectedPathSetSha256(paths: string[]): string {
  const sorted = [...paths].sort(compareStrings);
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

describe("NodeProjectInventoryInspector", () => {
  it("computes pathSetSha256 from codepoint-sorted project-relative paths", async () => {
    const root = await temporaryRoot();
    const moduleDir = join(root, "app");
    await mkdir(join(moduleDir, "src", "main", "java", "com", "example"), {
      recursive: true
    });
    await mkdir(join(moduleDir, "src", "main", "res", "layout"), {
      recursive: true
    });
    await mkdir(join(moduleDir, "build"), { recursive: true });

    const files: Record<string, string> = {
      "src/main/AndroidManifest.xml": "<manifest/>",
      "src/main/java/com/example/MainActivity.kt": "class MainActivity",
      "src/main/java/com/example/SearchActivity.kt": "class SearchActivity",
      "src/main/res/layout/activity_main.xml": "<layout/>",
      "src/main/res/layout/activity_search.xml": "<layout/>"
    };
    for (const [relative, content] of Object.entries(files)) {
      await writeFile(join(moduleDir, relative), content, "utf8");
    }

    const inspector = new NodeProjectInventoryInspector();
    const result = await inspector.inspectProjectInventory({
      projectRoot: root,
      projectDir: "app",
      categories: ["manifests", "sources", "layouts", "navigation"]
    });

    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") {
      return;
    }
    const expected = expectedPathSetSha256([
      "app/src/main/AndroidManifest.xml",
      "app/src/main/java/com/example/MainActivity.kt",
      "app/src/main/java/com/example/SearchActivity.kt",
      "app/src/main/res/layout/activity_main.xml",
      "app/src/main/res/layout/activity_search.xml"
    ]);
    expect(result.pathSetSha256).toBe(expected);
    expect(result.paths).toEqual([
      "app/src/main/AndroidManifest.xml",
      "app/src/main/java/com/example/MainActivity.kt",
      "app/src/main/java/com/example/SearchActivity.kt",
      "app/src/main/res/layout/activity_main.xml",
      "app/src/main/res/layout/activity_search.xml"
    ]);
  });

  it("excludes build, .git, .gradle, .idea, and .taphound directories", async () => {
    const root = await temporaryRoot();
    const moduleDir = join(root, "lib");
    for (const excluded of [".git", ".gradle", ".idea", ".taphound", "build"]) {
      await mkdir(join(moduleDir, excluded, "src"), { recursive: true });
      await writeFile(
        join(moduleDir, excluded, "src", "Excluded.kt"),
        "class Excluded",
        "utf8"
      );
    }
    await mkdir(join(moduleDir, "src"), { recursive: true });
    await writeFile(join(moduleDir, "src", "Kept.kt"), "class Kept", "utf8");

    const inspector = new NodeProjectInventoryInspector();
    const result = await inspector.inspectProjectInventory({
      projectRoot: root,
      projectDir: "lib",
      categories: ["sources"]
    });

    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") {
      return;
    }
    expect(result.paths).toEqual(["lib/src/Kept.kt"]);
  });

  it("filters by selected categories", async () => {
    const root = await temporaryRoot();
    const moduleDir = join(root, "app");
    await mkdir(join(moduleDir, "src", "main", "res", "layout"), {
      recursive: true
    });
    await mkdir(join(moduleDir, "src", "main", "res", "navigation"), {
      recursive: true
    });
    await writeFile(
      join(moduleDir, "src", "main", "res", "layout", "activity_main.xml"),
      "<layout/>",
      "utf8"
    );
    await writeFile(
      join(moduleDir, "src", "main", "res", "navigation", "nav_graph.xml"),
      "<navigation/>",
      "utf8"
    );

    const inspector = new NodeProjectInventoryInspector();
    const layoutsOnly = await inspector.inspectProjectInventory({
      projectRoot: root,
      projectDir: "app",
      categories: ["layouts"]
    });
    expect(layoutsOnly.status).toBe("inspected");
    if (layoutsOnly.status === "inspected") {
      expect(layoutsOnly.paths).toEqual([
        "app/src/main/res/layout/activity_main.xml"
      ]);
    }

    const navigationOnly = await inspector.inspectProjectInventory({
      projectRoot: root,
      projectDir: "app",
      categories: ["navigation"]
    });
    expect(navigationOnly.status).toBe("inspected");
    if (navigationOnly.status === "inspected") {
      expect(navigationOnly.paths).toEqual([
        "app/src/main/res/navigation/nav_graph.xml"
      ]);
    }
  });

  it("returns escape when projectDir resolves outside the project root", async () => {
    const root = await temporaryRoot();
    const other = await temporaryRoot();
    const inspector = new NodeProjectInventoryInspector();
    const result = await inspector.inspectProjectInventory({
      projectRoot: root,
      projectDir: `../${other.split("/").pop() as string}`,
      categories: ["sources"]
    });
    expect(result.status).toBe("escape");
  });

  it("reports rootNotFound for a missing project root", async () => {
    const inspector = new NodeProjectInventoryInspector();
    const result = await inspector.inspectProjectInventory({
      projectRoot: "/definitely/not/here/taphound-missing",
      projectDir: "app",
      categories: ["sources"]
    });
    expect(result.status).toBe("rootNotFound");
  });
});
