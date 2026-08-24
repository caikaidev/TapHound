import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import { ExternalFlowSchema } from "../../domain/external-flow.js";
import { EXTERNAL_FLOWS_DIR } from "../../domain/workspace.js";
import type {
  ExternalFlowCatalogEntry,
  ExternalFlowRecord,
  ExternalFlowRegistry,
  WriteExternalFlowInput,
  WriteExternalFlowResult
} from "../../ports/external-flow-registry.js";

const MAX_EXTERNAL_FLOW_BYTES = 1024 * 1024;

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    );
}

function flowFileName(name: string): string {
  return `${name}.json`;
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return {
      code: "EXTERNAL_FLOW_INVALID",
      message: error.message
    };
  }
  return {
    code: "EXTERNAL_FLOW_INVALID",
    message: String(error)
  };
}

interface LoadedFlow {
  bytes: Buffer;
  flow: ExternalFlowRecord["flow"];
  path: string;
  source: "builtin" | "project";
}

export class FileSystemExternalFlowRegistry
implements ExternalFlowRegistry {
  public constructor(
    private readonly builtinFlowsRoot: string
  ) {}

  public readonly read = async (input: {
    projectRoot: string;
    name: string;
  }): Promise<ExternalFlowRecord> => {
    const loaded = await this.loadFlow(input.projectRoot, input.name);
    return {
      bytes: loaded.bytes,
      flow: loaded.flow,
      source: loaded.source,
      path: loaded.path
    };
  };

  public readonly list = async (
    projectRoot: string
  ): Promise<readonly ExternalFlowCatalogEntry[]> => {
    const builtinEntries = await this.listBuiltinFlows();
    const projectEntries = await this.listProjectFlows(projectRoot);
    const projectNames = new Set(projectEntries.map((entry) => entry.name));
    const entries = [
      ...projectEntries,
      ...builtinEntries.filter((entry) => !projectNames.has(entry.name))
    ];
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  };

  public readonly write = async (
    input: WriteExternalFlowInput
  ): Promise<WriteExternalFlowResult> => {
    const { projectRoot, name, flow, force } = input;
    const canonicalRoot = await realpath(projectRoot);
    const externalRoot = resolve(canonicalRoot, EXTERNAL_FLOWS_DIR);
    const targetPath = join(externalRoot, flowFileName(name));
    const canonicalExternalRoot = await realpath(externalRoot).catch(
      (error: unknown) => {
        if (
          error instanceof Error
          && "code" in error
          && (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      }
    );
    if (
      canonicalExternalRoot !== undefined
      && !contained(canonicalRoot, canonicalExternalRoot)
    ) {
      throw new Error("External Flow directory escapes the project root");
    }
    const rootStats = await lstat(externalRoot).catch((error: unknown) => {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (rootStats !== undefined && rootStats.isSymbolicLink()) {
      throw new Error("External Flow directory is a symlink");
    }

    const validated = ExternalFlowSchema.parse(flow);
    if (validated.name !== name) {
      throw new Error(
        `External Flow declares name "${validated.name}", expected "${name}"`
      );
    }

    let overwritten = false;
    const existingStats = await lstat(targetPath).catch((error: unknown) => {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (existingStats !== undefined) {
      if (existingStats.isSymbolicLink()) {
        throw new Error(`External Flow target is a symlink: ${targetPath}`);
      }
      if (!force) {
        throw new Error(`External Flow already exists: ${name}`);
      }
      overwritten = true;
    }

    const parentDir = name.includes("/")
      ? join(externalRoot, name.split("/").slice(0, -1).join("/"))
      : externalRoot;
    await mkdir(parentDir, { recursive: true });
    const tempPath = `${targetPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`);
    await rename(tempPath, targetPath);

    const relativePath = relative(canonicalRoot, targetPath).replaceAll(
      "\\",
      "/"
    );
    return { path: relativePath, overwritten };
  };

  private readonly loadFlow = async (
    projectRoot: string,
    name: string
  ): Promise<LoadedFlow> => {
    const projectPath = await this.resolveProjectFlowPath(
      projectRoot,
      name
    );
    if (projectPath !== undefined) {
      return this.readFlowFile(projectPath, name, "project");
    }
    const builtinPath = await this.resolveBuiltinFlowPath(name);
    if (builtinPath !== undefined) {
      return this.readFlowFile(builtinPath, name, "builtin");
    }
    throw new Error(`External Flow not found: ${name}`);
  };

  private readonly resolveProjectFlowPath = async (
    projectRoot: string,
    name: string
  ): Promise<string | undefined> => {
    const canonicalRoot = await realpath(projectRoot);
    const externalRoot = resolve(canonicalRoot, EXTERNAL_FLOWS_DIR);
    try {
      const canonicalExternalRoot = await realpath(externalRoot);
      if (!contained(canonicalRoot, canonicalExternalRoot)) {
        throw new Error("External Flow directory escapes the project root");
      }
      const rootStats = await lstat(externalRoot);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        return undefined;
      }
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
    const filePath = join(externalRoot, flowFileName(name));
    try {
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return undefined;
      }
      return filePath;
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  };

  private readonly resolveBuiltinFlowPath = async (
    name: string
  ): Promise<string | undefined> => {
    const filePath = join(this.builtinFlowsRoot, flowFileName(name));
    try {
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return undefined;
      }
      return filePath;
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  };

  private readonly readFlowFile = async (
    filePath: string,
    expectedName: string,
    source: "builtin" | "project"
  ): Promise<LoadedFlow> => {
    const bytes = await readFile(filePath);
    if (bytes.byteLength > MAX_EXTERNAL_FLOW_BYTES) {
      throw new Error(
        `External Flow exceeds ${String(MAX_EXTERNAL_FLOW_BYTES)} bytes: ${filePath}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(
        `External Flow is not valid JSON: ${filePath}`,
        { cause: error }
      );
    }
    const flow = ExternalFlowSchema.parse(parsed);
    if (flow.name !== expectedName) {
      throw new Error(
        `External Flow at ${filePath} declares name "${flow.name}", expected "${expectedName}"`
      );
    }
    return { bytes, flow, path: filePath, source };
  };

  private readonly listBuiltinFlows = async (): Promise<
    ExternalFlowCatalogEntry[]
  > => {
    let rootStats: Stats;
    try {
      rootStats = await lstat(this.builtinFlowsRoot);
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return [];
    }
    const paths: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(
            `Built-in External Flow catalog cannot contain symlinks: ${path}`
          );
        }
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          paths.push(path);
        }
      }
    };
    await visit(this.builtinFlowsRoot);
    paths.sort();
    const results: ExternalFlowCatalogEntry[] = [];
    for (const filePath of paths) {
      const relativePath = relative(this.builtinFlowsRoot, filePath).replaceAll(
        "\\",
        "/"
      );
      const name = relativePath.slice(0, -".json".length);
      try {
        const loaded = await this.readFlowFile(filePath, name, "builtin");
        results.push({
          name,
          source: "builtin",
          path: filePath,
          status: "valid",
          escapedPackageName: loaded.flow.escapedPackageName,
          stepCount: loaded.flow.steps.length
        });
      } catch (error) {
        results.push({
          name,
          source: "builtin",
          path: filePath,
          status: "invalid",
          failure: errorDetails(error)
        });
      }
    }
    return results;
  };

  private readonly listProjectFlows = async (
    projectRoot: string
  ): Promise<ExternalFlowCatalogEntry[]> => {
    const canonicalRoot = await realpath(projectRoot);
    const externalRoot = resolve(canonicalRoot, EXTERNAL_FLOWS_DIR);
    try {
      const canonicalExternalRoot = await realpath(externalRoot);
      if (!contained(canonicalRoot, canonicalExternalRoot)) {
        throw new Error("External Flow directory escapes the project root");
      }
      const rootStats = await lstat(externalRoot);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        return [];
      }
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
    const paths: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(
            `External Flow catalog cannot contain symlinks: ${path}`
          );
        }
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          paths.push(path);
        }
      }
    };
    await visit(externalRoot);
    paths.sort();
    const results: ExternalFlowCatalogEntry[] = [];
    for (const filePath of paths) {
      const relativePath = relative(canonicalRoot, filePath).replaceAll(
        "\\",
        "/"
      );
      const name = relativePath
        .slice(`${EXTERNAL_FLOWS_DIR}/`.length, -".json".length);
      try {
        const loaded = await this.readFlowFile(filePath, name, "project");
        results.push({
          name,
          source: "project",
          path: relativePath,
          status: "valid",
          escapedPackageName: loaded.flow.escapedPackageName,
          stepCount: loaded.flow.steps.length
        });
      } catch (error) {
        results.push({
          name,
          source: "project",
          path: relativePath,
          status: "invalid",
          failure: errorDetails(error)
        });
      }
    }
    return results;
  };
}
