import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileSystemTargetConfigStore } from "../../src/adapters/filesystem/target-config-store.js";

let home: string;

async function makeHome(): Promise<string> {
  home = await mkdtemp(join(tmpdir(), "taphound-targets-"));
  await mkdir(join(home, "benchmarks"), { recursive: true });
  return home;
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("FileSystemTargetConfigStore", () => {
  it("loads official plus local targets with local override", async () => {
    await makeHome();
    await writeFile(join(home, "benchmarks/targets.json"), JSON.stringify({
      version: 1,
      targets: { amaze: { source: { type: "local", path: "/a/amaze" }, run: { packageName: "a.b.c" } } }
    }));
    await writeFile(join(home, "benchmarks/targets.local.json"), JSON.stringify({
      version: 1,
      targets: { "work-app": { source: { type: "local", path: "${TAPHOUND_WORK_APP}" }, run: { packageName: "com.example.app" } } }
    }));
    const store = new FileSystemTargetConfigStore();
    const loaded = await store.loadTargets(home);
    expect(Object.keys(loaded.targets)).toEqual(["amaze", "work-app"]);
    expect(loaded.targets["work-app"]?.id).toBe("work-app");
  });

  it("rejects a local id that duplicates an official id without override", async () => {
    await makeHome();
    await writeFile(join(home, "benchmarks/targets.json"), JSON.stringify({
      version: 1,
      targets: { amaze: { source: { type: "local", path: "/a/amaze" }, run: { packageName: "a.b.c" } } }
    }));
    await writeFile(join(home, "benchmarks/targets.local.json"), JSON.stringify({
      version: 1,
      targets: { amaze: { source: { type: "local", path: "/b/other" }, run: { packageName: "x.y.z" } } }
    }));
    const store = new FileSystemTargetConfigStore();
    await expect(store.loadTargets(home)).rejects.toMatchObject({
      code: "TARGET_ID_CONFLICT"
    });
  });

  it("writes appendLocalTarget atomically and preserves existing ids", async () => {
    await makeHome();
    const store = new FileSystemTargetConfigStore();
    await store.appendLocalTarget(home, "work-app", {
      source: { type: "local", path: "${TAPHOUND_WORK_APP}" },
      run: { packageName: "com.example.app", activity: ".MainActivity" }
    });
    await store.appendLocalTarget(home, "mail-app", {
      source: { type: "local", path: "${MAIL_APP}" },
      run: { packageName: "com.example.mail", activity: ".MainActivity" }
    });
    const loaded = await store.loadTargets(home);
    expect(Object.keys(loaded.targets).sort()).toEqual(["mail-app", "work-app"]);
    const raw = JSON.parse(
      await readFile(join(home, "benchmarks/targets.local.json"), "utf8")
    ) as { version: number };
    expect(raw.version).toBe(1);
  });

  it("returns empty targets when no config files exist", async () => {
    await makeHome();
    const store = new FileSystemTargetConfigStore();
    const loaded = await store.loadTargets(home);
    expect(loaded.targets).toEqual({});
  });

  it("rejects with TARGET_CONFIG_INVALID when a config file contains invalid JSON", async () => {
    await makeHome();
    await writeFile(join(home, "benchmarks/targets.json"), '{ "version": 1,');
    const store = new FileSystemTargetConfigStore();
    await expect(store.loadTargets(home)).rejects.toMatchObject({
      code: "TARGET_CONFIG_INVALID"
    });
  });
});