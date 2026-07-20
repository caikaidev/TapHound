import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const brandRoot = join(root, "assets", "brand");
const svgFiles = [
  "taphound-icon.svg",
  "taphound-icon-dark.svg",
  "taphound-mark.svg",
  "taphound-mark-mono-dark.svg",
  "taphound-mark-mono-light.svg"
] as const;
const pngSizes = [1024, 512, 256, 128, 64, 32] as const;

function pngDimensions(content: Buffer): {
  width: number;
  height: number;
} {
  expect(content.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  );
  return {
    width: content.readUInt32BE(16),
    height: content.readUInt32BE(20)
  };
}

describe("TapHound brand assets", () => {
  it("keeps every SVG standalone and safe", async () => {
    for (const filename of svgFiles) {
      const svg = await readFile(join(brandRoot, filename), "utf8");

      expect(svg).toContain('viewBox="0 0 1024 1024"');
      expect(svg).toMatch(/<title(?:\s[^>]*)?>TapHound/);
      expect(svg).not.toMatch(
        /<(?:script|image|filter|text)\b|\bhref=|\burl\(/i
      );
    }
  });

  it("uses only the approved primary palette", async () => {
    const svg = await readFile(
      join(brandRoot, "taphound-icon.svg"),
      "utf8"
    );
    const colors = [...new Set(
      [...svg.matchAll(/#[\dA-F]{6}/g)].map(([color]) => color)
    )].sort();

    expect(colors).toEqual(["#1B1D21", "#FF5A1F", "#FFF8F2"].sort());
  });

  it.each(pngSizes)("exports a %d px square PNG", async (size) => {
    const png = await readFile(join(
      brandRoot,
      "png",
      `taphound-icon-${String(size)}.png`
    ));

    expect(pngDimensions(png)).toEqual({ width: size, height: size });
  });

  it("wires the mark into README and npm files", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const packageDocument = JSON.parse(
      await readFile(join(root, "package.json"), "utf8")
    ) as { files?: string[] };

    expect(readme).toContain("assets/brand/taphound-mark.svg");
    expect(packageDocument.files).toContain(
      "assets/brand/taphound-mark.svg"
    );
  });
});
