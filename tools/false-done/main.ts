/**
 * False-Done Benchmark developer tool (not shipped in the npm package).
 *
 * Measures whether `verify --contract` catches agent "done" claims that are
 * actually wrong: install each variant APK, verify its Acceptance Contract,
 * and score the Verdict against the Case's expected Verdict.
 *
 *   npm run bench:false-done -- validate [--project <path>] [--case <id>...]
 *   npm run bench:false-done -- run [--project <path>] [--config <path>]
 *       [--device <serial>] [--case <id>...] [--repeats <1-5>]
 *   npm run bench:false-done -- compare --baseline <runId> --candidate <runId>
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { createProductionDependencies } from "../../src/cli/dependencies.js";
import { TapHoundConfigSchema } from "../../src/domain/config.js";
import { CONFIG_PATH } from "../../src/domain/workspace.js";
import { compareFalseDoneRuns } from "./compare.js";
import { FalseDoneRunner } from "./runner.js";
import { FileSystemFalseDoneStore } from "./store.js";

function installApk(input: { deviceSerial: string; apkPath: string }): Promise<void> {
  const result = spawnSync(
    "adb",
    ["-s", input.deviceSerial, "install", "-r", input.apkPath],
    { encoding: "utf8", shell: false }
  );
  if (result.error !== undefined || result.status !== 0) {
    return Promise.reject(new Error(
      result.stderr.trim()
        || result.error?.message
        || result.stdout.trim()
        || "adb install failed"
    ));
  }
  return Promise.resolve();
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      project: { type: "string", default: process.cwd() },
      config: { type: "string", default: CONFIG_PATH },
      device: { type: "string" },
      case: { type: "string", multiple: true },
      repeats: { type: "string", default: "1" },
      baseline: { type: "string" },
      candidate: { type: "string" }
    },
    strict: true
  });
  const projectRoot = resolve(values.project);
  const dependencies = createProductionDependencies();
  const contractVerifier = dependencies.contractVerifier;
  if (contractVerifier === undefined) {
    throw new Error("Contract verification is unavailable");
  }
  const store = new FileSystemFalseDoneStore();
  const runner = new FalseDoneRunner({
    store,
    installApk,
    verifyContract: (input): ReturnType<typeof contractVerifier.verify> => (
      contractVerifier.verify(input)
    ),
    readText: (path): Promise<string> => readFile(path, "utf8"),
    readBytes: async (path): Promise<Uint8Array> => (
      new Uint8Array(await readFile(path))
    ),
    now: (): Date => new Date(),
    createRunId: randomUUID
  });

  if (command === "validate") {
    const output = await runner.validate({
      projectRoot,
      ...(values.case === undefined ? {} : { caseIds: values.case })
    });
    print(output);
    return output.status === "valid" ? 0 : 2;
  }

  if (command === "run") {
    const repeats = Number(values.repeats);
    if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) {
      throw new Error("--repeats must be an integer between 1 and 5");
    }
    const config = TapHoundConfigSchema.parse(
      await dependencies.readJson(resolve(projectRoot, values.config))
    );
    const doctor = await dependencies.doctor.run({
      packageName: config.run.packageName,
      ...(values.device === undefined ? {} : { requestedDevice: values.device })
    });
    const deviceSerial = values.device ?? doctor.deviceSerial;
    if (doctor.status === "failed" || deviceSerial === undefined) {
      print({ status: "failed", code: doctor.failureCode ?? "ENVIRONMENT_MISSING_TOOL" });
      return 3;
    }
    const toolVersions = Object.fromEntries(doctor.checks.flatMap(
      (check) => check.status === "passed" && check.version !== undefined
        ? [[check.name, check.version] as const]
        : []
    ));
    const { result, path } = await runner.run({
      projectRoot,
      deviceSerial,
      repeats,
      config,
      toolVersions,
      manualReplay: process.stdin.isTTY,
      ...(values.case === undefined ? {} : { caseIds: values.case })
    });
    print({ status: "ran", runId: result.runId, resultPath: path, metrics: result.metrics });
    return 0;
  }

  if (command === "compare") {
    if (values.baseline === undefined || values.candidate === undefined) {
      throw new Error("compare requires --baseline and --candidate run ids");
    }
    const baseline = await store.readResult(projectRoot, values.baseline);
    const candidate = await store.readResult(projectRoot, values.candidate);
    print({ status: "compared", ...compareFalseDoneRuns(baseline, candidate) });
    return 0;
  }

  throw new Error("Usage: bench:false-done -- <validate|run|compare> [options]");
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
);
