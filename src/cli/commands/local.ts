import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Command } from "commander";

import {
  exitCodeForFailure,
  type TapHoundExitCode
} from "../../domain/failure.js";
import {
  DEFAULT_TARGET_ACTIVITY,
  TargetError,
  type LocalTargetIdentity
} from "../../domain/target.js";
import { TARGETS_LOCAL_CONFIG_PATH } from "../../domain/workspace.js";
import type { ProcessRunner } from "../../ports/process-runner.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";

interface LocalOptions {
  targets?: string | undefined;
  json?: boolean | undefined;
}

interface AddOptions extends LocalOptions {
  path: string;
  package?: string | undefined;
}

interface GitInfo {
  head?: string | undefined;
  branch?: string | undefined;
  dirty: boolean;
}

interface ListTargetRow {
  id: string;
  status: "READY" | "MISSING";
  source: string;
  resolvedPath?: string | undefined;
  workspaceRoot?: string | undefined;
}

function targetsHome(
  dependencies: CliDependencies,
  explicit: string | undefined
): string {
  if (explicit !== undefined) {
    return resolve(dependencies.cwd(), explicit);
  }
  return dependencies.localTargets.targetsHome();
}

function writeFailure(
  dependencies: CliDependencies,
  json: boolean,
  code: Parameters<typeof failureOutput>[1],
  message: string,
  exitCode: TapHoundExitCode
): void {
  const output = failureOutput(exitCode, code, message);
  if (json) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, output.failure.message);
  }
  dependencies.setExitCode(exitCode);
}

