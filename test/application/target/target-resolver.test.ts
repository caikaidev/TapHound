import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TargetResolver } from "../../../src/application/target/target-resolver.js";
import { commandResult } from "../../fakes/process-runner.js";
import type { ResolvedPath } from "../../../src/ports/path-resolver.js";
import type { LoadedTargets } from "../../../src/ports/target-config-store.js";
import type {
  CommandResult,
  CommandSpec,
  ProcessRunner
} from "../../../src/ports/process-runner.js";

function fakeRunner(results: Record<string, string>): ProcessRunner {
  return {
    run: vi.fn((spec: CommandSpec): Promise<CommandResult> => {
      const key = `${spec.executable} ${spec.args.join(" ")}`;
      return Promise.resolve(commandResult({ stdout: results[key] ?? "" }));
    }),
    start: vi.fn()
  };
}

let projectRoots: string[] = [];

afterEach(async () => {
  for (const root of projectRoots) {
    await rm(root, { recursive: true, force: true });
  }
  projectRoots = [];
});

async function createProject(
  settingsContent = 'rootProject.name = "mail"\n'
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-target-"));
  projectRoots.push(root);
  await writeFile(
    join(root, "settings.gradle.kts"),
    settingsContent,
    "utf8"
  );
  await mkdir(join(root, "gradle", "wrapper"), { recursive: true });
  await writeFile(
    join(root, "gradle", "wrapper", "gradle-wrapper.properties"),
    "distributionUrl=https://services.gradle.org/distributions/gradle-8.9-bin.zip\n",
    "utf8"
  );
  return root;
}

function configStore(targets: Record<string, unknown>): LoadedTargets {
  return {
    targets: targets as LoadedTargets["targets"],
    official: undefined,
    local: undefined
  };
}

describe("TargetResolver", () => {
  it("resolves a registered id through the config store", async () => {
    const root = await createProject();
    const resolver = new TargetResolver({
      targetsHome: "/repo/benchmarks",
      configStore: {
        loadTargets: vi.fn((): Promise<LoadedTargets> => Promise.resolve(
          configStore({
            app: {
              id: "app",
              source: { type: "local", path: root },
              run: { packageName: "com.example.app" },
              override: false
            }
          })
        )),
        appendLocalTarget: vi.fn((): Promise<void> => Promise.resolve()),
        removeLocalTarget: vi.fn((): Promise<boolean> => Promise.resolve(false))
      },
      pathResolver: {
        resolve: vi.fn((): Promise<ResolvedPath> => Promise.resolve({ configuredPath: root, resolvedPath: root }))
      },
      processRunner: fakeRunner({
        [`git -C ${root} rev-parse --show-toplevel`]: `${root}\n`
      }),
      clock: { now: (): Date => new Date("2026-09-10T00:00:00.000Z") }
    });
    const target = await resolver.resolve("app");
    expect(target.id).toBe("app");
    expect(target.resolvedPath).toBe(root);
    expect(target.workspaceRoot).toBe("/repo/benchmarks/.taphound/local/app");
  });

  it("throws LOCAL_TARGET_NOT_FOUND for an unknown id", async () => {
    const resolver = new TargetResolver({
      targetsHome: "/repo/benchmarks",
      configStore: {
        loadTargets: vi.fn((): Promise<LoadedTargets> => Promise.resolve(configStore({}))),
        appendLocalTarget: vi.fn((): Promise<void> => Promise.resolve()),
        removeLocalTarget: vi.fn((): Promise<boolean> => Promise.resolve(false))
      },
      pathResolver: {
        resolve: vi.fn((): Promise<ResolvedPath> => Promise.resolve({ configuredPath: "", resolvedPath: "" }))
      },
      processRunner: fakeRunner({}),
      clock: { now: (): Date => new Date() }
    });
    await expect(resolver.resolve("nope")).rejects.toMatchObject({
      code: "LOCAL_TARGET_NOT_FOUND"
    });
  });

  it("builds a stable fingerprint from git remote, project name, and package", async () => {
    const root = await createProject();
    const resolver = new TargetResolver({
      targetsHome: "/repo/benchmarks",
      configStore: {
        loadTargets: vi.fn((): Promise<LoadedTargets> => Promise.resolve(
          configStore({
            app: {
              id: "app",
              source: { type: "local", path: root },
              run: { packageName: "com.example.app" },
              override: false
            }
          })
        )),
        appendLocalTarget: vi.fn((): Promise<void> => Promise.resolve()),
        removeLocalTarget: vi.fn((): Promise<boolean> => Promise.resolve(false))
      },
      pathResolver: {
        resolve: vi.fn((): Promise<ResolvedPath> => Promise.resolve({ configuredPath: root, resolvedPath: root }))
      },
      processRunner: fakeRunner({
        [`git -C ${root} rev-parse --show-toplevel`]: `${root}\n`,
        [`git -C ${root} config --get remote.origin.url`]: "git@github.com:acme/mail.git\n",
        [`git -C ${root} rev-parse HEAD`]: "abc123\n"
      }),
      clock: { now: (): Date => new Date() }
    });
    const target = await resolver.resolve("app");
    const fingerprint = await resolver.fingerprint(target.project, "com.example.app");
    expect(fingerprint.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint.gitRemote).toBe("git@github.com:acme/mail.git");
  });

  it("hashes settings content from the target root, independent of cwd", async () => {
    const rootA = await createProject('rootProject.name = "mail"\n');
    const rootB = await createProject('rootProject.name = "webmail"\n');
    const resolverFor = (root: string): TargetResolver =>
      new TargetResolver({
        targetsHome: "/repo/benchmarks",
        configStore: {
          loadTargets: vi.fn((): Promise<LoadedTargets> => Promise.resolve(
            configStore({
              app: {
                id: "app",
                source: { type: "local", path: root },
                run: { packageName: "com.example.app" },
                override: false
              }
            })
          )),
          appendLocalTarget: vi.fn((): Promise<void> => Promise.resolve()),
          removeLocalTarget: vi.fn((): Promise<boolean> => Promise.resolve(false))
        },
        pathResolver: {
          resolve: vi.fn((): Promise<ResolvedPath> => Promise.resolve({ configuredPath: root, resolvedPath: root }))
        },
        processRunner: fakeRunner({
          [`git -C ${root} rev-parse --show-toplevel`]: `${root}\n`,
          [`git -C ${root} config --get remote.origin.url`]: "git@github.com:acme/mail.git\n",
          [`git -C ${root} rev-parse HEAD`]: "abc123\n"
        }),
        clock: { now: (): Date => new Date() }
      });
    const originalCwd = process.cwd();
    const cwdRoot = await mkdtemp(join(tmpdir(), "taphound-cwd-"));
    projectRoots.push(cwdRoot);
    try {
      process.chdir(cwdRoot);
      const resolverA = resolverFor(rootA);
      const resolverB = resolverFor(rootB);
      const [targetA, targetB] = [
        await resolverA.resolve("app"),
        await resolverB.resolve("app")
      ];
      const fingerprintA = await resolverA.fingerprint(targetA.project, "com.example.app");
      const fingerprintB = await resolverB.fingerprint(targetB.project, "com.example.app");
      expect(fingerprintA.rootProjectName).toBe("mail");
      expect(fingerprintB.rootProjectName).toBe("webmail");
      expect(fingerprintA.hash).not.toBe(fingerprintB.hash);
    } finally {
      process.chdir(originalCwd);
    }
  });
});