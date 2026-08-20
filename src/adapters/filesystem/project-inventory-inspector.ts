import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ProjectInventoryCategory,
  ProjectInventoryInspection,
  ProjectInventoryInspector
} from "../../ports/project-inventory-inspector.js";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".taphound",
  "build"
]);

function errorCode(error: unknown): string | undefined {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  )
    ? error.code
    : undefined;
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    );
}

function matches(
  path: string,
  categories: ReadonlySet<ProjectInventoryCategory>
): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    (categories.has("manifests") && basename(normalized) === "AndroidManifest.xml")
    || (
      categories.has("sources")
      && (normalized.endsWith(".kt") || normalized.endsWith(".java"))
    )
    || (
      categories.has("layouts")
      && /\/res\/layout[^/]*\/[^/]+\.xml$/.test(`/${normalized}`)
    )
    || (
      categories.has("navigation")
      && /\/res\/navigation[^/]*\/[^/]+\.xml$/.test(`/${normalized}`)
    )
  );
}

export class NodeProjectInventoryInspector
implements ProjectInventoryInspector {
  public readonly inspectProjectInventory = async (input: {
    projectRoot: string;
    projectDir: string;
    categories: ProjectInventoryCategory[];
  }): Promise<ProjectInventoryInspection> => {
    let root: string;
    let moduleRoot: string;
    try {
      root = await realpath(input.projectRoot);
      const rootStats = await stat(root);
      if (!rootStats.isDirectory()) {
        return { status: "rootNotDirectory" };
      }
      moduleRoot = await realpath(resolve(root, input.projectDir));
      const moduleStats = await stat(moduleRoot);
      if (!moduleStats.isDirectory()) {
        return { status: "rootNotDirectory" };
      }
    } catch (error) {
      return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR"
        ? { status: "rootNotFound" }
        : { status: "rootUnreadable" };
    }
    if (!isContained(root, moduleRoot)) {
      return { status: "escape" };
    }

    const categories = new Set(input.categories);
    const paths: string[] = [];
    const pending = [moduleRoot];
    try {
      while (pending.length > 0) {
        const directory = pending.pop();
        if (directory === undefined) {
          continue;
        }
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const path = resolve(directory, entry.name);
          if (entry.isSymbolicLink()) {
            continue;
          }
          if (entry.isDirectory()) {
            if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
              pending.push(path);
            }
            continue;
          }
          if (!entry.isFile()) {
            continue;
          }
          const projectRelative = relative(root, path).replaceAll("\\", "/");
          if (matches(projectRelative, categories)) {
            paths.push(projectRelative);
          }
        }
      }
    } catch {
      return { status: "rootUnreadable" };
    }
    paths.sort((left, right) => left.localeCompare(right));
    return {
      status: "inspected",
      paths,
      pathSetSha256: createHash("sha256")
        .update(paths.join("\n"))
        .digest("hex")
    };
  };
}
