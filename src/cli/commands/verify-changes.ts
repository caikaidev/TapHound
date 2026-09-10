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
  head: string;
  device?: string | undefined;
  scope?: string | undefined;
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

export function createVerifyChangesCommand(
  dependencies: CliDependencies
): Command {
  return new Command("verify-changes")
    .description("Replay the Journeys a Git change affects and report a verdict")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--base <ref>", "Base Git ref", "origin/main")
    .option("--head <ref>", "Head Git ref", "HEAD")
    .option("--device <serial>", "Select an online Android device")
    .option("--scope <p0,p1,p2>", "Selection tiers to replay", "p0,p1")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: VerifyChangesOptions): Promise<void> => {
      try {
        if (
          dependencies.gitDiff === undefined
          || dependencies.impact === undefined
        ) {
          throw new Error("TapHound change verification is not configured");
        }
        const changeSet = await dependencies.gitDiff.diff({
          projectRoot: options.project,
          base: options.base,
          head: options.head
        });
        const impact = await dependencies.impact.resolve(
          options.project,
          changeSet
        );
        const scopes = selectedScopes(options.scope);
        const selected = scopes.flatMap((tier) => (
          impact.selectedJourneys[tier].map((entry) => ({
            tier,
            path: entry.id
          }))
        ));

        const rawConfig = await dependencies.readJson(
          resolve(options.project, options.config)
        );
        const config = TapHoundConfigSchema.parse(rawConfig);
        assertArtifactDirectory(options.project, config.artifactsDir);
        await assertNoLegacyWorkspace(dependencies, options.project);

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
            projectRoot: options.project,
            relativePath: entry.path
          });
          const journey: Journey = JourneySchema.parse(
            JSON.parse(bytes.toString("utf8"))
          );
          if (journey.devices.length > 1) {
            const output = failureOutput(
              3,
              "DEVICE_ROLE_UNMAPPED",
              `Journey ${journey.name} declares multiple devices; map each role with --device <role>=<serial>`
            );
            if (options.json === true) {
              writeJson(dependencies.stdout, output);
            } else {
              writeLine(dependencies.stderr, output.failure.message);
            }
            dependencies.setExitCode(3);
            return;
          }
          writeLine(
            dependencies.stderr,
            `TapHound: verifying ${journey.name} (${entry.tier})`
          );
          const result = await dependencies.verifier.verify({
            config,
            journey,
            projectRoot: options.project,
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
        const overall = results.length === 0
          ? "error"
          : failed === undefined
            ? "passed"
            : "failed";
        const payload: VerifyChangesResult = {
          base: options.base,
          head: options.head,
          impact,
          results,
          overall
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, payload);
        } else {
          const lines = [
            `TapHound verify-changes: ${options.base}...${options.head}`,
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