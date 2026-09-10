import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Command } from "commander";

import {
  TapHoundConfigSchema,
  type TapHoundConfig
} from "../../domain/config.js";
import { CONFIG_PATH } from "../../domain/workspace.js";
import {
  exitCodeForFailure,
  failureCodeFromUnknown,
  type FailureCode
} from "../../domain/failure.js";
import type {
  ResolvedTarget,
  TargetEntry
} from "../../domain/target.js";
import { hasAndroidProjectStructure } from "../../adapters/filesystem/android-project-detection.js";
import { isErrnoException } from "../../shared/errors.js";
import type { CliDependencies } from "../dependencies.js";
import {
  doctorMessage,
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";

interface DoctorOptions {
  project: string;
  config: string;
  device?: string | undefined;
  target?: string | undefined;
  targets?: string | undefined;
  json?: boolean | undefined;
}

type TargetCheckStatus = "passed" | "failed" | "warn";

interface TargetCheck {
  name: string;
  status: TargetCheckStatus;
  message?: string | undefined;
}

interface TargetGit {
  branch: string;
  head: string;
  dirty: boolean;
}

interface TargetReportBlock {
  id: string;
  resolvedPath: string;
  workspaceRoot: string;
  git: TargetGit | null;
  packageName: string;
}

async function configuredConfig(
  dependencies: CliDependencies,
  options: DoctorOptions
): Promise<TapHoundConfig | undefined> {
  try {
    return TapHoundConfigSchema.parse(await dependencies.readJson(
      resolve(options.project, options.config)
    ));
  } catch {
    return undefined;
  }
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
  code: FailureCode,
  message: string
): void {
  const exitCode = exitCodeForFailure(code);
  const output = failureOutput(exitCode, code, message);
  if (json) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, output.failure.message);
  }
  dependencies.setExitCode(exitCode);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function gitValue(
  executable: "git",
  root: string,
  args: readonly string[],
  run: CliDependencies["localTargets"]["processRunner"]["run"]
): Promise<string | undefined> {
  const result = await run({
    executable,
    args: ["-C", root, ...args]
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  const value = result.stdout.trim();
  return value.length === 0 ? undefined : value;
}

async function inspectTargetGit(
  dependencies: CliDependencies,
  root: string | undefined
): Promise<TargetGit | null> {
  if (root === undefined) {
    return null;
  }
  const run = dependencies.localTargets.processRunner.run;
  const [head, branch, status] = await Promise.all([
    gitValue("git", root, ["rev-parse", "HEAD"], run),
    gitValue("git", root, ["rev-parse", "--abbrev-ref", "HEAD"], run),
    run({
      executable: "git",
      args: ["-C", root, "status", "--porcelain"]
    })
  ]);
  if (head === undefined || branch === undefined) {
    return null;
  }
  return {
    branch,
    head,
    dirty: status.exitCode === 0 && status.stdout.trim().length > 0
  };
}

async function scanApplicationIds(root: string): Promise<string[]> {
  const ids = new Set<string>();
  const candidates: string[] = [root];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (
        entry.name === "build"
        || entry.name === ".git"
        || entry.name === "node_modules"
      ) {
        continue;
      }
      candidates.push(join(root, entry.name));
    }
  } catch {
    return [];
  }
  for (const dir of candidates) {
    for (const file of ["build.gradle", "build.gradle.kts"]) {
      try {
        const content = await readFile(join(dir, file), "utf8");
        for (
          const match of content.matchAll(
            /\bapplicationId\s*=\s*["']([^"']+)["']/g
          )
        ) {
          const value = match[1];
          if (value !== undefined) {
            ids.add(value);
          }
        }
      } catch {
        continue;
      }
    }
  }
  return [...ids];
}

