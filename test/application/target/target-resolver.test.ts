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

let projectRoot = "";

afterEach(async () => {
  if (projectRoot !== "") {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = "";
  }
});

async function createProject(): Promise<string> {
  projectRoot = await mkdtemp(join(tmpdir(), "taphound-target-"));
  await writeFile(
    join(projectRoot, "settings.gradle.kts"),
    'rootProject.name = "mail"\n',
    "utf8"
  );
  await mkdir(join(projectRoot, "gradle", "wrapper"), { recursive: true });
  await writeFile(
    join(projectRoot, "gradle", "wrapper", "gradle-wrapper.properties"),
    "distributionUrl=https://services.gradle.org/distributions/gradle-8.9-bin.zip\n",
    "utf8"
  );
  return projectRoot;
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
});