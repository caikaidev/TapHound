import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { TapHoundConfigSchema } from "../../src/domain/config.js";
import { TargetError } from "../../src/domain/target.js";
import type { LocalTargetIdentity } from "../../src/domain/target.js";
import type {
  CliDependencies,
  LocalTargets,
  TextOutput
} from "../../src/cli/dependencies.js";
import type { TargetResolver } from "../../src/application/target/target-resolver.js";
import type { LocalTargetService } from "../../src/application/target/local-target-service.js";
import type {
  CommandResult,
  CommandSpec
} from "../../src/ports/process-runner.js";
import type { LoadedTargets } from "../../src/ports/target-config-store.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

interface TargetFixture {
  projectRoot: string;
  workspaceRoot: string;
  id: string;
}

function identityJson(fixture: TargetFixture): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    targetId: fixture.id,
    sourceType: "local",
    configuredPath: fixture.projectRoot,
    resolvedPath: fixture.projectRoot,
    fingerprint: {
      schemaVersion: 1,
      hash: "a".repeat(64)
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z"
  }, null, 2)}\n`;
}

async function makeTargetProject(
  applicationId?: string,
  options: { androidProject?: boolean; withIdentity?: boolean } = {}
): Promise<TargetFixture> {
  const id = "work-app";
  const root = await mkdtemp(join(tmpdir(), "taphound-doctor-target-"));
  temporaryRoots.push(root);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  if (options.androidProject !== false) {
    await mkdir(join(projectRoot, "app"), { recursive: true });
    await writeFile(
      join(projectRoot, "settings.gradle.kts"),
      "rootProject.name = \"work-app\"\n"
    );
    if (applicationId !== undefined) {
      await writeFile(
        join(projectRoot, "app", "build.gradle.kts"),
        `android {\n  defaultConfig {\n    applicationId = "${applicationId}"\n  }\n}\n`
      );
    }
  }
  const workspaceRoot = join(root, "ws", id);
  await mkdir(workspaceRoot, { recursive: true });
  if (options.withIdentity !== false) {
    await writeFile(
      join(workspaceRoot, "identity.json"),
      identityJson({ projectRoot, workspaceRoot, id })
    );
  }
  return { projectRoot, workspaceRoot, id };
}

function resolvedTarget(fixture: TargetFixture): Parameters<TargetResolver["resolve"]>[0] extends never
  ? never
  : object {
  return {
    id: fixture.id,
    sourceType: "local",
    configuredPath: fixture.projectRoot,
    resolvedPath: fixture.projectRoot,
    project: {
      rootDir: fixture.projectRoot,
      settingsFile: "settings.gradle.kts",
      gitRoot: fixture.projectRoot
    },
    workspaceRoot: fixture.workspaceRoot
  };
}

const gitResult = (stdout: string): {
  exitCode: number;
  signal: null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
} => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: "",
  durationMs: 1,
  timedOut: false,
  cancelled: false
});

function fakeLocalTargets(
  fixture: TargetFixture,
  overrides: Partial<LocalTargets> = {},
  gitEnabled = true
): {
  bundle: LocalTargets;
  resolve: ReturnType<typeof vi.fn>;
  loadTargets: ReturnType<typeof vi.fn>;
  processRun: ReturnType<typeof vi.fn<(spec: CommandSpec) => Promise<CommandResult>>>;
  configForTarget: ReturnType<typeof vi.fn>;
} {
  const resolve = vi.fn(() => Promise.resolve(resolvedTarget(fixture)));
  const resolver = {
    resolve,
    fingerprint: vi.fn(() => Promise.resolve({
      schemaVersion: 1 as const,
      hash: "a".repeat(64)
    }))
  } as unknown as TargetResolver;
  const loadTargets = vi.fn<(targetsHome: string) => Promise<LoadedTargets>>(
    () => Promise.resolve({
      targets: {
        [fixture.id]: {
          id: fixture.id,
          source: { type: "local", path: fixture.projectRoot },
          run: { packageName: "com.example.app", activity: ".MainActivity" },
          git: { enabled: gitEnabled },
          override: false
        }
      },
      official: undefined,
      local: undefined
    })
  );
  const configForTarget = vi.fn((input: {
    entry: { run: { packageName: string; activity?: string } };
    workspaceRoot: string;
  }) => (
    TapHoundConfigSchema.parse({
      version: 1,
      run: {
        packageName: input.entry.run.packageName,
        activity: input.entry.run.activity ?? ".MainActivity"
      },
      idle: {
        strategy: "hybrid",
        pollIntervalMs: 200,
        stablePolls: 2,
        timeoutMs: 5000
      },
      artifactsDir: `${input.workspaceRoot}/runs`
    })
  ));
  const service = {
    configForTarget,
    assertProjectUnchanged: vi.fn(() => Promise.resolve(undefined))
  };
  const processRun = vi.fn<(spec: CommandSpec) => Promise<CommandResult>>(
    () => Promise.resolve(gitResult(""))
  );
  const bundle: LocalTargets = {
    targetsHome: () => "/targets",
    configStore: {
      loadTargets,
      appendLocalTarget: vi.fn(() => Promise.resolve(undefined)),
      removeLocalTarget: vi.fn(() => Promise.resolve(false))
    },
    pathResolver: { resolve: vi.fn() },
    workspace: {
      root: vi.fn(() => fixture.workspaceRoot),
      identityPath: vi.fn(() => join(fixture.workspaceRoot, "identity.json")),
      readIdentity: vi.fn(async (): Promise<LocalTargetIdentity | null> => {
        try {
          const raw: unknown = JSON.parse(
            await readFile(join(fixture.workspaceRoot, "identity.json"), "utf8")
          );
          return raw as LocalTargetIdentity;
        } catch {
          return null;
        }
      }),
      writeIdentity: vi.fn(() => Promise.resolve(undefined)),
      ensureWorkspace: vi.fn(() => Promise.resolve(undefined)),
      ensureTaphoundIgnored: vi.fn(() => Promise.resolve(undefined))
    },
    targetResolver: () => resolver,
    localTargetService: () => (service as unknown as LocalTargetService),
    processRunner: {
      run: processRun,
      start: vi.fn()
    },
    clock: { now: () => new Date() },
    ...overrides
  };
  return { bundle, resolve, loadTargets, processRun, configForTarget };
}

function mockGit(processRun: ReturnType<typeof vi.fn<(spec: CommandSpec) => Promise<CommandResult>>>): void {
  processRun.mockImplementation((spec: CommandSpec) => {
    if (spec.args.includes("rev-parse") && spec.args.includes("--abbrev-ref")) {
      return Promise.resolve(gitResult("main\n"));
    }
    if (spec.args.includes("rev-parse") && spec.args.includes("HEAD")) {
      return Promise.resolve(gitResult("deadbeefcafebabe\n"));
    }
    if (spec.args.includes("status") && spec.args.includes("--porcelain")) {
      return Promise.resolve(gitResult(""));
    }
    return Promise.resolve(gitResult(""));
  });
}

function baseDependencies(
  exitCodes: number[],
  localTargets: LocalTargets
): CliDependencies {
  return {
    localTargets,
    doctor: {
      run: vi.fn(() => Promise.resolve({
        status: "passed" as const,
        runtimeBackend: "adb" as const,
        deviceSerial: "emulator-5554",
        checks: [
          { name: "node" as const, status: "passed" as const, version: "24.3.0" },
          {
            name: "app" as const,
            status: "passed" as const,
            message: "com.example.app"
          }
        ]
      }))
    },
    recorder: { record: vi.fn(() => Promise.reject(new Error("unused"))) },
    verifier: { verify: vi.fn(() => Promise.reject(new Error("unused"))) },
    projectDescriber: {
      describe: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextValidator: {
      validate: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextLoader: {
      load: vi.fn(() => Promise.reject(new Error("unused"))),
      readIndex: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextRefresher: {
      refresh: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextGenerator: {
      generate: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextRehasher: {
      rehash: vi.fn(() => Promise.reject(new Error("unused")))
    },
    generationStarter: {
      start: vi.fn(() => Promise.reject(new Error("unused")))
    },
    runtimeObserver: {
      observe: vi.fn(() => Promise.reject(new Error("unused")))
    },
    init: { install: vi.fn(() => Promise.reject(new Error("unused"))) },
    initPrompt: {
      selectAgents: vi.fn(() => Promise.reject(new Error("unused")))
    },
    align: { alignCamera: vi.fn(() => Promise.reject(new Error("unused"))) },
    observer: () => ({
      observe: vi.fn(() => Promise.reject(new Error("unused")))
    }),
    workspaceLayout: fakeWorkspaceLayout(),
    readJson: vi.fn((path: string) => Promise.resolve(
      path.includes("config.json") ? undefined : undefined
    )),
    cwd: () => "/project",
    stdout: new BufferOutput(),
    stderr: new BufferOutput(),
    setExitCode: (code): void => {
      exitCodes.push(code);
    }
  };
}

async function runDoctor(
  dependencies: CliDependencies,
  args: readonly string[]
): Promise<void> {
  await createProgram(dependencies).parseAsync(["node", "taphound", ...args]);
}

function jsonOutput(dependencies: CliDependencies): Record<string, unknown> {
  const stdout = (dependencies.stdout as BufferOutput).value;
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("taphound doctor --target", () => {
  it("emits one JSON value with target.resolvedPath and target checks for a matching package", async () => {
    const fixture = await makeTargetProject("com.example.app");
    const fake = fakeLocalTargets(fixture);
    mockGit(fake.processRun);
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runDoctor(dependencies, ["doctor", "--target", fixture.id, "--json"]);

    expect(exitCodes).toEqual([0]);
    const report = jsonOutput(dependencies);
    expect(report).toMatchObject({
      status: "passed",
      runtimeBackend: "adb",
      target: {
        id: fixture.id,
        resolvedPath: fixture.projectRoot,
        workspaceRoot: fixture.workspaceRoot,
        git: { branch: "main", head: "deadbeefcafebabe", dirty: false },
        packageName: "com.example.app"
      }
    });
    const checks = report.checks as Array<{ name: string; status: string }>;
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "target-path", status: "passed" }),
      expect.objectContaining({ name: "android-project", status: "passed" }),
      expect.objectContaining({ name: "git-state", status: "passed" }),
      expect.objectContaining({ name: "package-identity", status: "passed" }),
      expect.objectContaining({ name: "local-workspace", status: "passed" })
    ]));
    expect(checks).toContainEqual(expect.objectContaining({ name: "node" }));
  });

  it("exits 2 with PACKAGE_IDENTITY_MISMATCH when applicationId evidence differs", async () => {
    const fixture = await makeTargetProject("com.other.app");
    const fake = fakeLocalTargets(fixture);
    mockGit(fake.processRun);
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runDoctor(dependencies, ["doctor", "--target", fixture.id, "--json"]);

    expect(exitCodes).toEqual([2]);
    const output = jsonOutput(dependencies);
    expect(output).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "PACKAGE_IDENTITY_MISMATCH" }
    });
  });

  it("exits 2 with LOCAL_TARGET_NOT_FOUND for an unregistered id", async () => {
    const fixture = await makeTargetProject("com.example.app");
    const fake = fakeLocalTargets(fixture);
    vi.mocked(fake.resolve).mockRejectedValue(
      new TargetError("LOCAL_TARGET_NOT_FOUND", "not registered")
    );
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runDoctor(dependencies, [
      "doctor", "--target", "nope", "--json"
    ]);

    expect(exitCodes).toEqual([2]);
    const output = jsonOutput(dependencies);
    expect(output).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "LOCAL_TARGET_NOT_FOUND" }
    });
  });

  it("propagates an APP_NOT_INSTALLED device-doctor failure as exit 3 with intact JSON", async () => {
    const fixture = await makeTargetProject("com.example.app");
    const fake = fakeLocalTargets(fixture);
    mockGit(fake.processRun);
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);
    vi.mocked(dependencies.doctor.run).mockResolvedValue({
      status: "failed",
      runtimeBackend: "adb",
      deviceSerial: "emulator-5554",
      failureCode: "APP_NOT_INSTALLED",
      checks: [
        { name: "app" as const, status: "failed" as const, message: "not installed" }
      ]
    });

    await runDoctor(dependencies, ["doctor", "--target", fixture.id, "--json"]);

    expect(exitCodes).toEqual([3]);
    const report = jsonOutput(dependencies);
    expect(report).toMatchObject({
      status: "failed",
      failureCode: "APP_NOT_INSTALLED",
      target: { id: fixture.id }
    });
  });

  it("still selects a device when --device is provided alongside --target", async () => {
    const fixture = await makeTargetProject("com.example.app");
    const fake = fakeLocalTargets(fixture);
    mockGit(fake.processRun);
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runDoctor(dependencies, [
      "doctor", "--target", fixture.id, "--device", "serial-1234", "--json"
    ]);

    expect(exitCodes).toEqual([0]);
    expect(dependencies.doctor.run).toHaveBeenCalledWith(
      expect.objectContaining({ requestedDevice: "serial-1234" })
    );
  });

  it("exits 2 with LOCAL_TARGET_NOT_ANDROID_PROJECT when the target has no Android project structure", async () => {
    const fixture = await makeTargetProject("com.example.app", {
      androidProject: false
    });
    const fake = fakeLocalTargets(fixture);
    mockGit(fake.processRun);
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runDoctor(dependencies, ["doctor", "--target", fixture.id, "--json"]);

    expect(exitCodes).toEqual([2]);
    const output = jsonOutput(dependencies);
    expect(output).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "LOCAL_TARGET_NOT_ANDROID_PROJECT" }
    });
  });

  it("warns and still runs the device doctor when identity is missing", async () => {
    const fixture = await makeTargetProject("com.example.app", {
      withIdentity: false
    });
    const fake = fakeLocalTargets(fixture);
    mockGit(fake.processRun);
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runDoctor(dependencies, ["doctor", "--target", fixture.id, "--json"]);

    expect(exitCodes).toEqual([0]);
    expect(dependencies.doctor.run).toHaveBeenCalled();
    const report = jsonOutput(dependencies);
    const checks = report.checks as Array<{ name: string; status: string }>;
    expect(checks).toContainEqual(
      expect.objectContaining({ name: "local-workspace", status: "warn" })
    );
  });

  it("skips git probes and reports git-state warn when git.enabled is false", async () => {
    const fixture = await makeTargetProject("com.example.app");
    const fake = fakeLocalTargets(fixture, {}, false);
    mockGit(fake.processRun);
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runDoctor(dependencies, ["doctor", "--target", fixture.id, "--json"]);

    expect(exitCodes).toEqual([0]);
    expect(fake.processRun).not.toHaveBeenCalled();
    const report = jsonOutput(dependencies);
    const checks = report.checks as Array<{ name: string; status: string }>;
    expect(checks).toContainEqual(
      expect.objectContaining({ name: "git-state", status: "warn" })
    );
    expect(report).toMatchObject({
      target: { id: fixture.id, git: null }
    });
  });

  it("exits 2 with LOCAL_TARGET_PROJECT_CHANGED when the saved fingerprint no longer matches", async () => {
    const fixture = await makeTargetProject("com.example.app");
    const resolver = {
      resolve: vi.fn(() => Promise.resolve(resolvedTarget(fixture))),
      fingerprint: vi.fn(() => Promise.resolve({
        schemaVersion: 1 as const,
        hash: "b".repeat(64)
      }))
    } as unknown as TargetResolver;
    const fake = fakeLocalTargets(fixture, {
      targetResolver: (): TargetResolver => resolver
    });
    mockGit(fake.processRun);
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runDoctor(dependencies, ["doctor", "--target", fixture.id, "--json"]);

    expect(exitCodes).toEqual([2]);
    const output = jsonOutput(dependencies);
    expect(output).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "LOCAL_TARGET_PROJECT_CHANGED" }
    });
  });
});