async function gitValue(
  runner: ProcessRunner,
  root: string,
  args: readonly string[]
): Promise<string | undefined> {
  const result = await runner.run({
    executable: "git",
    args: ["-C", root, ...args]
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  const value = result.stdout.trim();
  return value.length === 0 ? undefined : value;
}

async function inspectGit(
  dependencies: CliDependencies,
  root: string | undefined
): Promise<GitInfo | null> {
  if (root === undefined) {
    return null;
  }
  const runner = dependencies.localTargets.processRunner;
  const [head, branch, status] = await Promise.all([
    gitValue(runner, root, ["rev-parse", "HEAD"]),
    gitValue(runner, root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runner.run({
      executable: "git",
      args: ["-C", root, "status", "--porcelain"]
    })
  ]);
  const info: GitInfo = {
    dirty: status.exitCode === 0 && status.stdout.trim().length > 0,
    ...(head === undefined ? {} : { head }),
    ...(branch === undefined ? {} : { branch })
  };
  return info;
}

async function countJourneys(
  root: string
): Promise<number> {
  try {
    const entries = await readdir(join(root, "journeys"), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

export function createLocalCommand(dependencies: CliDependencies): Command {
  const withTargetsAndJson = (command: Command): Command => command
    .option("--targets <path>", "Targets workspace base path")
    .option("--json", "Emit one machine-readable JSON value");

  return new Command("local")
    .description("Manage locally registered Android targets")
    .addCommand(withTargetsAndJson(new Command("add")
      .description("Register a local Android target")
      .argument("<id>", "Target id")
      .requiredOption("--path <path>", "Path to the Android project")
      .option("--package <name>", "Android application package name")
      .action(async (id: string, options: AddOptions): Promise<void> => {
        const json = options.json === true;
        const home = targetsHome(dependencies, options.targets);
        const resolver = dependencies.localTargets.targetResolver(home);
        const workspace = dependencies.localTargets.workspace;
        const configStore = dependencies.localTargets.configStore;
        let resolved;
        try {
          const existing = (await configStore.loadTargets(home)).targets[id];
          const packageName = options.package ?? existing?.run.packageName;
          if (packageName === undefined) {
            writeFailure(
              dependencies,
              json,
              "TARGET_CONFIG_INVALID",
              `Target ${id} has no packageName. Run: taphound local add ${id} --path '${options.path}' --package <name>`,
              2
            );
            return;
          }
          const probe = await resolver.resolveByPath(options.path);
          const fingerprint = await resolver.fingerprint(
            probe.project,
            packageName
          );
          const workspaceRoot = workspace.root(home, id);
          await configStore.appendLocalTarget(home, id, {
            source: { type: "local", path: probe.configuredPath },
            run: {
              packageName,
              activity: DEFAULT_TARGET_ACTIVITY
            }
          });
          await workspace.ensureWorkspace(home, id);
          const now = dependencies.localTargets.clock.now().toISOString();
          const identity: LocalTargetIdentity = {
            schemaVersion: 1,
            targetId: id,
            sourceType: "local",
            configuredPath: probe.configuredPath,
            resolvedPath: probe.resolvedPath,
            fingerprint,
            packageName,
            createdAt: now,
            updatedAt: now
          };
          await workspace.writeIdentity(home, id, identity);
          resolved = {
            id,
            configuredPath: probe.configuredPath,
            resolvedPath: probe.resolvedPath,
            workspaceRoot,
            detected: {
              gradleRoot: probe.project.rootDir,
              gitRepo: probe.project.gitRoot ?? null,
              packageName
            },
            config: TARGETS_LOCAL_CONFIG_PATH
          };
        } catch (error) {
          if (error instanceof TargetError) {
            writeFailure(
              dependencies,
              json,
              error.code,
              error.message,
              exitCodeForFailure(error.code)
            );
            return;
          }
          writeFailure(
            dependencies,
            json,
            "INTERNAL_ERROR",
            errorMessage(error),
            4
          );
          return;
        }
        if (json) {
          writeJson(dependencies.stdout, resolved);
        } else {
          writeLine(
            dependencies.stdout,
            `Registered local target ${id} at ${resolved.resolvedPath}`
          );
        }
        dependencies.setExitCode(0);
      })))
    .addCommand(withTargetsAndJson(new Command("list")
      .description("List registered local targets")
      .action(async (options: LocalOptions): Promise<void> => {
        const json = options.json === true;
        const home = targetsHome(dependencies, options.targets);
        const configStore = dependencies.localTargets.configStore;
        const resolver = dependencies.localTargets.targetResolver(home);
        const rows: ListTargetRow[] = [];
        try {
          const loaded = await configStore.loadTargets(home);
          for (const [id, entry] of Object.entries(loaded.targets).sort()) {
            try {
              const target = await resolver.resolve(id);
              rows.push({
                id,
                status: "READY",
                source: entry.source.path,
                resolvedPath: target.resolvedPath,
                workspaceRoot: target.workspaceRoot
              });
            } catch {
              rows.push({
                id,
                status: "MISSING",
                source: entry.source.path
              });
            }
          }
        } catch (error) {
          writeFailure(
            dependencies,
            json,
            error instanceof TargetError ? error.code : "INTERNAL_ERROR",
            errorMessage(error),
            error instanceof TargetError
              ? exitCodeForFailure(error.code)
              : 4
          );
          return;
        }
        if (json) {
          writeJson(dependencies.stdout, { targets: rows });
        } else {
          for (const row of rows) {
            writeLine(
              dependencies.stdout,
              `${row.status}  ${row.id}  ${row.source}`
            );
          }
        }
        dependencies.setExitCode(0);
      })))
    .addCommand(withTargetsAndJson(new Command("inspect")
      .description("Inspect a registered local target")
      .argument("<id>", "Target id")
      .action(async (id: string, options: LocalOptions): Promise<void> => {
        const json = options.json === true;
        const home = targetsHome(dependencies, options.targets);
        const resolver = dependencies.localTargets.targetResolver(home);
        const workspace = dependencies.localTargets.workspace;
        const configStore = dependencies.localTargets.configStore;
        try {
          const target = await resolver.resolve(id);
          const identity = await workspace.readIdentity(home, id);
          const entry = (await configStore.loadTargets(home)).targets[id];
          const packageName = identity?.packageName ?? entry?.run.packageName;
          const git = await inspectGit(
            dependencies,
            target.project.gitRoot
          );
          const journeys = await countJourneys(target.workspaceRoot);
          const report = {
            id,
            sourceType: "local",
            configuredPath: target.configuredPath,
            resolvedPath: target.resolvedPath,
            workspaceRoot: target.workspaceRoot,
            git,
            packageName: packageName ?? null,
            context: identity === null ? ("missing" as const) : ("fresh" as const),
            journeys,
            identity
          };
          if (json) {
            writeJson(dependencies.stdout, report);
          } else {
            writeLine(dependencies.stdout, `Target ${id}`);
            writeLine(dependencies.stdout, `  path: ${target.resolvedPath}`);
            writeLine(dependencies.stdout, `  context: ${report.context}`);
            writeLine(dependencies.stdout, `  journeys: ${String(journeys)}`);
          }
          dependencies.setExitCode(0);
        } catch (error) {
          if (error instanceof TargetError) {
            writeFailure(
              dependencies,
              json,
              error.code,
              error.message,
              exitCodeForFailure(error.code)
            );
            return;
          }
          writeFailure(
            dependencies,
            json,
            "INTERNAL_ERROR",
            errorMessage(error),
            4
          );
        }
      })))
    .addCommand(withTargetsAndJson(new Command("remove")
      .description("Remove a registered local target")
      .argument("<id>", "Target id")
      .action(async (id: string, options: LocalOptions): Promise<void> => {
        const json = options.json === true;
        const home = targetsHome(dependencies, options.targets);
        const configStore = dependencies.localTargets.configStore;
        try {
          const removed = await configStore.removeLocalTarget(home, id);
          if (json) {
            writeJson(dependencies.stdout, { id, removed });
          } else {
            writeLine(
              dependencies.stdout,
              removed
                ? `Removed local target ${id}`
                : `Local target ${id} is not registered`
            );
          }
          dependencies.setExitCode(0);
        } catch (error) {
          writeFailure(
            dependencies,
            json,
            error instanceof TargetError ? error.code : "INTERNAL_ERROR",
            errorMessage(error),
            error instanceof TargetError
              ? exitCodeForFailure(error.code)
              : 4
          );
        }
      })));
}