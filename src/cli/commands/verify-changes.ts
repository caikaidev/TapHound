import { resolve } from "node:path";

import { Command } from "commander";

import { TapHoundConfigSchema } from "../../domain/config.js";
import {
  DEFAULT_DEVICE_ROLE,
  JourneySchema,
  type Journey
} from "../../domain/journey.js";
import type { ImpactSet } from "../../domain/impact.js";
import {
  assertArtifactDirectory,
  CONFIG_PATH
} from "../../domain/workspace.js";
import {
  exitCodeForFailure,
  failureCodeFromUnknown,
  type FailureCode
} from "../../domain/failure.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";
import { assertNoLegacyWorkspace } from "../workspace-guard.js";

interface VerifyChangesOptions {
  project: string;
  config: string;
  base: string;
  head?: string | undefined;
  device?: string | undefined;
  scope?: string | undefined;
  target?: string | undefined;
  targets?: string | undefined;
  json?: boolean | undefined;
}

interface JourneyVerdict {
  path: string;
  name: string;
  selection: "p0" | "p1" | "p2";
  status: string;
  exitCode: 0 | 1 | 2 | 3 | 4;
  reportPath: string;
}

interface VerifyChangesResult {
  base: string;
  head: string;
  impact: ImpactSet;
  results: JourneyVerdict[];
  overall: "passed" | "failed" | "error";
  note?: string | undefined;
  target?: {
    id: string;
    resolvedPath: string;
  };
}

function selectedScopes(scope: string | undefined): ("p0" | "p1" | "p2")[] {
  const normalized = scope ?? "p0,p1";
  const tiers: ("p0" | "p1" | "p2")[] = [];
  for (const token of normalized.split(",").map((value) => value.trim())) {
    if (token === "p0" || token === "p1" || token === "p2") {
      tiers.push(token);
    }
  }
  return tiers;
}