async function buildTargetChecks(
  dependencies: CliDependencies,
  resolved: ResolvedTarget,
  entry: TargetEntry,
  packageName: string
): Promise<TargetCheck[]> {
  const resolvedPath = resolved.resolvedPath;

  const targetPath: TargetCheck = (await pathExists(resolvedPath))
    ? { name: "target-path", status: "passed", message: resolvedPath }
    : {
        name: "target-path",
        status: "failed",
        message: `Resolved target path does not exist: ${resolvedPath}`
      };

  const isAndroidProject = await hasAndroidProjectStructure(resolvedPath);
  const androidProject: TargetCheck = isAndroidProject
    ? { name: "android-project", status: "passed", message: resolvedPath }
    : {
        name: "android-project",
        status: "failed",
        message: `No Android project structure found at ${resolvedPath}`
      };

  const gitEnabled = entry.git.enabled;
  const git = gitEnabled
    ? await inspectTargetGit(dependencies, resolved.project.gitRoot)
    : null;
  const gitCheck: TargetCheck = !gitEnabled
    ? {
        name: "git-state",
        status: "warn",
        message: `Git integration disabled for target ${resolved.id}`
      }
    : git === null
      ? {
          name: "git-state",
          status: "warn",
          message: "No git repository detected (skipped)"
        }
      : {
          name: "git-state",
          status: "passed",
          message: `${git.branch} @ ${git.head}${git.dirty ? " (dirty)" : ""}`
        };

  const applicationIds = await scanApplicationIds(resolvedPath);
  let packageIdentity: TargetCheck;
  if (applicationIds.length === 0) {
    packageIdentity = {
      name: "package-identity",
      status: "warn",
      message: "No applicationId evidence found in module build files (unknown)"
    };
  } else if (
    applicationIds.length === 1
    && applicationIds[0] !== packageName
  ) {
    packageIdentity = {
      name: "package-identity",
      status: "failed",
      message: `Project applicationId ${String(applicationIds[0])} does not match configured packageName ${packageName}. Rebuild and install the target, or fix the configured packageName.`
    };
  } else if (applicationIds.length > 1) {
    packageIdentity = {
      name: "package-identity",
      status: "passed",
      message: `${applicationIds.join(", ")} ambiguous; none matched configured packageName ${packageName}`
    };
  } else {
    packageIdentity = {
      name: "package-identity",
      status: "passed",
      message: `${applicationIds.join(", ")} matches configured packageName ${packageName}`
    };
  }

  const workspacePresent = await pathExists(resolved.workspaceRoot);
  const identity = workspacePresent
    ? await dependencies.localTargets.workspace.readIdentity(
        dependencies.localTargets.targetsHome(),
        resolved.id
      )
    : null;
  const localWorkspace: TargetCheck = !workspacePresent
    ? {
        name: "local-workspace",
        status: "warn",
        message: "Local target workspace has not been created yet (taphound local add will create it)"
      }
    : identity === null
      ? {
          name: "local-workspace",
          status: "warn",
          message: "Target is registered but has no identity yet; run taphound local add to record one"
        }
      : {
          name: "local-workspace",
          status: "passed",
          message: resolved.workspaceRoot
        };

  return [targetPath, androidProject, gitCheck, packageIdentity, localWorkspace];
}

function targetMessage(report: {
  target: TargetReportBlock;
  checks: readonly {
    name: string;
    status: string;
    version?: string | undefined;
    message?: string | undefined;
  }[];
}): string {
  const lines = [`Target ${report.target.id} (${report.target.resolvedPath})`];
  for (const check of report.checks) {
    const mark = check.status === "passed"
      ? "✓"
      : check.status === "warn"
        ? "!"
        : "✗";
    lines.push(`${mark} ${check.name}${check.message === undefined ? "" : `: ${check.message}`}`);
  }
  return lines.join("\n");
}

