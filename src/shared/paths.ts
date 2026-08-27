// Shared path containment and project-relative path utilities.
//
// These helpers were duplicated across filesystem adapters and application
// context services. They are pure path calculations with no side effects.

import { isAbsolute, relative, resolve, sep } from "node:path";

export function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    )
  );
}

export function projectRelativePath(
  projectRoot: string,
  path: string,
  createError: (message: string) => Error
): string {
  const absolutePath = isAbsolute(path) ? path : resolve(projectRoot, path);
  const result = relative(resolve(projectRoot), absolutePath)
    .replaceAll("\\", "/");
  if (
    result.length === 0
    || result === ".."
    || result.startsWith("../")
    || result.startsWith("/")
  ) {
    throw createError("Project Context path must stay within the project");
  }
  return result;
}