function toolVersions(
  checks: Awaited<ReturnType<CliDependencies["doctor"]["run"]>>["checks"]
): Record<string, string> {
  return Object.fromEntries(checks.flatMap((check) => (
    check.version === undefined
      || !["node", "adb", "android"].includes(check.name)
      ? []
      : [[check.name, check.version]]
  )));
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

export function createVerifyChangesCommand(
  dependencies: CliDependencies
): Command {
  return new Command("verify-changes")
    .description("Replay the Journeys a Git change affects and report a verdict")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--base <ref>", "Base Git ref", "origin/main")
    .option("--head <ref>", "Head Git ref (defaults to HEAD, or WORKTREE with --target)")
    .option("--device <serial>", "Select an online Android device")
    .option("--scope <p0,p1,p2>", "Selection tiers to replay", "p0,p1")
    .option("--target <id>", "Registered local target id")
    .option("--targets <path>", "Targets workspace base path")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: VerifyChangesOptions): Promise<void> => {
      try {
        if (
          dependencies.gitDiff === undefined
          || dependencies.impact === undefined
        ) {
          throw new Error("TapHound change verification is not configured");
        }
        const head = options.head
          ?? (options.target === undefined ? "HEAD" : "WORKTREE");

        let resolvedTarget;
        let workspaceRoot;
        let projectRoot;
        if (options.target !== undefined) {
          const id = options.target;
          const home = targetsHome(dependencies, options.targets);
          const resolver = dependencies.localTargets.targetResolver(home);
          resolvedTarget = await resolver.resolve(id);
          workspaceRoot = resolvedTarget.workspaceRoot;
          projectRoot = resolvedTarget.resolvedPath;
        } else {
          projectRoot = options.project;
        }

        let config;
        if (resolvedTarget !== undefined) {
          const loaded = await dependencies.localTargets.configStore
            .loadTargets(targetsHome(dependencies, options.targets));
          const entry = loaded.targets[resolvedTarget.id];
          if (entry === undefined) {
            writeFailure(
              dependencies,
              options.json === true,
              "LOCAL_TARGET_NOT_FOUND",
              `Local target "${resolvedTarget.id}" is not registered. Add it with: taphound local add ${resolvedTarget.id} --path <path>`
            );
            return;
          }
          const fingerprint = await dependencies.localTargets
            .targetResolver(targetsHome(dependencies, options.targets))
            .fingerprint(resolvedTarget.project, entry.run.packageName);
          try {
            await dependencies.localTargets.localTargetService(
              targetsHome(dependencies, options.targets)
            ).assertProjectUnchanged(resolvedTarget, fingerprint.hash);
          } catch (error) {
            writeFailure(
              dependencies,
              options.json === true,
              failureCodeFromUnknown(error) ?? "INTERNAL_ERROR",
              errorMessage(error)
            );
            return;
          }
          config = TapHoundConfigSchema.parse(
            dependencies.localTargets.localTargetService(
              targetsHome(dependencies, options.targets)
            ).configForTarget({
              entry,
              resolvedPath: resolvedTarget.resolvedPath,
              workspaceRoot: resolvedTarget.workspaceRoot
            })
          );
        } else {
          const rawConfig = await dependencies.readJson(
            resolve(options.project, options.config)
          );
          config = TapHoundConfigSchema.parse(rawConfig);
          assertArtifactDirectory(options.project, config.artifactsDir);
          await assertNoLegacyWorkspace(dependencies, options.project);
        }

        let changeSet;
        let impact;
        if (resolvedTarget !== undefined) {
          const gitRoot = resolvedTarget.project.gitRoot
            ?? resolvedTarget.resolvedPath;
          changeSet = await dependencies.gitDiff.diff({
            projectRoot: gitRoot,
            base: options.base,
            head
          });
          impact = await dependencies.impact.resolve({
            projectRoot: resolvedTarget.resolvedPath,
            workspaceRoot: resolvedTarget.workspaceRoot,
            packageName: config.run.packageName,
            changeSet
          });
        } else {
          changeSet = await dependencies.gitDiff.diff({
            projectRoot: options.project,
            base: options.base,
            head
          });
          impact = await dependencies.impact.resolve({
            projectRoot: options.project,
            packageName: config.run.packageName,
            changeSet
          });
        }
        const scopes = selectedScopes(options.scope);
        const selected = scopes.flatMap((tier) => (
          impact.selectedJourneys[tier].map((entry) => ({
            tier,
            path: entry.id
          }))
        ));

        const doctor = await dependencies.doctor.run({
          packageName: config.run.packageName,
          ...(config.ui?.backend === undefined
            ? {}
            : { requestedUiBackend: config.ui.backend }),
          ...(options.device === undefined
            ? {}
            : { requestedDevice: options.device }),
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        if (doctor.status === "failed") {
          const output = failureOutput(
            3,
            doctor.failureCode ?? "ENVIRONMENT_MISSING_TOOL",
            doctor.checks.find((check) => check.status === "failed")?.message
              ?? "TapHound environment preflight failed"
          );
          if (options.json === true) {
            writeJson(dependencies.stdout, output);
          } else {
            writeLine(dependencies.stderr, output.failure.message);
          }
          dependencies.setExitCode(3);
          return;
        }
        const deviceSerial = options.device ?? doctor.deviceSerial;
        if (deviceSerial === undefined) {
          throw new Error("Doctor did not select a device");
        }
        if (
          dependencies.journeyCompositionStore === undefined
        ) {
          throw new Error("TapHound change verification is not configured");
        }

        const results: JourneyVerdict[] = [];
        for (const entry of selected) {
          const bytes = await dependencies.journeyCompositionStore.read({
            projectRoot,
            relativePath: entry.path,
            ...(workspaceRoot === undefined ? {} : { workspaceRoot })
          });
          const journey: Journey = JourneySchema.parse(
            JSON.parse(bytes.toString("utf8"))
          );
          if (journey.devices.length > 1) {
            writeFailure(
              dependencies,
              options.json === true,
              "DEVICE_ROLE_UNMAPPED",
              `Journey ${journey.name} declares multiple devices; map each role with --device <role>=<serial>`
            );
            return;
          }
          writeLine(
            dependencies.stderr,
            `TapHound: verifying ${journey.name} (${entry.tier})`
          );
          const result = await dependencies.verifier.verify({
            config,
            journey,
            projectRoot,
            ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
            devices: [{
              role: journey.devices[0]?.role ?? DEFAULT_DEVICE_ROLE,
              deviceSerial
            }],
            toolVersions: toolVersions(doctor.checks),
            manualReplay: process.stdin.isTTY,
            ...(dependencies.signal === undefined
              ? {}
              : { signal: dependencies.signal })
          });
          results.push({
            path: entry.path,
            name: journey.name,
            selection: entry.tier,
            status: result.status,
            exitCode: result.exitCode,
            reportPath: result.reportPath
          });
        }

        const failed = results.find((result) => result.status !== "passed");
        let overall: "passed" | "failed" | "error";
        let note: string | undefined;
        if (changeSet.files.length === 0) {
          overall = "passed";
          note = "No changes; nothing to verify";
        } else {
          overall = results.length === 0
            ? "error"
            : failed === undefined
              ? "passed"
              : "failed";
        }
        const payload: VerifyChangesResult = {
          base: options.base,
          head,
          impact,
          results,
          overall,
          ...(note === undefined ? {} : { note }),
          ...(resolvedTarget === undefined
            ? {}
            : {
              target: {
                id: resolvedTarget.id,
                resolvedPath: resolvedTarget.resolvedPath
              }
            })
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, payload);
        } else {
          const lines = [
            `TapHound verify-changes: ${options.base}...${head}`,
            ...results.map((result) => (
              `  ${result.selection.toUpperCase()} ${result.name}: ${result.status.toUpperCase()}`
            )),
            `overall: ${overall.toUpperCase()}`
          ];
          writeLine(dependencies.stdout, lines.join("\n"));
        }
        if (results.length === 0) {
          dependencies.setExitCode(0);
          return;
        }
        dependencies.setExitCode(failed === undefined ? 0 : failed.exitCode);
      } catch (error) {
        const code = failureCodeFromUnknown(error);
        if (code !== undefined) {
          writeFailure(
            dependencies,
            options.json === true,
            code,
            errorMessage(error)
          );
          return;
        }
        const output = failureOutput(4, "INTERNAL_ERROR", errorMessage(error));
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(4);
      }
    });
}