async function runTargetDoctor(
  dependencies: CliDependencies,
  options: DoctorOptions
): Promise<void> {
  const json = options.json === true;
  const id = options.target as string;
  const home = targetsHome(dependencies, options.targets);
  const resolver = dependencies.localTargets.targetResolver(home);

  let resolved: ResolvedTarget;
  try {
    resolved = await resolver.resolve(id);
  } catch (error) {
    writeFailure(
      dependencies,
      json,
      failureCodeFromUnknown(error) ?? "INTERNAL_ERROR",
      errorMessage(error)
    );
    return;
  }

  const loaded = await dependencies.localTargets.configStore.loadTargets(home);
  const entry = loaded.targets[id];
  if (entry === undefined) {
    writeFailure(
      dependencies,
      json,
      "LOCAL_TARGET_NOT_FOUND",
      `Local target "${id}" is not registered. Add it with: taphound local add ${id} --path <path>`
    );
    return;
  }

  const config = dependencies.localTargets.localTargetService(home).configForTarget({
    entry,
    resolvedPath: resolved.resolvedPath,
    workspaceRoot: resolved.workspaceRoot
  });
  const packageName = config.run.packageName;

  const targetChecks = await buildTargetChecks(
    dependencies,
    resolved,
    entry,
    packageName
  );
  const failed = targetChecks.find((check) => check.status === "failed");
  if (failed !== undefined) {
    const code: FailureCode = failed.name === "target-path"
      ? "LOCAL_TARGET_PATH_INVALID"
      : failed.name === "android-project"
        ? "LOCAL_TARGET_NOT_ANDROID_PROJECT"
        : failed.name === "package-identity"
          ? "PACKAGE_IDENTITY_MISMATCH"
          : "INTERNAL_ERROR";
    writeFailure(
      dependencies,
      json,
      code,
      failed.message ?? failed.name
    );
    return;
  }

  const git = entry.git.enabled && resolved.project.gitRoot !== undefined
    ? await inspectTargetGit(dependencies, resolved.project.gitRoot)
    : null;

  const report = await dependencies.doctor.run({
    packageName,
    ...(options.device === undefined
      ? {}
      : { requestedDevice: options.device }),
    ...(dependencies.signal === undefined
      ? {}
      : { signal: dependencies.signal })
  });

  const targetBlock: TargetReportBlock = {
    id: resolved.id,
    resolvedPath: resolved.resolvedPath,
    workspaceRoot: resolved.workspaceRoot,
    git,
    packageName
  };
  const extended = {
    ...report,
    checks: [...targetChecks, ...report.checks],
    target: targetBlock
  };
  if (json) {
    writeJson(dependencies.stdout, extended);
  } else {
    writeLine(dependencies.stdout, targetMessage(extended));
  }
  dependencies.setExitCode(report.status === "passed" ? 0 : 3);
}

export function createDoctorCommand(dependencies: CliDependencies): Command {
  return new Command("doctor")
    .description("Check TapHound tools, permissions, application, and device")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--device <serial>", "Select an online Android device")
    .option("--target <id>", "Registered local target id")
    .option("--targets <path>", "Targets workspace base path")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: DoctorOptions): Promise<void> => {
      const json = options.json === true;
      try {
        if (options.target !== undefined) {
          await runTargetDoctor(dependencies, options);
          return;
        }
        const config = await configuredConfig(dependencies, options);
        const report = await dependencies.doctor.run({
          ...(config === undefined ? {} : { packageName: config.run.packageName }),
          ...(config?.ui?.backend === undefined
            ? {}
            : { requestedUiBackend: config.ui.backend }),
          ...(options.device === undefined
            ? {}
            : { requestedDevice: options.device }),
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        if (json) {
          writeJson(dependencies.stdout, report);
        } else {
          writeLine(dependencies.stdout, doctorMessage(report));
        }
        dependencies.setExitCode(report.status === "passed" ? 0 : 3);
      } catch (error) {
        const code = failureCodeFromUnknown(error) ?? "INTERNAL_ERROR";
        const output = failureOutput(exitCodeForFailure(code), code, errorMessage(error));
        if (json) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(exitCodeForFailure(code));
      }
    });
}