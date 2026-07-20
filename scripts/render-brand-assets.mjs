import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import sharp from "sharp";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(
  repositoryRoot,
  "assets",
  "brand",
  "taphound-icon.svg"
);
const outputDirectory = resolve(
  repositoryRoot,
  "assets",
  "brand",
  "png"
);
const sizes = [1024, 512, 256, 128, 64, 32];

await mkdir(outputDirectory, { recursive: true });
const source = await readFile(sourcePath);
await Promise.all(sizes.map(async (size) => {
  await sharp(source, { density: 384 })
    .resize(size, size, { fit: "fill" })
    .png({ compressionLevel: 9, palette: false })
    .toFile(resolve(
      outputDirectory,
      `taphound-icon-${String(size)}.png`
    ));
}));
