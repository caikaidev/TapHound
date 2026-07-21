import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { defaultExclude } from "vitest/config";

interface PackageDocument {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  description?: string;
  license?: string;
  repository?: { type?: string; url?: string };
  bugs?: { url?: string };
  homepage?: string;
  publishConfig?: { access?: string; tag?: string };
  files?: string[];
  scripts?: Record<string, string>;
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
    expect(document.bin).not.toHaveProperty(["a", "pr"].join(""));
  });

  it("declares release-safe Apache-2.0 metadata", async () => {
    const document = JSON.parse(
      await readFile("package.json", "utf8")
    ) as PackageDocument;

    expect(document).toMatchObject({
      license: "Apache-2.0",
      repository: {
        type: "git",
        url: "git+https://github.com/caikaidev/TapHound.git"
      },
      bugs: {
        url: "https://github.com/caikaidev/TapHound/issues"
      },
      homepage: "https://github.com/caikaidev/TapHound#readme",
      publishConfig: {
        access: "public",
        tag: "dev"
      }
    });
    expect(document.files).toEqual([
      "dist",
      "assets/brand/taphound-mark.svg"
    ]);
    expect(document.scripts?.prepublishOnly)
      .toBe("npm test && npm run typecheck && npm run lint && npm run build");

    const license = await readFile("LICENSE", "utf8");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0");
    expect(license).toContain("http://www.apache.org/licenses/");
  });

  it("builds publication files without source maps", async () => {
    const document = JSON.parse(
      await readFile("package.json", "utf8")
    ) as PackageDocument;
    const buildConfig = JSON.parse(
      await readFile("tsconfig.build.json", "utf8")
    ) as { compilerOptions?: { sourceMap?: boolean } };

    expect(document.scripts?.build).toBe("node scripts/build.mjs");
    expect(buildConfig.compilerOptions?.sourceMap).toBe(false);
  });

  it("excludes nested Git worktrees from test discovery", async () => {
    const config = await readFile("vitest.config.ts", "utf8");
    const typeScriptConfig = JSON.parse(
      await readFile("tsconfig.json", "utf8")
    ) as { include?: string[] };

    expect(defaultExclude).toEqual(["**/node_modules/**", "**/.git/**"]);
    expect(config).toContain("...defaultExclude");
    expect(config).toContain(JSON.stringify("**/.worktrees/**"));
    expect(typeScriptConfig.include).toContain("vitest.config.ts");
  });
});
