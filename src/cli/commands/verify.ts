import { join, resolve } from "node:path";

import { Command } from "commander";

import { TapHoundConfigSchema } from "../../domain/config.js";
import {
  DEFAULT_DEVICE_ROLE,
  JourneySchema
} from "../../domain/journey.js";
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

interface VerifyOptions {
  project: string;
  config: string;
  journey: string;
  device?: string | undefined;
  package?: string | undefined;
  activity?: string | undefined;
  reports?: string | undefined;
  target?: string | undefined;
  targets?: string | undefined;
  json?: boolean | undefined;
}

function toolVersions(checks: Awaited<ReturnType<CliDependencies["doctor"]["run"]>>["checks"]): Record<string, string> {
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

async function runDoctorAndVerify(
  dependencies: CliDependencies,
  options: VerifyOptions,
  config: ReturnType<typeof TapHoundConfigSchema.parse>,
  journey: ReturnType<typeof JourneySchema.parse>,
  projectRoot: string,
  workspaceRoot: string | undefined
): Promise<void> {
  const json = options.json === true;
  try {
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
      if (json) {
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
    if (journey.devices.length > 1) {
      const output = failureOutput(
        3,
        "DEVICE_ROLE_UNMAPPED",
        `Journey declares multiple devices; map each role with --device <role>=<serial> for: ${journey.devices.map((device) => device.role).join(", ")}`
      );
      if (json) {
        writeJson(dependencies.stdout, output);
      } else {
        writeLine(dependencies.stderr, output.failure.message);
      }
      dependencies.setExitCode(3);
      return;
    }
    writeLine(dependencies.stderr, `TapHound: verifying ${journey.name}`);
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
    if (json) {
      writeJson(dependencies.stdout, result);
    } else {
      writeLine(
        dependencies.stdout,
        `TapHound verify: ${result.status.toUpperCase()}\nReport: ${result.reportPath}`
      );
    }
    dependencies.setExitCode(result.exitCode);
  } catch (error) {
    const output = failureOutput(4, "INTERNAL_ERROR", errorMessage(error));
    if (json) {
      writeJson(dependencies.stdout, output);
    } else {
      writeLine(dependencies.stderr, output.failure.message);
    }
    dependencies.setExitCode(4);
  }
}

async function runTargetVerify(
  dependencies: CliDependencies,
  options: VerifyOptions
): Promise<void> {
  const json = options.json === true;
  const id = options.target as string;
  const home = targetsHome(dependencies, options.targets);
  const resolver = dependencies.localTargets.targetResolver(home);

  let resolved;
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

  const name = options.journey;
  if (name.includes("/") || name.includes("\\")) {
    writeFailure(
      dependencies,
      json,
      "CONFIG_INVALID",
      `--journey must be a bare Journey name with --target; got: ${name}`
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

  const workspaceRoot = resolved.workspaceRoot;
  const synthesized = dependencies.localTargets.localTargetService(home)
    .configForTarget({
      entry,
      resolvedPath: resolved.resolvedPath,
      workspaceRoot
    });
  const config = TapHoundConfigSchema.parse({
    ...synthesized,
    run: {
      packageName: options.package ?? synthesized.run.packageName,
      activity: options.activity ?? synthesized.run.activity
    },
    artifactsDir: options.reports === undefined
      ? synthesized.artifactsDir
      : resolve(workspaceRoot, options.reports)
  });
  assertArtifactDirectory(resolved.resolvedPath, config.artifactsDir);

  const fileName = name.endsWith(".json") ? name : `${name}.json`;
  let journey;
  try {
    journey = JourneySchema.parse(
      await dependencies.readJson(join(workspaceRoot, "journeys", fileName))
    );
  } catch (error) {
    const output = failureOutput(2, "CONFIG_INVALID", errorMessage(error));
    if (json) {
      writeJson(dependencies.stdout, output);
    } else {
      writeLine(dependencies.stderr, output.failure.message);
    }
    dependencies.setExitCode(2);
    return;
  }

  await runDoctorAndVerify(
    dependencies,
    options,
    config,
    journey,
    resolved.resolvedPath,
    workspaceRoot
  );
}

export function createVerifyCommand(dependencies: CliDependencies): Command {
  return new Command("verify")
    .description("Deterministically verify a TapHound Journey")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .requiredOption("--journey <path>", "TapHound Journey path or bare name with --target")
    .option("--device <serial>", "Select an online Android device")
    .option("--package <name>", "Override run.packageName")
    .option("--activity <name>", "Override run.activity")
    .option("--reports <path>", "Override report output directory (resolved against the workspace in --target mode)")
    .option("--target <id>", "Registered local target id")
    .option("--targets <path>", "Targets workspace base path")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: VerifyOptions): Promise<void> => {
      if (options.target !== undefined) {
        await runTargetVerify(dependencies, options);
        return;
      }

      let config;
      let journey;
      try {
        const rawConfig = await dependencies.readJson(
          resolve(options.project, options.config)
        );
        const parsed = TapHoundConfigSchema.parse(rawConfig);
        config = TapHoundConfigSchema.parse({
          ...parsed,
          run: {
            packageName: options.package ?? parsed.run.packageName,
            activity: options.activity ?? parsed.run.activity
          },
          artifactsDir: options.reports ?? parsed.artifactsDir
        });
        assertArtifactDirectory(options.project, config.artifactsDir);
        await assertNoLegacyWorkspace(dependencies, options.project);
        journey = JourneySchema.parse(await dependencies.readJson(
          resolve(options.project, options.journey)
        ));
      } catch (error) {
        const output = failureOutput(2, "CONFIG_INVALID", errorMessage(error));
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(2);
        return;
      }

      await runDoctorAndVerify(
        dependencies,
        options,
        config,
        journey,
        options.project,
        undefined
      );
    });
}