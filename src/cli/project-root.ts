import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export async function canonicalProjectRoot(
  cwd: string,
  projectRoot: string
): Promise<string> {
  const absolute = resolve(cwd, projectRoot);
  return realpath(absolute).catch(() => absolute);
}
