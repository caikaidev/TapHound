import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { FileSystemTargetConfigStore } from "../../src/adapters/filesystem/target-config-store.js";
import { TargetError } from "../../src/domain/target.js";
import type { LocalTargetService } from "../../src/application/target/local-target-service.js";
import type { TargetResolver } from "../../src/application/target/target-resolver.js";
import type {
  CliDependencies,
  LocalTargets,
  TextOutput
} from "../../src/cli/dependencies.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

interface FakeResolution {
  id: string;
  configuredPath: string;
  resolvedPath: string;
  project: {
    rootDir: string;
    settingsFile: string;
    gitRoot?: string | undefined;
  };
  workspaceRoot: string;
}

function fakeLocalTargets(overrides: Partial<LocalTargets> = {}): {
  bundle: LocalTargets;
  loadTargets: ReturnType<typeof vi.fn>;
  appendLocalTarget: ReturnType<typeof vi.fn>;
  removeLocalTarget: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  resolveByPath: ReturnType<typeof vi.fn>;
  fingerprint: ReturnType<typeof vi.fn>;
  resolveCtor: ReturnType<typeof vi.fn>;
} {
  const loadTargets = vi.fn(() => Promise.resolve({
    targets: {},
    official: undefined,
    local: undefined
  } as never));
  const appendLocalTarget = vi.fn(() => Promise.resolve(undefined));
  const removeLocalTarget = vi.fn(() => Promise.resolve(true));
  const resolve = vi.fn();
  const resolveByPath = vi.fn();
  const fingerprint = vi.fn(() => Promise.resolve({
    schemaVersion: 1 as const,
    hash: "f".repeat(64)
  }));
  const resolveCtor = vi.fn(() => ({
    resolve, resolveByPath, fingerprint
  } as unknown as TargetResolver));
  const root = vi.fn((_home: string, id: string) =>
    `/targets/.taphound/local/${id}`);
  const workspace = {
    root,
    identityPath: vi.fn(),
    readIdentity: vi.fn(() => Promise.resolve(null)),
    writeIdentity: vi.fn(() => Promise.resolve(undefined)),
    ensureWorkspace: vi.fn(() => Promise.resolve(undefined)),
    ensureTaphoundIgnored: vi.fn(() => Promise.resolve(undefined))
  };
  const bundle: LocalTargets = {
    targetsHome: () => "/targets",
    configStore: { loadTargets, appendLocalTarget, removeLocalTarget },
    pathResolver: { resolve: resolveByPath },
    workspace,
    targetResolver: resolveCtor,
    localTargetService: vi.fn(() => (
      {} as unknown as LocalTargetService
    )),
    processRunner: {
      run: vi.fn(() => Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        cancelled: false
      })),
      start: vi.fn()
    },
    clock: { now: () => new Date("2024-01-01T00:00:00.000Z") },
    ...overrides
  };
  return {
    bundle,
    loadTargets,
    appendLocalTarget,
    removeLocalTarget,
    resolve,
    resolveByPath,
    fingerprint,
    resolveCtor
  };
}

