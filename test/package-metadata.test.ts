import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageDocument {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  description?: string;
}

describe("TapHound package metadata", () => {
  it("publishes only the taphound executable", async () => {
    const document = JSON.parse(
      await readFile("package.json", "utf8")
    ) as PackageDocument;

    expect(document.name).toBe("taphound");
    expect(document.version).toBe("0.2.0-dev.1");
    expect(document.description)
      .toBe("Deterministic app journey recording and verification");
    expect(document.bin).toEqual({ taphound: "./dist/cli/main.js" });
    expect(document.bin).not.toHaveProperty("apr");
  });
});
