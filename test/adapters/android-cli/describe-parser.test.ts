import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  extractDescriptionPaths,
  selectApkArtifact
} from "../../../src/adapters/android-cli/describe-parser.js";

const fixture = fileURLToPath(
  new URL("../../fixtures/android-cli/project-description.json", import.meta.url)
);

describe("extractDescriptionPaths", () => {
  it("extracts JSON paths while ignoring diagnostic lines", () => {
    expect(extractDescriptionPaths([
      "Analyzing project...",
      "/project/.android/description.json",
      "",
      "done"
    ].join("\n"))).toEqual(["/project/.android/description.json"]);
  });
});

describe("selectApkArtifact", () => {
  it("selects the unique APK matching target and variant", async () => {
    const metadata: unknown = JSON.parse(await readFile(fixture, "utf8"));

    expect(selectApkArtifact([metadata], {
      projectDir: "/project",
      target: "app",
      variant: "debug"
    })).toBe("/project/app/build/outputs/apk/debug/app-debug.apk");
  });

  it("rejects an ambiguous match", () => {
    const metadata = {
      target: "app",
      variant: "debug",
      outputs: ["one.apk", "two.apk"]
    };

    expect(() => selectApkArtifact([metadata], {
      projectDir: "/project",
      target: "app",
      variant: "debug"
    })).toThrow(/ambiguous/i);
  });

  it("rejects malformed metadata", () => {
    expect(() => selectApkArtifact([{ modules: "invalid" }], {
      projectDir: "/project",
      target: "app",
      variant: "debug"
    })).toThrow(/artifact/i);
  });
});
