import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalSyncService } from "../../src/application/target/local-sync-service.js";
import { NodeLocalAssetSync } from "../../src/adapters/filesystem/local-asset-sync.js";

let root: string;
let projectRoot: string;
let targetsHome: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "taphound-sync-"));
  projectRoot = join(root, "project");
  targetsHome = join(root, "targets");
  await mkdir(join(projectRoot, ".taphound", "context", "modules"), { recursive: true });
  await mkdir(join(projectRoot, ".taphound", "journeys"), { recursive: true });
  await mkdir(join(projectRoot, ".taphound", "knowledge", "anchors"), { recursive: true });
  await mkdir(join(projectRoot, ".taphound", "contracts"), { recursive: true });
  await mkdir(join(projectRoot, ".taphound", "playbooks"), { recursive: true });
  await mkdir(join(projectRoot, ".taphound", "build", "runs"), { recursive: true });
  await writeFile(
    join(projectRoot, ".taphound", "context", "project-context.json"),
    "{\"version\":2}"
  );
  await writeFile(
    join(projectRoot, ".taphound", "context", "modules", "app.json"),
    "{\"module\":\"app\"}"
  );
  await writeFile(
    join(projectRoot, ".taphound", "journeys", "search.json"),
    "{\"journey\":\"search\"}"
  );
  await writeFile(
    join(projectRoot, ".taphound", "knowledge", "anchors", "open.json"),
    "{\"anchor\":\"open\"}"
  );
  await writeFile(
    join(projectRoot, ".taphound", "contracts", "search.json"),
    "{\"contract\":\"search\"}"
  );
  await writeFile(
    join(projectRoot, ".taphound", "playbooks", "regression.json"),
    "{\"playbook\":\"regression\"}"
  );
  await writeFile(
    join(projectRoot, ".taphound", "build", "runs", "report.json"),
    "{\"run\":\"ignored\"}"
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalSyncService", () => {
  const service = new LocalSyncService({
    workspaceRoot: (home: string, targetId: string): string =>
      join(home, ".taphound", "local", targetId),
    assetSync: new NodeLocalAssetSync()
  });

  it("syncs committed asset dirs into the target workspace", async () => {
    const result = await service.sync({
      targetId: "demo",
      projectRoot,
      targetsHome
    });
    expect(result.syncedDirs).toContain(".taphound/context");
    expect(result.syncedDirs).toContain(".taphound/journeys");
    expect(result.syncedDirs).toContain(".taphound/knowledge");
    expect(result.syncedDirs).toContain(".taphound/contracts");
    expect(result.syncedDirs).toContain(".taphound/playbooks");
    expect(result.filesCopied).toBeGreaterThanOrEqual(6);
    expect(result.skippedBuild).toBe(true);

    const workspace = join(targetsHome, ".taphound", "local", "demo");
    expect(
      await readFile(join(workspace, "context", "project-context.json"), "utf8")
    ).toContain("version");
    expect(
      await readFile(join(workspace, "journeys", "search.json"), "utf8")
    ).toContain("search");
  });

  it("never copies the build subtree", async () => {
    const workspace = join(targetsHome, ".taphound", "local", "demo");
    const buildReport = join(workspace, "build", "runs", "report.json");
    await expect(readFile(buildReport, "utf8")).rejects.toThrow();
  });

  it("is idempotent: a second run reports the same dirs", async () => {
    const first = await service.sync({ targetId: "demo", projectRoot, targetsHome });
    const second = await service.sync({ targetId: "demo", projectRoot, targetsHome });
    expect(second.syncedDirs).toEqual(first.syncedDirs);
    expect(second.filesCopied).toBe(first.filesCopied);
  });
});