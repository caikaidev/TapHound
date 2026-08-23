import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSystemGenerationMetaWriter } from "../../../src/adapters/filesystem/generation-meta-writer.js";
import { FileSystemJourneyWriter } from "../../../src/adapters/filesystem/journey-writer.js";
import { runtimeJourney } from "../../fakes/runtime-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("FileSystemJourneyWriter", () => {
  it("creates parent directories and atomically publishes validated JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "taphound-journey-"));
    roots.push(root);
    const output = join(root, "nested", "search.json");

    await new FileSystemJourneyWriter().write(output, runtimeJourney);

    await expect(readFile(output, "utf8")).resolves.toContain('"name": "Search"');
    await expect(readdir(join(root, "nested"))).resolves.toEqual(["search.json"]);
  });

  it("rejects a project output parent symlink without writing outside", async () => {
    const root = await mkdtemp(join(tmpdir(), "taphound-journey-"));
    const outside = await mkdtemp(join(tmpdir(), "taphound-outside-"));
    roots.push(root, outside);
    await mkdir(join(root, ".taphound", "build"), { recursive: true });
    await symlink(outside, join(root, ".taphound", "journeys"));

    await expect(new FileSystemJourneyWriter().writeProjectBound({
      projectRoot: root,
      authorityRoot: join(root, ".taphound", "build"),
      outputPath: join(root, ".taphound", "journeys", "search.json"),
      journey: runtimeJourney
    })).rejects.toThrow(/symlink|directory|safe/i);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("rejects aliases into the authority subtree", async () => {
    const root = await mkdtemp(join(tmpdir(), "taphound-journey-"));
    roots.push(root);
    const authority = join(root, ".taphound", "build");
    const generation = join(authority, "generations", "generation-1");
    await mkdir(generation, { recursive: true });
    await writeFile(join(generation, "manifest.json"), "authority", "utf8");
    await symlink(generation, join(root, ".taphound", "journeys"));

    await expect(new FileSystemJourneyWriter().writeProjectBound({
      projectRoot: root,
      authorityRoot: authority,
      outputPath: join(root, ".taphound", "journeys", "search.json"),
      journey: runtimeJourney
    })).rejects.toThrow(/authority|symlink|safe/i);
    await expect(readFile(
      join(generation, "manifest.json"),
      "utf8"
    )).resolves.toBe("authority");
  });

  it("does not overwrite a destination symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "taphound-journey-"));
    const outside = await mkdtemp(join(tmpdir(), "taphound-outside-"));
    roots.push(root, outside);
    await mkdir(join(root, ".taphound", "build"), { recursive: true });
    await mkdir(join(root, ".taphound", "journeys"));
    const victim = join(outside, "victim.json");
    await writeFile(victim, "unchanged", "utf8");
    await symlink(victim, join(root, ".taphound", "journeys", "search.json"));

    await expect(new FileSystemJourneyWriter().writeProjectBound({
      projectRoot: root,
      authorityRoot: join(root, ".taphound", "build"),
      outputPath: join(root, ".taphound", "journeys", "search.json"),
      journey: runtimeJourney
    })).rejects.toThrow(/regular|symlink|safe/i);
    await expect(readFile(victim, "utf8")).resolves.toBe("unchanged");
  });

  it("detects parent substitution immediately before install", async () => {
    const root = await mkdtemp(join(tmpdir(), "taphound-journey-"));
    const outside = await mkdtemp(join(tmpdir(), "taphound-outside-"));
    roots.push(root, outside);
    await mkdir(join(root, ".taphound", "build"), { recursive: true });
    await mkdir(join(root, ".taphound", "journeys"));
    const moved = join(root, ".taphound", "journeys-moved");
    const writer = new FileSystemJourneyWriter({
      beforeBoundInstall: async (): Promise<void> => {
        await rename(join(root, ".taphound", "journeys"), moved);
        await symlink(outside, join(root, ".taphound", "journeys"));
      }
    });

    await expect(writer.writeProjectBound({
      projectRoot: root,
      authorityRoot: join(root, ".taphound", "build"),
      outputPath: join(root, ".taphound", "journeys", "search.json"),
      journey: runtimeJourney
    })).rejects.toThrow(/identity|symlink|safe/i);
    await expect(readdir(outside)).resolves.toEqual([]);
    await expect(readdir(join(root, ".taphound", "build"))).resolves.toEqual([]);
  });

  it("detects parent substitution before generation meta install", async () => {
    const root = await mkdtemp(join(tmpdir(), "taphound-meta-"));
    const outside = await mkdtemp(join(tmpdir(), "taphound-outside-"));
    roots.push(root, outside);
    await mkdir(join(root, ".taphound", "build"), { recursive: true });
    await mkdir(join(root, ".taphound", "journeys"));
    const moved = join(root, ".taphound", "journeys-moved");
    const writer = new FileSystemGenerationMetaWriter({
      beforeBoundInstall: async (): Promise<void> => {
        await rename(join(root, ".taphound", "journeys"), moved);
        await symlink(outside, join(root, ".taphound", "journeys"));
      }
    });

    await expect(writer.writeProjectBound({
      projectRoot: root,
      authorityRoot: join(root, ".taphound", "build"),
      outputPath: join(root, ".taphound", "journeys", "search.meta.json"),
      meta: {
        version: 1,
        status: "verified",
        generationId: "generation-1",
        journeyPath: ".taphound/journeys/search.json",
        bindings: {
          projectHash: "a".repeat(64),
          configHash: "b".repeat(64),
          contextHash: "c".repeat(64)
        },
        verification: {
          reportPath: "verification/report.json",
          reportSha256: "d".repeat(64),
          runId: "verify-run",
          runs: 1
        },
        manualOverrideStepIndexes: [],
        externalFlows: []
      }
    })).rejects.toThrow(/identity|symlink|safe/i);
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});