function baseDependencies(
  exitCodes: number[],
  localTargets: LocalTargets
): CliDependencies {
  return {
    localTargets,
    doctor: {
      run: vi.fn(() => Promise.reject(new Error("unused")))
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
    readJson: vi.fn(() => Promise.reject(new Error("unused"))),
    cwd: () => "/project",
    stdout: new BufferOutput(),
    stderr: new BufferOutput(),
    setExitCode: (code): void => {
      exitCodes.push(code);
    }
  };
}

async function runLocal(
  dependencies: CliDependencies,
  args: readonly string[]
): Promise<void> {
  await createProgram(dependencies).parseAsync(["node", "taphound", ...args]);
}

const RESOLUTION: FakeResolution = {
  id: "path-000000000000",
  configuredPath: "/tmp/work-app",
  resolvedPath: "/tmp/work-app",
  project: {
    rootDir: "/tmp/work-app",
    settingsFile: "settings.gradle.kts",
    gitRoot: "/repo"
  },
  workspaceRoot: "/targets/.taphound/local/work-app"
};

describe("taphound local", () => {
  it("add emits exactly one JSON value with id and resolvedPath", async () => {
    const exitCodes: number[] = [];
    const fake = fakeLocalTargets();
    vi.mocked(fake.resolveByPath).mockResolvedValue(RESOLUTION);
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runLocal(dependencies, [
      "local", "add", "work-app",
      "--path", "/tmp/work-app",
      "--package", "com.example.app",
      "--json"
    ]);

    const stdout = (dependencies.stdout as BufferOutput).value;
    const output = JSON.parse(stdout) as {
      id: string;
      configuredPath: string;
      resolvedPath: string;
      workspaceRoot: string;
      detected: { gradleRoot: string; gitRepo: string | null; packageName: string };
      config: string;
    };
    expect(output.id).toBe("work-app");
    expect(output.resolvedPath).toBe("/tmp/work-app");
    expect(output.configuredPath).toBe("/tmp/work-app");
    expect(output.workspaceRoot).toBe("/targets/.taphound/local/work-app");
    expect(output.detected.gradleRoot).toBe("/tmp/work-app");
    expect(output.detected.gitRepo).toBe("/repo");
    expect(output.detected.packageName).toBe("com.example.app");
    expect(output.config).toBe("benchmarks/targets.local.json");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(exitCodes).toEqual([0]);
    expect(fake.appendLocalTarget).toHaveBeenCalled();
    expect(fake.bundle.workspace.ensureWorkspace).toHaveBeenCalled();
  });

  it("add without --package reuses an existing stored packageName", async () => {
    const exitCodes: number[] = [];
    const fake = fakeLocalTargets();
    vi.mocked(fake.loadTargets).mockResolvedValue({
      targets: {
        "work-app": {
          id: "work-app",
          source: { type: "local", path: "/tmp/work-app" },
          run: { packageName: "com.example.app" },
          override: false
        }
      },
      official: undefined,
      local: undefined
    });
    vi.mocked(fake.resolveByPath).mockResolvedValue(RESOLUTION);
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runLocal(dependencies, [
      "local", "add", "work-app",
      "--path", "/tmp/work-app",
      "--json"
    ]);

    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { id: string; detected: { packageName: string }; config: string };
    expect(output.id).toBe("work-app");
    expect(output.detected.packageName).toBe("com.example.app");
    expect(output.config).toBe("benchmarks/targets.local.json");
    expect(exitCodes).toEqual([0]);
    expect(fake.appendLocalTarget).toHaveBeenCalledWith(
      "/targets",
      "work-app",
      expect.objectContaining({
        run: { packageName: "com.example.app" }
      })
    );
  });

  it("add without --package and without a stored package fails with TARGET_CONFIG_INVALID", async () => {
    const exitCodes: number[] = [];
    const fake = fakeLocalTargets();
    vi.mocked(fake.loadTargets).mockResolvedValue({
      targets: {},
      official: undefined,
      local: undefined
    });
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runLocal(dependencies, [
      "local", "add", "work-app",
      "--path", "/tmp/work-app",
      "--json"
    ]);

    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { exitCode: number; failure: { code: string } };
    expect(output.exitCode).toBe(2);
    expect(output.failure.code).toBe("TARGET_CONFIG_INVALID");
    expect(exitCodes).toEqual([2]);
    expect(fake.resolveByPath).not.toHaveBeenCalled();
  });

  it("add --activity stores the launch activity in the written targets.local.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "taphound-targets-"));
    try {
      const exitCodes: number[] = [];
      const fake = fakeLocalTargets({
        configStore: new FileSystemTargetConfigStore()
      });
      vi.mocked(fake.resolveByPath).mockResolvedValue(RESOLUTION);
      const dependencies = baseDependencies(exitCodes, fake.bundle);

      await runLocal(dependencies, [
        "local", "add", "work-app",
        "--path", "/tmp/work-app",
        "--package", "com.example.tchat",
        "--activity", ".ui.SplashActivity",
        "--targets", home,
        "--json"
      ]);

      const output = JSON.parse(
        (dependencies.stdout as BufferOutput).value
      ) as { id: string };
      expect(output.id).toBe("work-app");
      expect(exitCodes).toEqual([0]);

      const written = JSON.parse(
        await readFile(join(home, "benchmarks/targets.local.json"), "utf8")
      ) as {
        targets: Record<string, {
          run: { packageName: string; activity?: string };
        }>;
      };
      expect(written.targets["work-app"]?.run).toEqual({
        packageName: "com.example.tchat",
        activity: ".ui.SplashActivity"
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("list marks targets READY and MISSING without throwing", async () => {
    const exitCodes: number[] = [];
    const fake = fakeLocalTargets();
    vi.mocked(fake.loadTargets).mockResolvedValue({
      targets: {
        ready: {
          id: "ready",
          source: { type: "local", path: "/tmp/ready" },
          run: { packageName: "com.ready.app" },
          override: false
        },
        broken: {
          id: "broken",
          source: { type: "local", path: "/does/not/exist" },
          run: { packageName: "com.broken.app" },
          override: false
        }
      },
      official: undefined,
      local: undefined
    });
    vi.mocked(fake.resolve)
      .mockRejectedValueOnce(
        new TargetError("LOCAL_TARGET_NOT_FOUND", "missing")
      )
      .mockResolvedValueOnce({
        id: "ready",
        sourceType: "local",
        configuredPath: "/tmp/ready",
        resolvedPath: "/tmp/ready",
        project: { rootDir: "/tmp/ready", settingsFile: "settings.gradle" },
        workspaceRoot: "/targets/.taphound/local/ready"
      });
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runLocal(dependencies, ["local", "list", "--json"]);

    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { targets: Array<{ id: string; status: string; source: string }> };
    expect(output.targets).toContainEqual(
      expect.objectContaining({ id: "ready", status: "READY", source: "/tmp/ready" })
    );
    expect(output.targets).toContainEqual(
      expect.objectContaining({ id: "broken", status: "MISSING", source: "/does/not/exist" })
    );
    expect(exitCodes).toEqual([0]);
  });

  it("inspect unknown id exits 2 with LOCAL_TARGET_NOT_FOUND", async () => {
    const exitCodes: number[] = [];
    const fake = fakeLocalTargets();
    vi.mocked(fake.resolve).mockRejectedValue(
      new TargetError("LOCAL_TARGET_NOT_FOUND", "not found")
    );
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runLocal(dependencies, ["local", "inspect", "nope", "--json"]);

    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { exitCode: number; failure: { code: string } };
    expect(output.exitCode).toBe(2);
    expect(output.failure.code).toBe("LOCAL_TARGET_NOT_FOUND");
    expect(exitCodes).toEqual([2]);
  });

  it("inspect resolves an existing target with git and journeys count", async () => {
    const exitCodes: number[] = [];
    const fake = fakeLocalTargets();
    vi.mocked(fake.resolve).mockResolvedValue({
      id: "work-app",
      sourceType: "local",
      configuredPath: "/tmp/work-app",
      resolvedPath: "/tmp/work-app",
      project: {
        rootDir: "/tmp/work-app",
        settingsFile: "settings.gradle.kts",
        gitRoot: "/repo"
      },
      workspaceRoot: "/targets/.taphound/local/work-app"
    });
    vi.mocked(fake.bundle.processRunner.run).mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      cancelled: false
    });
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runLocal(dependencies, ["local", "inspect", "work-app", "--json"]);

    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { id: string; git: object | null; journeys: number };
    expect(output.id).toBe("work-app");
    expect(output.git).not.toBeNull();
    expect(output.journeys).toBe(0);
    expect(exitCodes).toEqual([0]);
  });

  it("remove returns removed true and false based on registration", async () => {
    const removedCodes: number[] = [];
    const removedFake = fakeLocalTargets();
    vi.mocked(removedFake.removeLocalTarget).mockResolvedValue(true);
    const removed = baseDependencies(removedCodes, removedFake.bundle);
    await runLocal(removed, ["local", "remove", "work-app", "--json"]);
    expect(JSON.parse((removed.stdout as BufferOutput).value))
      .toEqual({ id: "work-app", removed: true });
    expect(removedCodes).toEqual([0]);

    const missingCodes: number[] = [];
    const missingFake = fakeLocalTargets();
    vi.mocked(missingFake.removeLocalTarget).mockResolvedValue(false);
    const missing = baseDependencies(missingCodes, missingFake.bundle);
    await runLocal(missing, ["local", "remove", "ghost", "--json"]);
    expect(JSON.parse((missing.stdout as BufferOutput).value))
      .toEqual({ id: "ghost", removed: false });
    expect(missingCodes).toEqual([0]);
  });

  it("propagates a TargetError to exit code 2 for add path failures", async () => {
    const exitCodes: number[] = [];
    const fake = fakeLocalTargets();
    vi.mocked(fake.resolveByPath).mockRejectedValue(
      new TargetError("LOCAL_TARGET_NOT_ANDROID_PROJECT", "not a project")
    );
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runLocal(dependencies, [
      "local", "add", "bad", "--path", "/bad",
      "--package", "com.bad.app", "--json"
    ]);

    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { exitCode: number; failure: { code: string } };
    expect(output.exitCode).toBe(2);
    expect(output.failure.code).toBe("LOCAL_TARGET_NOT_ANDROID_PROJECT");
    expect(exitCodes).toEqual([2]);
  });
});