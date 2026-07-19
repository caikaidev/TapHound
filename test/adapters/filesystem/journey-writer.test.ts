import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
    const root = await mkdtemp(join(tmpdir(), "apr-journey-"));
    roots.push(root);
    const output = join(root, "nested", "search.json");

    await new FileSystemJourneyWriter().write(output, runtimeJourney);

    await expect(readFile(output, "utf8")).resolves.toContain('"name": "Search"');
    await expect(readdir(join(root, "nested"))).resolves.toEqual(["search.json"]);
  });
});
