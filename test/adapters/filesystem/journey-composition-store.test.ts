import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemJourneyCompositionStore
} from "../../../src/adapters/filesystem/journey-composition-store.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "taphound-composition-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(
    (path) => rm(path, { recursive: true, force: true })
  ));
});

describe("FileSystemJourneyCompositionStore", () => {
  it("lists nested Flow files and reads their exact bytes", async () => {
    const projectRoot = await root();
    const path = join(projectRoot, ".taphound/flows/core");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "home.json"), "{\"version\":1}\n");
    const store = new FileSystemJourneyCompositionStore();

    await expect(store.listFlowPaths(projectRoot)).resolves.toEqual([
      ".taphound/flows/core/home.json"
    ]);
    await expect(store.read({
      projectRoot,
      relativePath: ".taphound/flows/core/home.json"
    })).resolves.toEqual(Buffer.from("{\"version\":1}\n"));
  });

  it("writes resolved outputs outside the authoritative build subtree", async () => {
    const projectRoot = await root();
    const store = new FileSystemJourneyCompositionStore();

    await store.writeText({
      projectRoot,
      relativePath: ".taphound/journeys/chat/send.json",
      content: "{\"version\":1}\n"
    });

    await expect(readFile(
      join(projectRoot, ".taphound/journeys/chat/send.json"),
      "utf8"
    )).resolves.toBe("{\"version\":1}\n");
    await expect(readFile(
      join(projectRoot, ".taphound/.gitignore"),
      "utf8"
    )).resolves.toBe("build/\n");
  });

  it("rejects symlinked Flow catalogs", async () => {
    const projectRoot = await root();
    const outside = await root();
    await mkdir(join(projectRoot, ".taphound"), { recursive: true });
    await symlink(outside, join(projectRoot, ".taphound/flows"));

    await expect(
      new FileSystemJourneyCompositionStore().listFlowPaths(projectRoot)
    ).rejects.toThrow(/escape|safe directory/i);
  });

  it("skips the external subdirectory when listing base Flows", async () => {
    const projectRoot = await root();
    const flowsRoot = join(projectRoot, ".taphound/flows");
    await mkdir(join(flowsRoot, "external"), { recursive: true });
    await writeFile(
      join(flowsRoot, "external", "camera.json"),
      "{\"version\":1,\"kind\":\"externalFlow\"}\n"
    );
    await mkdir(join(flowsRoot, "core"), { recursive: true });
    await writeFile(
      join(flowsRoot, "core", "home.json"),
      "{\"version\":1}\n"
    );

    const paths = await new FileSystemJourneyCompositionStore()
      .listFlowPaths(projectRoot);

    expect(paths).toEqual([".taphound/flows/core/home.json"]);
    expect(paths.some((p) => p.includes("external"))).toBe(false);
  });

  it("lists nested Journeys without meta or resolve sidecars", async () => {
    const projectRoot = await root();
    const journeysRoot = join(projectRoot, ".taphound/journeys");
    await mkdir(join(journeysRoot, "chat"), { recursive: true });
    await writeFile(join(journeysRoot, "search.json"), "{\"version\":2}\n");
    await writeFile(join(journeysRoot, "search.meta.json"), "{\"version\":1}\n");
    await writeFile(
      join(journeysRoot, "search.resolve.json"),
      "{\"version\":1}\n"
    );
    await writeFile(join(journeysRoot, "chat", "send.json"), "{\"version\":2}\n");
    await writeFile(join(journeysRoot, "chat", "send.meta.json"), "{\"version\":1}\n");
    await writeFile(join(journeysRoot, "notes.txt"), "not a journey\n");

    const paths = await new FileSystemJourneyCompositionStore()
      .listJourneyPaths(projectRoot);

    expect(paths).toEqual([
      ".taphound/journeys/chat/send.json",
      ".taphound/journeys/search.json"
    ]);
  });

  it("returns no Journeys when the directory is absent", async () => {
    const projectRoot = await root();

    await expect(
      new FileSystemJourneyCompositionStore().listJourneyPaths(projectRoot)
    ).resolves.toEqual([]);
  });

  it("rejects symlinked Journey catalogs", async () => {
    const projectRoot = await root();
    const outside = await root();
    await mkdir(join(projectRoot, ".taphound"), { recursive: true });
    await symlink(outside, join(projectRoot, ".taphound/journeys"));

    await expect(
      new FileSystemJourneyCompositionStore().listJourneyPaths(projectRoot)
    ).rejects.toThrow(/escape|safe directory/i);
  });

  it("reads Journey meta sidecars and returns null when absent", async () => {
    const projectRoot = await root();
    const journeysRoot = join(projectRoot, ".taphound/journeys");
    await mkdir(journeysRoot, { recursive: true });
    await writeFile(join(journeysRoot, "search.json"), "{\"version\":2}\n");
    await writeFile(
      join(journeysRoot, "search.meta.json"),
      "{\"version\":1,\"status\":\"verified\"}\n"
    );
    const store = new FileSystemJourneyCompositionStore();

    await expect(store.readJourneyMeta({
      projectRoot,
      journeyPath: ".taphound/journeys/search.json"
    })).resolves.toEqual(
      Buffer.from("{\"version\":1,\"status\":\"verified\"}\n")
    );
    await expect(store.readJourneyMeta({
      projectRoot,
      journeyPath: ".taphound/journeys/missing.json"
    })).resolves.toBeNull();
    await expect(store.readJourneyMeta({
      projectRoot,
      journeyPath: ".taphound/journeys/search.meta.json"
    })).rejects.toThrow(/normalized JSON file/i);
  });
});
