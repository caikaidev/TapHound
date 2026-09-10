# TapHound Local Target (Real App Validation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let TapHound point at a real Android project outside the repository (absolute/relative/env-var/symlink path), with per-target isolated workspace, and run `doctor`, `context`, `verify`, and `verify-changes` against it — without touching the target repo or weakening project-relative path checks.

**Architecture:** Introduce a Local Target model: `targets.yaml` + `targets.local.yaml` under `benchmarks/` declare named targets of `type: local`; a `TargetPathResolver` normalizes the configured path (env expansion, `~`, relative, realpath) and validates the Android project root; `LocalTargetService` loads/merges target configs, computes a stable project fingerprint, and exposes a per-target **workspace root** (`benchmarks/.taphound/local/<target-id>/`) that owns all TapHound data (context, knowledge, journeys, runs). Commands keep the existing `projectRoot`-shaped ports; TapHound-owned reads route through a shared `tapHoundPath(projectRoot, workspaceRoot, relative)` helper so workspace and source roots are independent.

**Tech Stack:** Node 22+, TypeScript strict ESM (NodeNext, `.js` suffixes), zod `z.strictObject`, commander, vitest, existing `ProcessRunner`/`FsPorts`-style adapters. No new runtime dependencies.

## Global Constraints

- ESM + NodeNext; source imports use `.js` suffixes.
- TypeScript strict, exact optional properties, unchecked index access; eslint type-aware rules require explicit return types.
- Protocol schemas use `z.strictObject`; unknown fields rejected. Schema changes must update docs/examples/fixtures/tests together.
- Never execute target-declared `build.command` or `install` commands implicitly — config parsing and command execution stay separated (Section 11/12/39 of the design).
- Machine-readable `--json` commands emit exactly one JSON value on stdout; diagnostics to stderr; JSON `exitCode` matches process exit code.
- Local target private paths must never be committed: `benchmarks/targets.local.yaml`, `benchmarks/apps/local/`, `benchmarks/cases/local/`, `benchmarks/.taphound/` are gitignored.
- Never store env-var *values* in committed files; never print secret env vars.
- No comments in code (repo rule: do not add comments).
- Quality gate per run: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run brand:render`, `git diff --exit-code -- assets/brand/png`.
- Design doc reference: `TapHound_V2.1_Local_Real_App_Validation_Design.md` (user copy in `~/Downloads`); P0 scope is this plan's core, plus the CLI surface needed for the Section 44 acceptance flow and `verify-changes --target` (P1). `generation --target` is deferred (see "Deferred").

---

### Task 1: Target domain schemas and failure codes

**Files:**
- Create: `src/domain/target.ts`
- Modify: `src/domain/failure.ts`
- Test: `test/domain/target.test.ts`

**Interfaces:**
- Consumes: `FailureCode` (`src/domain/failure.ts`), z.
- Produces: `TargetsFileSchema`, `LocalTargetSourceSchema`, `TargetEntrySchema`, `AndroidProjectIdentity`, `ResolvedTarget`, `ProjectFingerprint`, `LocalTargetIdentity`, `TargetError` (a `Error` subclass carrying a `FailureCode`), `ConfigDefaults` (`DEFAULT_TARGET_IDLE`, `DEFAULT_TARGET_ACTIVITY`).

- [ ] **Step 1: Write failing tests**

`test/domain/target.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  AndroidProjectIdentitySchema,
  LocalTargetIdentitySchema,
  ProjectFingerprintSchema,
  TargetsFileSchema,
  TargetError
} from "../../src/domain/target.js";
import { FAILURE_CODES } from "../../src/domain/failure.js";

describe("target domain", () => {
  it("parses a targets file with a local target", () => {
    const parsed = TargetsFileSchema.parse({
      version: 1,
      targets: {
        "work-app": {
          source: { type: "local", path: "${TAPHOUND_WORK_APP}" },
          run: { packageName: "com.example.app", activity: ".MainActivity" },
          git: { enabled: true }
        }
      }
    });
    expect(parsed.targets["work-app"].run.packageName).toBe("com.example.app");
    expect(parsed.targets["work-app"].run.activity).toBe(".MainActivity");
  });

  it("defaults activity and git.enabled", () => {
    const parsed = TargetsFileSchema.parse({
      version: 1,
      targets: {
        app: {
          source: { type: "local", path: "/tmp/app" },
          run: { packageName: "com.example.app" }
        }
      }
    });
    expect(parsed.targets.app.run.activity).toBe(".MainActivity");
    expect(parsed.targets.app.git.enabled).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(() => TargetsFileSchema.parse({
      version: 1,
      targets: {
        app: {
          source: { type: "local", path: "/tmp/app" },
          run: { packageName: "com.example.app" },
          nope: true
        }
      }
    })).toThrow();
  });

  it("validates the AndroidProjectIdentity contract", () => {
    expect(() => AndroidProjectIdentitySchema.parse({
      rootDir: "/x", settingsFile: "/x/settings.gradle.kts"
    })).not.toThrow();
    expect(() => AndroidProjectIdentitySchema.parse({
      rootDir: "/x"
    })).toThrow();
  });

  it("parses and round-trips fingerprint and identity documents", () => {
    const fingerprint = ProjectFingerprintSchema.parse({
      schemaVersion: 1,
      hash: "abc".repeat(20),
      gitRemote: "git@github.com:acme/mail.git",
      rootProjectName: "MailApp",
      packageName: "com.example.mail"
    });
    expect(fingerprint.hash).toHaveLength(60);
    expect(() => LocalTargetIdentitySchema.parse({
      schemaVersion: 1,
      targetId: "work-app",
      sourceType: "local",
      configuredPath: "${TAPHOUND_WORK_APP}",
      resolvedPath: "/Users/alice/Projects/MailApp",
      fingerprint,
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z"
    })).not.toThrow();
  });

  it("TargetError carries a registered failure code", () => {
    const error = new TargetError("LOCAL_TARGET_ENV_MISSING", "boom");
    expect(FAILURE_CODES).toContain(error.code);
    expect(error.message).toBe("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/domain/target.test.ts`
Expected: FAIL — module `src/domain/target.js` not found.

- [ ] **Step 3: Implement schemas**

Create `src/domain/target.ts` (complete):

```ts
import { z } from "zod";

import type { FailureCode } from "./failure.js";

export const TARGETS_SCHEMA_VERSION = 1 as const;

export const LocalTargetSourceSchema = z.strictObject({
  type: z.literal("local"),
  path: z.string().min(1)
});

export type LocalTargetSource = z.infer<typeof LocalTargetSourceSchema>;

export const ProjectPlatformSchema = z.literal("android");

export const TargetValidationModeSchema = z.literal("local-real");

export const TargetEntrySchema = z.strictObject({
  source: LocalTargetSourceSchema,
  project: z.strictObject({
    platform: ProjectPlatformSchema.default("android")
  }).optional(),
  run: z.strictObject({
    packageName: z.string().regex(
      /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/,
      "packageName must be a qualified Java package"
    ),
    activity: z.string().optional()
  }),
  build: z.strictObject({
    enabled: z.boolean().default(false),
    command: z.string().optional()
  }).optional(),
  install: z.strictObject({
    enabled: z.boolean().default(false),
    apk: z.string().optional()
  }).optional(),
  git: z.strictObject({
    enabled: z.boolean().default(true)
  }).optional(),
  validation: z.strictObject({
    mode: TargetValidationModeSchema
  }).optional(),
  artifacts: z.strictObject({
    namespace: z.string().min(1).optional()
  }).optional(),
  override: z.boolean().default(false)
});

export interface TargetEntry extends z.infer<typeof TargetEntrySchema> {
  readonly id?: string;
}

export const TargetsFileSchema = z.strictObject({
  version: z.literal(TARGETS_SCHEMA_VERSION),
  targets: z.record(TargetEntrySchema)
});

export type TargetsFile = z.infer<typeof TargetsFileSchema>;

export function defaultActivity(packageName: string): string {
  return packageName.endsWith(".main") || packageName.split(".").length === 2
    ? ".MainActivity"
    : ".MainActivity";
}

export const DEFAULT_TARGET_ACTIVITY = ".MainActivity";

export const DEFAULT_TARGET_IDLE = {
  strategy: "hybrid",
  pollIntervalMs: 200,
  stablePolls: 2,
  timeoutMs: 5000
} as const;

export const AndroidProjectIdentitySchema = z.strictObject({
  rootDir: z.string().min(1),
  settingsFile: z.string().min(1),
  gradleWrapper: z.string().optional(),
  gitRoot: z.string().optional()
});

export type AndroidProjectIdentity = z.infer<typeof AndroidProjectIdentitySchema>;

export const ResolvedTargetSchema = z.strictObject({
  id: z.string().min(1),
  sourceType: z.literal("local"),
  configuredPath: z.string().min(1),
  resolvedPath: z.string().min(1),
  project: AndroidProjectIdentitySchema,
  workspaceRoot: z.string().min(1)
});

export type ResolvedTarget = z.infer<typeof ResolvedTargetSchema>;

export const ProjectFingerprintSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  gitRemote: z.string().optional(),
  rootProjectName: z.string().optional(),
  packageName: z.string().optional()
});

export type ProjectFingerprint = z.infer<typeof ProjectFingerprintSchema>;

export const LocalTargetIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  targetId: z.string().min(1),
  sourceType: z.literal("local"),
  configuredPath: z.string().min(1),
  resolvedPath: z.string().min(1),
  fingerprint: ProjectFingerprintSchema,
  packageName: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type LocalTargetIdentity = z.infer<typeof LocalTargetIdentitySchema>;

export class TargetError extends Error {
  public readonly code: FailureCode;

  public constructor(code: FailureCode, message: string) {
    super(message);
    this.name = "TargetError";
    this.code = code;
  }
}
```

(Note: `defaultActivity` is intentionally a fixed default; keep it simple — remove `defaultActivity` if unused, use `DEFAULT_TARGET_ACTIVITY`.)

Modify `src/domain/failure.ts` — add codes to `FAILURE_CODES` and `EXIT_CODES`:

```ts
  "LOCAL_TARGET_NOT_FOUND",
  "LOCAL_TARGET_ENV_MISSING",
  "LOCAL_TARGET_PATH_INVALID",
  "LOCAL_TARGET_NOT_DIRECTORY",
  "LOCAL_TARGET_NOT_ANDROID_PROJECT",
  "LOCAL_TARGET_SYMLINK_BROKEN",
  "LOCAL_TARGET_PROJECT_CHANGED",
  "TARGET_ID_CONFLICT",
  "TARGET_CONFIG_INVALID",
  "PACKAGE_IDENTITY_MISMATCH",
  "GIT_ROOT_NOT_FOUND",
  "GIT_REF_INVALID",
```

and in `EXIT_CODES`:

```ts
  LOCAL_TARGET_NOT_FOUND: 2,
  LOCAL_TARGET_ENV_MISSING: 2,
  LOCAL_TARGET_PATH_INVALID: 2,
  LOCAL_TARGET_NOT_DIRECTORY: 2,
  LOCAL_TARGET_NOT_ANDROID_PROJECT: 2,
  LOCAL_TARGET_SYMLINK_BROKEN: 2,
  LOCAL_TARGET_PROJECT_CHANGED: 2,
  TARGET_ID_CONFLICT: 2,
  TARGET_CONFIG_INVALID: 2,
  PACKAGE_IDENTITY_MISMATCH: 2,
  GIT_ROOT_NOT_FOUND: 2,
  GIT_REF_INVALID: 2,
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/domain/target.test.ts test/domain/failure.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/target.ts src/domain/failure.ts test/domain/target.test.ts
git commit -m "feat: add Local Target domain schemas and failure codes"
```

---

### Task 2: Workspace constants and `tapHoundPath` helper

**Files:**
- Modify: `src/domain/workspace.ts`
- Test: `test/domain/workspace.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TARGETS_DIR` (`"benchmarks"`), `TARGETS_CONFIG_PATH` (`"targets.yaml"`), `TARGETS_LOCAL_CONFIG_PATH` (`"targets.local.yaml"`), `LOCAL_TARGETS_HOME = "${TAPHOUND_DIR}/local"`, `localTargetsHome(targetsHome)`, `localTargetWorkspaceRoot(targetsHome, targetId)`, `tapHoundPath(projectRoot, workspaceRoot, relative)`, and a `LOCAL_WORKSPACE_IGNORE = "local/\n"` used by the config-store task.

- [ ] **Step 1: Write failing tests** (append to `test/domain/workspace.test.ts`)

```ts
import {
  localTargetWorkspaceRoot,
  tapHoundPath,
  TARGETS_DIR
} from "../../src/domain/workspace.js";

describe("local target workspace", () => {
  it("derives the per-target workspace root", () => {
    expect(localTargetWorkspaceRoot("/repo/benchmarks", "work-app")).toBe(
      "/repo/benchmarks/.taphound/local/work-app"
    );
  });

  it("tapHoundPath is identity when no workspace root is set", () => {
    expect(tapHoundPath("/proj", undefined, ".taphound/knowledge")).toBe(
      "/proj/.taphound/knowledge"
    );
  });

  it("tapHoundPath rebases TapHound-owned data onto the workspace root", () => {
    expect(tapHoundPath("/real/app", "/ws", ".taphound/journeys/x.json")).toBe(
      "/ws/journeys/x.json"
    );
  });

  it("exposes the benchmarks targets directory constant", () => {
    expect(TARGETS_DIR).toBe("benchmarks");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/domain/workspace.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement**

In `src/domain/workspace.ts` add (after `BENCHMARK_RUNS_DIR`):

```ts
export const TARGETS_DIR = "benchmarks";
export const TARGETS_CONFIG_PATH = `${TARGETS_DIR}/targets.yaml`;
export const TARGETS_LOCAL_CONFIG_PATH = `${TARGETS_DIR}/targets.local.yaml`;
export const LOCAL_WORKSPACE_DIR = `${TAPHOUND_DIR}/local`;
export const LOCAL_WORKSPACE_IGNORE = "local/\n";

export function localTargetWorkspaceRoot(
  targetsHome: string,
  targetId: string
): string {
  return join(targetsHome, LOCAL_WORKSPACE_DIR, targetId);
}

export function tapHoundPath(
  projectRoot: string,
  workspaceRoot: string | undefined,
  relative: string
): string {
  const base = workspaceRoot ?? projectRoot;
  const reduced = relative.startsWith(`${TAPHOUND_DIR}/`)
    ? relative.slice(TAPHOUND_DIR.length + 1)
    : relative;
  return join(base, reduced);
}
```

(`join`, `hasOwn` etc. — `join` is already imported in workspace.ts; if not, add `join` to the `node:path` import.)

- [ ] **Step 4: Run tests**

Run: `npm test -- test/domain/workspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/workspace.ts test/domain/workspace.test.ts
git commit -m "feat: add local target workspace paths and tapHoundPath helper"
```

---

### Task 3: TargetPathResolver port and filesystem adapter

**Files:**
- Create: `src/ports/path-resolver.ts`
- Create: `src/adapters/filesystem/target-path-resolver.ts`
- Test: `test/adapters/target-path-resolver.test.ts`

**Interfaces:**
- Consumes: `TargetError`, `FailureCode`, `node:path`, `node:fs/promises`.
- Produces: `ResolvedPath = { configuredPath: string; resolvedPath: string }`; `TargetPathResolver.resolve(input, baseDir)`.

- [ ] **Step 1: Write failing tests**

`test/adapters/target-path-resolver.test.ts`:

```ts
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TargetPathResolver } from "../../src/adapters/filesystem/target-path-resolver.js";
import { TargetError } from "../../src/domain/target.js";

let roots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-target-"));
  roots.push(root);
  return root;
}

async function androidProject(): Promise<string> {
  const root = await fixtureRoot();
  await mkdir(join(root, "app"));
  await writeFile(join(root, "settings.gradle.kts"), "rootProject.name = \"Mail\"");
  await writeFile(join(root, "gradlew"), "#!/bin/sh\n");
  await writeFile(join(root, "app", "build.gradle.kts"), "");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("TargetPathResolver", () => {
  it("expands ${VAR} and $VAR", async () => {
    const project = await androidProject();
    const resolver = new TargetPathResolver({
      env: { TAPHOUND_WORK_APP: project }
    });
    await expect(resolver.resolve("${TAPHOUND_WORK_APP}", "/")).resolves.toMatchObject({
      configuredPath: "${TAPHOUND_WORK_APP}",
      resolvedPath: project
    });
    await expect(resolver.resolve("$TAPHOUND_WORK_APP", "/")).resolves.toMatchObject({
      resolvedPath: project
    });
  });

  it("fails with LOCAL_TARGET_ENV_MISSING for an unset variable", async () => {
    const resolver = new TargetPathResolver({ env: {} });
    await expect(resolver.resolve("${TAPHOUND_WORK_APP}", "/")).rejects.toMatchObject({
      code: "LOCAL_TARGET_ENV_MISSING"
    });
  });

  it("expands ~ and resolves relative paths against baseDir", async () => {
    const project = await androidProject();
    const resolver = new TargetPathResolver({ env: {}, home: "/nonexistent" });
    const resolved = await resolver.resolve("work-app", join(project, ".."));
    expect(resolved.resolvedPath.replace(/\/$/, "")).toBe(project);
  });

  it("resolves symlink chains with realpath", async () => {
    const project = await androidProject();
    const root = await fixtureRoot();
    const link = join(root, "link");
    const chain = join(root, "chain");
    await symlink(project, link);
    await symlink(link, chain);
    const resolver = new TargetPathResolver({ env: {} });
    const resolved = await resolver.resolve(chain, "/");
    expect(resolved.resolvedPath).toBe(await (await import("node:fs")).promises.realpath(project));
  });

  it("fails with LOCAL_TARGET_SYMLINK_BROKEN for a dangling link", async () => {
    const root = await fixtureRoot();
    await symlink(join(root, "missing"), join(root, "dangling"));
    const resolver = new TargetPathResolver({ env: {} });
    await expect(resolver.resolve(join(root, "dangling"), "/")).rejects.toMatchObject({
      code: "LOCAL_TARGET_SYMLINK_BROKEN"
    });
  });

  it("fails with LOCAL_TARGET_PATH_INVALID for a missing path", async () => {
    const resolver = new TargetPathResolver({ env: {} });
    await expect(resolver.resolve("/no/such/dir", "/")).rejects.toMatchObject({
      code: "LOCAL_TARGET_PATH_INVALID"
    });
  });

  it("fails with LOCAL_TARGET_NOT_DIRECTORY for a file", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "file.txt"), "x");
    const resolver = new TargetPathResolver({ env: {} });
    await expect(resolver.resolve(join(root, "file.txt"), "/")).rejects.toMatchObject({
      code: "LOCAL_TARGET_NOT_DIRECTORY"
    });
  });

  it("fails with LOCAL_TARGET_NOT_ANDROID_PROJECT when no settings file", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "gradlew"), "#!/bin/sh\n");
    const resolver = new TargetPathResolver({ env: {} });
    await expect(resolver.resolve(root, "/")).rejects.toMatchObject({
      code: "LOCAL_TARGET_NOT_ANDROID_PROJECT"
    });
  });

  it("handles directories with spaces and Unicode", async () => {
    const base = await fixtureRoot();
    const project = join(base, "Mài App 测试");
    await mkdir(project);
    await writeFile(join(project, "settings.gradle"), "rootProject.name = \"X\"");
    await writeFile(join(project, "gradlew"), "");
    const resolver = new TargetPathResolver({ env: {} });
    await expect(resolver.resolve(project, "/")).resolves.toMatchObject({
      resolvedPath: project
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/adapters/target-path-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement port and adapter**

`src/ports/path-resolver.ts`:

```ts
export interface ResolvedPath {
  configuredPath: string;
  resolvedPath: string;
}

export interface TargetPathResolverPort {
  resolve: (input: string, baseDir: string) => Promise<ResolvedPath>;
}
```

`src/adapters/filesystem/target-path-resolver.ts`:

```ts
import { homedir } from "node:os";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";

import type {
  ResolvedPath,
  TargetPathResolverPort
} from "../../ports/path-resolver.js";
import { TargetError } from "../../domain/target.js";
import { isErrnoException } from "../../shared/errors.js";

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/;

export interface TargetPathResolverDependencies {
  env: Record<string, string | undefined>;
  home?: string | undefined;
}

function expandEnvironment(input: string, env: Record<string, string | undefined>): string {
  return input.replace(
    ENV_PATTERN,
    (_match, braced: string | undefined, bare: string | undefined): string => {
      const name = braced ?? bare ?? "";
      const value = env[name];
      if (value === undefined || value.length === 0) {
        throw new TargetError(
          "LOCAL_TARGET_ENV_MISSING",
          `Environment variable ${name} is not defined. Configure the target with an explicit path or export ${name}.`
        );
      }
      return value;
    }
  );
}

function expandHome(input: string, home: string): string {
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return input;
}

async function isDirectoryThatExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export class TargetPathResolver implements TargetPathResolverPort {
  public constructor(
    private readonly dependencies: TargetPathResolverDependencies
  ) {}

  public readonly resolve = async (
    input: string,
    baseDir: string
  ): Promise<ResolvedPath> => {
    const home = this.dependencies.home ?? homedir();
    const expanded = expandEnvironment(input, this.dependencies.env);
    const expandedHome = expandHome(expanded, home);
    const candidate = isAbsolute(expandedHome)
      ? normalize(expandedHome)
      : resolve(baseDir, expandedHome);

    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
      throw new TargetError(
        "LOCAL_TARGET_SYMLINK_BROKEN",
        `The configured path does not resolve to an existing directory: ${input}`
      );
    }
    const stats = await stat(canonical);
    if (!stats.isDirectory()) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_DIRECTORY",
        `The configured path is not a directory: ${canonical}`
      );
    }
    if (!(await this.isAndroidProject(canonical))) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_ANDROID_PROJECT",
        `The configured path is not an Android/Gradle project: ${canonical}`
      );
    }
    return { configuredPath: input, resolvedPath: canonical };
  };

  private readonly isAndroidProject = async (root: string): Promise<boolean> => {
    const settings = await Promise.all([
      isDirectoryThatExists(join(root, "settings.gradle")),
      isDirectoryThatExists(join(root, "settings.gradle.kts"))
    ]);
    if (!(settings[0] || settings[1])) {
      return false;
    }
    const wrapper = await Promise.all([
      isDirectoryThatExists(join(root, "gradlew")),
      isDirectoryThatExists(
        join(root, "gradle", "wrapper", "gradle-wrapper.properties")
      )
    ]);
    if (wrapper[0] || wrapper[1]) {
      return true;
    }
    return this.hasModuleBuildFile(root);
  };

  private readonly hasModuleBuildFile = async (root: string): Promise<boolean> => {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (
        await isDirectoryThatExists(join(root, entry.name, "build.gradle"))
        || await isDirectoryThatExists(
          join(root, entry.name, "build.gradle.kts")
        )
      ) {
        return true;
      }
    }
    return false;
  };
}
```

(Import `readdir` from `node:fs/promises` alongside `realpath`/`stat`.)

- [ ] **Step 4: Run tests**

Run: `npm test -- test/adapters/target-path-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ports/path-resolver.ts src/adapters/filesystem/target-path-resolver.ts test/adapters/target-path-resolver.test.ts
git commit -m "feat: add TargetPathResolver with env/home/symlink/android-project normalization"
```

---

### Task 4: Target config store (YAML) with local override and conflict detection

**Files:**
- Create: `src/ports/target-config-store.ts`
- Create: `src/adapters/filesystem/target-config-store.ts`
- Test: `test/adapters/target-config-store.test.ts`

**Interfaces:**
- Consumes: `TargetsFileSchema`, `LocalTargetWorkspace` constants, fs ports.
- Produces: `TargetConfigStorePort.loadTargets(targetsHome)` returning `{ targets: Record<string, TargetEntry & { id: string }>; sources: { file: string; content: TargetsFile }[] }`; `appendLocalTarget(targetsHome, id, entry)` (atomic write, appends/replaces the id in `targets.local.yaml`, creating `targets.local.example.yaml`-style docs later).

Implementation notes: no YAML dependency is allowed — this repo has no YAML parser. Read the existing files as YAML-free JSON? The design doc uses YAML, but adding a YAML parser is a new dependency. Decision: keep the schema in JSON-compatible TS (`targets.json`-style shape) and document that `targets.yaml`/`targets.local.yaml` are parsed as JSON files with `.yaml` extension disabled — no. Better: implement **proper YAML subset parsing** is risky. ALTERNATIVE (chosen): config files are **JSON**: `benchmarks/targets.json` + `benchmarks/targets.local.json`. Update all doc references in the plan consistently (design doc says YAML; note this deviation in the final docs task as a documented decision: JSON keeps the no-new-dependency constraint and uses the same zod strict parsing as config.json).

To keep the plan coherent, use:
- `targets.json` (committed official; optional)
- `targets.local.json` (gitignored; optional; overrides)
and constants `TARGETS_CONFIG_PATH = "benchmarks/targets.json"`, `TARGETS_LOCAL_CONFIG_PATH = "benchmarks/targets.local.json"`.

Paths in Task 2 must be updated accordingly (edit in Task 4 step 3, or adjust Task 2 now: use `.json`). Adjust: in Task 2 constants, use `targets.json` / `targets.local.json`. When implementing Task 4, also accept legacy `targets.yaml` presence and refuse with `TARGET_CONFIG_INVALID` explaining JSON-preferred? Keep simple: JSON only.

Merge rule: for each id in local file: if id exists in official file and local entry `override !== true` → `TARGET_ID_CONFLICT`; else the local entry wins (marking `override` false after merge).

- [ ] **Step 1: Write failing tests**

```ts
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileSystemTargetConfigStore } from "../../src/adapters/filesystem/target-config-store.js";

let home: string;

async function makeHome(): Promise<string> {
  home = await mkdtemp(join(tmpdir(), "taphound-targets-"));
  return home;
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("FileSystemTargetConfigStore", () => {
  it("loads official plus local targets with local override", async () => {
    await makeHome();
    await writeFile(join(home, "targets.json"), JSON.stringify({
      version: 1,
      targets: { amaze: { source: { type: "local", path: "/a/amaze" }, run: { packageName: "a.b.c" } } }
    }));
    await writeFile(join(home, "targets.local.json"), JSON.stringify({
      version: 1,
      targets: { "work-app": { source: { type: "local", path: "${TAPHOUND_WORK_APP}" }, run: { packageName: "com.example.app" } } }
    }));
    const store = new FileSystemTargetConfigStore();
    const loaded = await store.loadTargets(home);
    expect(Object.keys(loaded.targets)).toEqual(["amaze", "work-app"]);
    expect(loaded.targets["work-app"].id).toBe("work-app");
  });

  it("rejects a local id that duplicates an official id without override", async () => {
    await makeHome();
    await writeFile(join(home, "targets.json"), JSON.stringify({
      version: 1,
      targets: { amaze: { source: { type: "local", path: "/a/amaze" }, run: { packageName: "a.b.c" } } }
    }));
    await writeFile(join(home, "targets.local.json"), JSON.stringify({
      version: 1,
      targets: { amaze: { source: { type: "local", path: "/b/other" }, run: { packageName: "x.y.z" } } }
    }));
    const store = new FileSystemTargetConfigStore();
    await expect(store.loadTargets(home)).rejects.toMatchObject({
      code: "TARGET_ID_CONFLICT"
    });
  });

  it("writes appendLocalTarget atomically and preserves existing ids", async () => {
    await makeHome();
    const store = new FileSystemTargetConfigStore();
    await store.appendLocalTarget(home, "work-app", {
      source: { type: "local", path: "${TAPHOUND_WORK_APP}" },
      run: { packageName: "com.example.app" }
    });
    await store.appendLocalTarget(home, "mail-app", {
      source: { type: "local", path: "${MAIL_APP}" },
      run: { packageName: "com.example.mail" }
    });
    const loaded = await store.loadTargets(home);
    expect(Object.keys(loaded.targets).sort()).toEqual(["mail-app", "work-app"]);
    const raw = JSON.parse(await readFile(join(home, "targets.local.json"), "utf8"));
    expect(raw.version).toBe(1);
  });

  it("returns empty targets when no config files exist", async () => {
    await makeHome();
    const store = new FileSystemTargetConfigStore();
    const loaded = await store.loadTargets(home);
    expect(loaded.targets).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/adapters/target-config-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement port and adapter**

Update Task 2 constants in `src/domain/workspace.ts` to:

```ts
export const TARGETS_CONFIG_PATH = `${TARGETS_DIR}/targets.json`;
export const TARGETS_LOCAL_CONFIG_PATH = `${TARGETS_DIR}/targets.local.json`;
```

`src/ports/target-config-store.ts`:

```ts
import type {
  TargetEntry,
  TargetsFile
} from "../domain/target.js";

export interface LoadedTargetEntry extends TargetEntry {
  readonly id: string;
}

export interface LoadedTargets {
  targets: Record<string, LoadedTargetEntry>;
  official: TargetsFile | undefined;
  local: TargetsFile | undefined;
}

export type RegisterTargetInput = Pick<TargetEntry, "source" | "run">;

export interface TargetConfigStorePort {
  loadTargets: (targetsHome: string) => Promise<LoadedTargets>;
  appendLocalTarget: (
    targetsHome: string,
    id: string,
    entry: RegisterTargetInput
  ) => Promise<void>;
  removeLocalTarget: (targetsHome: string, id: string) => Promise<boolean>;
}
```

`src/adapters/filesystem/target-config-store.ts`: implement with `readJsonFile` over `targets.json`/`targets.local.json`:

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  TargetEntrySchema,
  TargetsFileSchema,
  TargetError,
  type TargetEntry,
  type TargetsFile
} from "../../domain/target.js";
import type {
  LoadedTargets,
  RegisterTargetInput,
  TargetConfigStorePort
} from "../../ports/target-config-store.js";
import { isErrnoException } from "../../shared/errors.js";
import { TARGETS_LOCAL_CONFIG_PATH, TARGETS_CONFIG_PATH } from "../../domain/workspace.js";

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

function parsedTargetsFile(raw: unknown, path: string): TargetsFile | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return TargetsFileSchema.parse(raw);
  } catch (error) {
    throw new TargetError(
      "TARGET_CONFIG_INVALID",
      `Invalid target configuration in ${path}: ${(error as Error).message}`
    );
  }
}

export class FileSystemTargetConfigStore implements TargetConfigStorePort {
  public readonly loadTargets = async (
    targetsHome: string
  ): Promise<LoadedTargets> => {
    const official = parsedTargetsFile(
      await readOptionalJson(join(targetsHome, TARGETS_CONFIG_PATH)),
      TARGETS_CONFIG_PATH
    );
    const local = parsedTargetsFile(
      await readOptionalJson(join(targetsHome, TARGETS_LOCAL_CONFIG_PATH)),
      TARGETS_LOCAL_CONFIG_PATH
    );
    const targets: Record<string, TargetEntry & { id: string }> = {};
    for (const [id, entry] of Object.entries(official?.targets ?? {})) {
      targets[id] = { ...entry, id };
    }
    for (const [id, entry] of Object.entries(local?.targets ?? {})) {
      if (targets[id] !== undefined && entry.override !== true) {
        throw new TargetError(
          "TARGET_ID_CONFLICT",
          `Target id "${id}" exists in both ${TARGETS_CONFIG_PATH} and ${TARGETS_LOCAL_CONFIG_PATH}. Set "override": true in the local entry to replace it.`
        );
      }
      targets[id] = {
        ...entry,
        override: false,
        id
      };
    }
    return { targets, official, local };
  };

  public readonly appendLocalTarget = async (
    targetsHome: string,
    id: string,
    entry: RegisterTargetInput
  ): Promise<void> => {
    await mkdir(targetsHome, { recursive: true });
    const path = join(targetsHome, TARGETS_LOCAL_CONFIG_PATH);
    const current = parsedTargetsFile(
      await readOptionalJson(path),
      TARGETS_LOCAL_CONFIG_PATH
    ) ?? { version: 1 as const, targets: {} };
    const next = TargetEntrySchema.parse({ ...entry, override: false });
    const updated: TargetsFile = {
      version: 1,
      targets: { ...current.targets, [id]: next }
    };
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  };

  public readonly removeLocalTarget = async (
    targetsHome: string,
    id: string
  ): Promise<boolean> => {
    const path = join(targetsHome, TARGETS_LOCAL_CONFIG_PATH);
    const current = parsedTargetsFile(await readOptionalJson(path), TARGETS_LOCAL_CONFIG_PATH);
    if (current === undefined || current.targets[id] === undefined) {
      return false;
    }
    const targets = { ...current.targets };
    delete targets[id];
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, targets }, null, 2)}\n`, "utf8");
    await rename(temporary, path);
    return true;
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/adapters/target-config-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/workspace.ts src/ports/target-config-store.ts src/adapters/filesystem/target-config-store.ts test/adapters/target-config-store.test.ts test/domain/workspace.test.ts
git commit -m "feat: add Local Target config store with local override and conflict guard"
```

---

### Task 5: LocalTargetService — resolution, fingerprint, workspace identity

**Files:**
- Create: `src/application/target/target-resolver.ts`
- Create: `src/application/target/local-target-service.ts`
- Test: `test/application/target/target-resolver.test.ts`
- Test: `test/application/target/local-target-service.test.ts`

**Interfaces:**
- Consumes: `TargetConfigStorePort`, `TargetPathResolverPort`, `ProcessRunner` (`src/ports/process-runner.ts`), `tapHoundPath`, workspace constants, clock.
- Produces:

```ts
export interface TargetResolverDependencies {
  configStore: TargetConfigStorePort;
  pathResolver: TargetPathResolverPort;
  processRunner: ProcessRunner;
  clock: { now(): Date };
}

export interface TargetResolverDeps {
  targetsHome: string;   // absolute
  resolve: (id: string) => Promise<ResolvedTarget>;
  resolveByPath: (input: string) => Promise<ResolvedTarget>;
  fingerprint: (project: AndroidProjectIdentity, packageName?: string) => Promise<ProjectFingerprint>;
}
```

`LocalTargetService` additionally produces:

```ts
export interface LocalTargetIdentityStore {
  readIdentity: (targetId: string) => Promise<LocalTargetIdentity | null>;
  writeIdentity: (identity: LocalTargetIdentity) => Promise<void>;
  ensureWorkspace: (targetId: string) => Promise<void>;
}

export interface LocalTargetServiceDependencies {
  identityStore: LocalTargetIdentityStore;
  fingerprint: (
    project: ResolvedTarget["project"],
    packageName?: string
  ) => Promise<Pick<ProjectFingerprint, "hash">>;
}
```

- [ ] **Step 1: Write failing tests** — resolver tests:

```ts
import type { ProcessRunner } from "../../src/ports/process-runner.js";
import { TargetResolver } from "../../src/application/target/target-resolver.js";

function fakeRunner(results: Record<string, string>): ProcessRunner {
  return {
    run: async (command) => {
      const key = command.join(" ");
      const output = results[key] ?? "";
      return { stdout: output, stderr: "", exitCode: 0 };
    }
  } as unknown as ProcessRunner;
}

describe("TargetResolver", () => {
  it("resolves a registered id through the config store", async () => {
    const resolver = new TargetResolver({
      targetsHome: "/repo/benchmarks",
      configStore: { loadTargets: async () => ({ targets: { app: { id: "app", source: { type: "local", path: "/real/app" }, run: { packageName: "com.example.app" }, override: false } }, official: undefined, local: undefined }) } as never,
      pathResolver: { resolve: async () => ({ configuredPath: "/real/app", resolvedPath: "/real/app" }) },
      processRunner: fakeRunner({ "git -C /real/app rev-parse --show-toplevel": "/real/app\n" }),
      clock: { now: () => new Date("2026-09-10T00:00:00.000Z") }
    });
    const target = await resolver.resolve("app");
    expect(target.id).toBe("app");
    expect(target.resolvedPath).toBe("/real/app");
    expect(target.workspaceRoot).toBe("/repo/benchmarks/.taphound/local/app");
  });

  it("throws LOCAL_TARGET_NOT_FOUND for an unknown id", async () => {
    const resolver = new TargetResolver({
      targetsHome: "/repo/benchmarks",
      configStore: { loadTargets: async () => ({ targets: {}, official: undefined, local: undefined }) } as never,
      pathResolver: { resolve: async () => ({ configuredPath: "", resolvedPath: "" }) },
      processRunner: fakeRunner({}),
      clock: { now: () => new Date() }
    });
    await expect(resolver.resolve("nope")).rejects.toMatchObject({ code: "LOCAL_TARGET_NOT_FOUND" });
  });

  it("builds a stable fingerprint from git remote, project name, and package", async () => {
    const resolver = new TargetResolver({
      targetsHome: "/repo/benchmarks",
      configStore: { loadTargets: async () => ({ targets: { app: { id: "app", source: { type: "local", path: "/real/app" }, run: { packageName: "com.example.app" }, override: false } }, official: undefined, local: undefined }) } as never,
      pathResolver: { resolve: async () => ({ configuredPath: "/real/app", resolvedPath: "/real/app" }) },
      processRunner: fakeRunner({
        "git -C /real/app rev-parse --show-toplevel": "/real/app\n",
        "git -C /real/app config --get remote.origin.url": "git@github.com:acme/mail.git\n",
        "git -C /real/app rev-parse HEAD": "abc123\n"
      }),
      clock: { now: () => new Date() }
    });
    const target = await resolver.resolve("app");
    const fingerprint = await resolver.fingerprint(target.project, "com.example.app");
    expect(fingerprint.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint.gitRemote).toBe("git@github.com:acme/mail.git");
  });
});
```

`local-target-service.test.ts`:

```ts
import { LocalTargetService } from "../../src/application/target/local-target-service.js";

describe("LocalTargetService", () => {
  it("builds a TapHoundConfig from a target entry with defaults", async () => {
    const service = new LocalTargetService({
      identityStore: {
        readIdentity: async () => null,
        writeIdentity: async () => undefined,
        ensureWorkspace: async () => undefined
      },
      fingerprint: async () => ({ hash: "a".repeat(64) })
    });
    const config = service.configForTarget({
      entry: { run: { packageName: "com.example.app" } } as never,
      resolvedPath: "/real/app",
      workspaceRoot: "/ws"
    });
    expect(config.run.packageName).toBe("com.example.app");
    expect(config.run.activity).toBe(".MainActivity");
    expect(config.artifactsDir).toBe("/ws/runs");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/application/target/target-resolver.test.ts test/application/target/local-target-service.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`src/application/target/target-resolver.ts` (complete; verify `ProcessRunner.run` signature in `src/ports/process-runner.ts` and adapt the command shape — note the fake above uses `command.join(" ");` so the adapter should call `run(["git","-C",root,...])`):

```ts
import { createHash } from "node:crypto";

import {
  AndroidProjectIdentitySchema,
  ProjectFingerprintSchema,
  TargetError,
  type AndroidProjectIdentity,
  type ProjectFingerprint,
  type ResolvedTarget
} from "../../domain/target.js";
import type {
  LoadedTargets,
  TargetConfigStorePort
} from "../../ports/target-config-store.js";
import type { ResolvedPath, TargetPathResolverPort } from "../../ports/path-resolver.js";
import type { ProcessRunner } from "../../ports/process-runner.js";
import { localTargetWorkspaceRoot } from "../../domain/workspace.js";

export interface TargetResolverDependencies {
  targetsHome: string;
  configStore: TargetConfigStorePort;
  pathResolver: TargetPathResolverPort;
  processRunner: ProcessRunner;
  clock: { now: () => Date };
}

async function gitValue(runner: ProcessRunner, root: string, args: readonly string[]): Promise<string | undefined> {
  const result = await runner.run(["git", "-C", root, ...args]);
  if (result.exitCode !== 0) {
    return undefined;
  }
  const value = result.stdout.trim();
  return value.length === 0 ? undefined : value;
}

export class TargetResolver {
  public constructor(
    private readonly dependencies: TargetResolverDependencies
  ) {}

  public readonly resolve = async (id: string): Promise<ResolvedTarget> => {
    const loaded = await this.dependencies.configStore.loadTargets(
      this.dependencies.targetsHome
    );
    const entry = loaded.targets[id];
    if (entry === undefined) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_FOUND",
        `Local target "${id}" is not registered. Add it with: taphound local add ${id} --path <path>`
      );
    }
    return this.resolvePath(id, entry.source.path, entry.run.packageName);
  };

  public readonly resolveByPath = async (input: string): Promise<ResolvedTarget> => {
    const id = `path-${createHash("sha256").update(input).digest("hex").slice(0, 12)}`;
    return this.resolvePath(id, input, undefined);
  };

  private readonly resolvePath = async (
    id: string,
    configuredPath: string,
    packageName: string | undefined
  ): Promise<ResolvedTarget> => {
    const resolved: ResolvedPath = await this.dependencies.pathResolver.resolve(
      configuredPath,
      this.dependencies.targetsHome
    );
    const project = await this.detectAndroidProject(resolved.resolvedPath);
    return ResolvedTargetSchema.parse({
      id,
      sourceType: "local",
      configuredPath: resolved.configuredPath,
      resolvedPath: resolved.resolvedPath,
      project,
      workspaceRoot: localTargetWorkspaceRoot(this.dependencies.targetsHome, id)
    });
  };

  private readonly detectAndroidProject = async (
    root: string
  ): Promise<AndroidProjectIdentity> => {
    const runner = this.dependencies.processRunner;
    const gitRoot = await gitValue(runner, root, ["rev-parse", "--show-toplevel"]);
    const settingsFile = await this.firstExisting(root, [
      "settings.gradle.kts",
      "settings.gradle"
    ]);
    if (settingsFile === undefined) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_ANDROID_PROJECT",
        `No settings.gradle(.kts) found at ${root}`
      );
    }
    const hasWrapper = await this.hasPath(root, [
      "gradlew",
      "gradle/wrapper/gradle-wrapper.properties"
    ]);
    if (!hasWrapper && !(await this.hasModuleBuildFile(root))) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_ANDROID_PROJECT",
        `No Gradle wrapper or module build file found at ${root}`
      );
    }
    return AndroidProjectIdentitySchema.parse({
      rootDir: root,
      settingsFile,
      ...(hasWrapper === true && (await this.hasPath(root, ["gradle/wrapper/gradle-wrapper.properties"]))
        ? { gradleWrapper: "gradle/wrapper/gradle-wrapper.properties" }
        : {}),
      ...(gitRoot === undefined ? {} : { gitRoot })
    });
  };

  private readonly firstExisting = async (
    root: string,
    candidates: readonly string[]
  ): Promise<string | undefined> => {
    for (const candidate of candidates) {
      try {
        await access(join(root, candidate));
        return candidate;
      } catch {
        continue;
      }
    }
    return undefined;
  };

  private readonly hasPath = async (
    root: string,
    candidates: readonly string[]
  ): Promise<boolean> => (await this.firstExisting(root, candidates)) !== undefined;
```

(Add `access` to the `node:fs/promises` imports; share `hasModuleBuildFile` from Task 3 by moving it into a small shared helper module `src/adapters/filesystem/android-project-detection.ts` used by both the path resolver and the target resolver.)

  public readonly fingerprint = async (
    project: AndroidProjectIdentity,
    packageName: string | undefined
  ): Promise<ProjectFingerprint> => {
    const runner = this.dependencies.processRunner;
    const root = project.rootDir;
    const [remote, head] = await Promise.all([
      gitValue(runner, root, ["config", "--get", "remote.origin.url"]),
      gitValue(runner, root, ["rev-parse", "HEAD"])
    ]);
    const rootProjectName = await this.rootProjectName(root);
    const settingsHash = await this.fileHash(root, project.settingsFile);
    const parts = [
      remote === undefined ? "no-remote" : remote,
      rootProjectName === undefined ? "no-name" : rootProjectName,
      settingsHash === undefined ? "no-settings-hash" : settingsHash,
      head === undefined ? "no-head" : head,
      packageName === undefined ? "no-package" : packageName
    ];
    const hash = createHash("sha256").update(parts.join("\n")).digest("hex");
    return ProjectFingerprintSchema.parse({
      schemaVersion: 1,
      hash,
      ...(remote === undefined ? {} : { gitRemote: remote }),
      ...(rootProjectName === undefined ? {} : { rootProjectName }),
      ...(packageName === undefined ? {} : { packageName })
    });
  };

  private readonly rootProjectName = async (root: string): Promise<string | undefined> => {
    for (const file of ["settings.gradle.kts", "settings.gradle"]) {
      try {
        const content = await readFile(join(root, file), "utf8");
        const match = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(content);
        if (match !== null) {
          return match[1];
        }
      } catch {
        continue;
      }
    }
    return undefined;
  };

  private readonly fileHash = async (root: string, file: string): Promise<string | undefined> => {
    try {
      return createHash("sha256").update(await readFile(file, "utf8")).digest("hex");
    } catch {
      return undefined;
    }
  };
}
```

(Add imports `readFile` from `node:fs/promises` and `join` from `node:path`, and import `ResolvedTargetSchema`. Fix `detectAndroidProject`: settingsFile must be detected by existence, not this approximation — implement: use `access()` on both candidates and pick the first that exists; `gradleWrapper` set when `gradle/wrapper/gradle-wrapper.properties` exists; keep gitRoot optional.)

`src/application/target/local-target-service.ts`:

```ts
import {
  DEFAULT_TARGET_ACTIVITY,
  DEFAULT_TARGET_IDLE,
  TargetError,
  type LocalTargetIdentity,
  type TargetEntry
} from "../../domain/target.js";
import { TapHoundConfigSchema, type TapHoundConfig } from "../../domain/config.js";
import type { ResolvedTarget } from "../../domain/target.js";
import type {
  LocalTargetIdentityStore,
  LocalTargetServiceDependencies
} from "./local-target-service-types.js";

export class LocalTargetService {
  public constructor(
    private readonly dependencies: LocalTargetServiceDependencies
  ) {}

  public readonly configForTarget = (input: {
    entry: TargetEntry;
    resolvedPath: string;
    workspaceRoot: string;
  }): TapHoundConfig => {
    const packageName = input.entry.run.packageName;
    return TapHoundConfigSchema.parse({
      version: 1,
      run: {
        packageName,
        activity: input.entry.run.activity ?? DEFAULT_TARGET_ACTIVITY
      },
      idle: DEFAULT_TARGET_IDLE,
      artifactsDir: `${input.workspaceRoot}/runs`
    });
  };

  public readonly assertProjectUnchanged = async (
    target: ResolvedTarget,
    fingerprintHash: string
  ): Promise<void> => {
    const saved = await this.dependencies.identityStore.readIdentity(target.id);
    if (saved === null) {
      return;
    }
    if (saved.fingerprint.hash !== fingerprintHash) {
      throw new TargetError(
        "LOCAL_TARGET_PROJECT_CHANGED",
        `Target ${target.id} now resolves to a different project (fingerprint ${saved.fingerprint.hash} != ${fingerprintHash}). Re-register or point the path at the original repository.`
      );
    }
  };
}
```

(`LocalTargetIdentityStore` and `LocalTargetServiceDependencies` are declared once in the Interfaces block above; put them in `src/application/target/local-target-service-types.ts` and re-export.)

- [ ] **Step 4: Run tests**

Run: `npm test -- test/application/target/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/target/ test/application/target/
git commit -m "feat: add Local Target resolver, fingerprint, and config synthesis"
```

---

### Task 6: Filesystem identity + workspace store (identity.json, gitignored)

**Files:**
- Create: `src/adapters/filesystem/local-target-workspace.ts`
- Test: `test/adapters/local-target-workspace.test.ts`

**Interfaces:**
- Produces: `FileSystemLocalTargetWorkspace` implementing `{ root, identityPath, readIdentity, writeIdentity, ensureWorkspace }`, wired into `CliDependencies` (Task 8).

- [ ] **Step 1: Write failing tests**

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileSystemLocalTargetWorkspace } from "../../src/adapters/filesystem/local-target-workspace.js";

let home: string;

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("FileSystemLocalTargetWorkspace", () => {
  it("writes and reads identity.json atomically", async () => {
    home = await mkdtemp(join(tmpdir(), "taphound-workspace-"));
    const workspace = new FileSystemLocalTargetWorkspace();
    const identity = {
      schemaVersion: 1,
      targetId: "app",
      sourceType: "local",
      configuredPath: "${X}",
      resolvedPath: "/real/app",
      fingerprint: {
        schemaVersion: 1,
        hash: "a".repeat(64)
      },
      packageName: "com.example.app",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z"
    };
    await workspace.ensureWorkspace(home, "app");
    await workspace.writeIdentity(home, "app", identity);
    const loaded = await workspace.readIdentity(home, "app");
    expect(loaded?.targetId).toBe("app");
    expect(loaded?.fingerprint.hash).toBe("a".repeat(64));
  });

  it("returns null when no identity exists", async () => {
    home = await mkdtemp(join(tmpdir(), "taphound-workspace-"));
    const workspace = new FileSystemLocalTargetWorkspace();
    await expect(workspace.readIdentity(home, "app")).resolves.toBeNull();
  });

  it("creates .taphound/.gitignore with local/ and never overwrites", async () => {
    home = await mkdtemp(join(tmpdir(), "taphound-workspace-"));
    const workspace = new FileSystemLocalTargetWorkspace();
    await workspace.ensureWorkspace(home, "app");
    const gitignore = await readFile(join(home, ".taphound", ".gitignore"), "utf8");
    expect(gitignore).toContain("local/");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/adapters/local-target-workspace.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

import {
  LOCAL_WORKSPACE_DIR,
  LOCAL_WORKSPACE_IGNORE,
  TAPHOUND_DIR
} from "../../domain/workspace.js";
import {
  LocalTargetIdentitySchema,
  type LocalTargetIdentity
} from "../../domain/target.js";
import { isErrnoException } from "../../shared/errors.js";

const IDENTITY_PATH = "identity.json";

export interface LocalTargetWorkspacePort {
  root: (targetsHome: string, targetId: string) => string;
  identityPath: (targetsHome: string, targetId: string) => string;
  readIdentity: (targetsHome: string, targetId: string) => Promise<LocalTargetIdentity | null>;
  writeIdentity: (targetsHome: string, targetId: string, identity: LocalTargetIdentity) => Promise<void>;
  ensureWorkspace: (targetsHome: string, targetId: string) => Promise<void>;
  ensureTaphoundIgnored: (targetsHome: string) => Promise<void>;
}

export class FileSystemLocalTargetWorkspace implements LocalTargetWorkspacePort {
  public readonly root = (targetsHome: string, targetId: string): string =>
    join(targetsHome, LOCAL_WORKSPACE_DIR, targetId);

  public readonly identityPath = (targetsHome: string, targetId: string): string =>
    join(this.root(targetsHome, targetId), IDENTITY_PATH);

  public readonly readIdentity = async (
    targetsHome: string,
    targetId: string
  ): Promise<LocalTargetIdentity | null> => {
    try {
      const raw = JSON.parse(
        await readFile(this.identityPath(targetsHome, targetId), "utf8")
      );
      return LocalTargetIdentitySchema.parse(raw);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };

  public readonly writeIdentity = async (
    targetsHome: string,
    targetId: string,
    identity: LocalTargetIdentity
  ): Promise<void> => {
    await this.ensureWorkspace(targetsHome, targetId);
    const path = this.identityPath(targetsHome, targetId);
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  };

  public readonly ensureWorkspace = async (
    targetsHome: string,
    targetId: string
  ): Promise<void> => {
    await this.ensureTaphoundIgnored(targetsHome);
    await mkdir(join(this.root(targetsHome, targetId), "context"), { recursive: true });
    await mkdir(join(this.root(targetsHome, targetId), "journeys"), { recursive: true });
    await mkdir(join(this.root(targetsHome, targetId), "runs"), { recursive: true });
    await mkdir(join(this.root(targetsHome, targetId), "generations"), { recursive: true });
    await mkdir(join(this.root(targetsHome, targetId), "cache"), { recursive: true });
  };

  public readonly ensureTaphoundIgnored = async (targetsHome: string): Promise<void> => {
    const ignorePath = join(targetsHome, TAPHOUND_DIR, ".gitignore");
    try {
      await writeFile(ignorePath, LOCAL_WORKSPACE_IGNORE, { flag: "wx" });
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/adapters/local-target-workspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/filesystem/local-target-workspace.ts test/adapters/local-target-workspace.test.ts
git commit -m "feat: add local target workspace identity store and gitignore"
```

---

### Task 7: CLI `local` command group (add / list / inspect / remove)

**Files:**
- Create: `src/cli/commands/local.ts`
- Modify: `src/cli/program.ts`
- Modify: `src/cli/dependencies.ts` (wire `targetConfigStore`, `targetPathResolver`, `localTargetWorkspace`, `localTargetService`, `targetResolver`)
- Test: `test/cli/local-command.test.ts`

**Interfaces:**
- Consumes: `CliDependencies` additions; produces the `taphound local` group with `add`, `list`, `inspect`, `remove`.

- [ ] **Step 1: Write failing tests**

```ts
import { createProgram } from "../../src/cli/program.js";
import { createTestDependencies, capture } from "../helpers.js";
```

(Use the existing CLI test helpers from `test/cli/...` — see `test/cli/verify-json.test.ts` for the harness pattern with `runCli`-style helper. The plan's test here asserts: `local add work-app --path /tmp/x --json` emits one JSON value with `id`, `workspaceRoot`, `configuredPath`; `local list --json` emits a `targets` array; `local inspect app --json` shows resolution; `local remove app --json` returns `removed: true`; unknown command exits 2 with `LOCAL_TARGET_NOT_FOUND`.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/cli/local-command.test.ts`
Expected: FAIL — command missing.

- [ ] **Step 3: Implement**

`src/cli/commands/local.ts` (adapt to real `CliDependencies` shape):

```ts
import { Command } from "commander";

import type { CliDependencies } from "../dependencies.js";
import { writeJson, writeLine, failureOutput, errorMessage } from "../output.js";

function targetsHome(dependencies: CliDependencies, explicit: string | undefined): string {
  return resolve(
    dependencies.cwd(),
    explicit ?? process.env.TAPHOUND_TARGETS_HOME ?? "benchmarks"
  );
}

export function createLocalCommand(dependencies: CliDependencies): Command { ... }
```

Command surface:

```text
taphound local add <id> --path <path> [--json]
taphound local list [--json]
taphound local inspect <id> [--json]
taphound local remove <id> [--json]
```

`add` behavior: resolve path (throws `LOCAL_TARGET_*` on failure), probe (gradle root, git repo, modules count, package), `configStore.appendLocalTarget`, `workspace.ensureWorkspace`, write identity with fingerprint, emit `{ id, configuredPath, resolvedPath, workspaceRoot, detected: { gradleRoot, gitRepo, packageName }, config: "benchmarks/targets.local.json" }`. JSON contract: exactly one value.

- [ ] **Step 4: Run tests**

Run: `npm test -- test/cli/local-command.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `.gitignore`** (repo root): append

```text
benchmarks/targets.local.json
benchmarks/apps/local/
benchmarks/cases/local/
benchmarks/.taphound/
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/local.ts src/cli/program.ts src/cli/dependencies.ts test/cli/local-command.test.ts .gitignore
git commit -m "feat: add taphound local add/list/inspect/remove commands"
```

---

### Task 8: `doctor --target`

**Files:**
- Modify: `src/cli/commands/doctor.ts`
- Test: `test/cli/doctor-process.test.ts` (add cases) or new `test/cli/doctor-target.test.ts`

**Interfaces:**
- Consumes: `CliDependencies.localTargetService`, `targetResolver`; produces extended doctor JSON with `target` block when `--target` given.

- [ ] **Step 1: Write failing tests**

`test/cli/doctor-target.test.ts`:

```ts
// Uses the CLI harness from test/cli/doctor-process.test.ts.
// Case A: valid registered target emits one JSON value with target.resolvedPath and checks including path/git.
// Case B: unregistered id exits 2 with failure code LOCAL_TARGET_NOT_FOUND.
// Case C: --target plus --device still selects the device doctor.
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/cli/doctor-target.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `createDoctorCommand`, add `.option("--target <id>", "Registered local target id")` and `.option("--targets <path>", "Targets home", "benchmarks")`. When `--target` present: resolve target (fail with `LOCAL_TARGET_*` and exit code 2 using `failureOutput`), synthesize config via `localTargetService.configForTarget`, prepend target checks to the report:

```ts
interface TargetCheck {
  name: string;
  status: "passed" | "failed";
  message: string;
}
```

Checks: `target-path` (path exists — resolver already validated), `android-project` (settingsFile exists), `git-state` (branch/head/dirty via `git status --porcelain` and `rev-parse --abbrev-ref HEAD`), `package-identity` (project evidence `applicationId` in `**/build.gradle.kts` vs configured; mismatch → `PACKAGE_IDENTITY_MISMATCH` exit 2; unknown → warning status `warn`), `installed` (delegated to existing device doctor `APP_NOT_INSTALLED` path). Progress/diagnostics to stderr; `--json` single value.

- [ ] **Step 4: Run tests**

Run: `npm test -- test/cli/doctor-target.test.ts test/cli/doctor-process.test.ts`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/doctor.ts test/cli/doctor-target.test.ts
git commit -m "feat: support doctor --target for local real app diagnosis"
```

---

### Task 9: Workspace-rooted context (generate / status / validate)

**Files:**
- Modify: `src/application/context/context-generator.ts` (add `contextRoot` to `ContextGenerateInput`; derive `contextPath` and the *context-document* file port calls from `contextRoot`, keep discovery on `projectRoot`)
- Modify: `src/application/context/context-loader.ts` (add optional `workspaceRoot`; resolve context document paths via `tapHoundPath`)
- Modify: `src/cli/commands/context.ts` (add `--target` / `--targets`; when target given: `projectRoot` = resolvedPath, context docs under workspace root)
- Modify: `src/cli/dependencies.ts` (wire `contextGenerator`/`contextLoader` call sites if they build paths from projectRoot)
- Test: `test/application/context/context-generator.test.ts` (add), `test/application/context/context-loader.test.ts` (add), `test/cli/context-target.test.ts`

**Interfaces:**
- Produces: `ContextGenerateInput.contextRoot?: string`; `ContextLoader.load({ projectRoot, workspaceRoot?, contextPath, ... })` where context doc paths resolve against `workspaceRoot ?? projectRoot` but evidence reads stay on `projectRoot`.

- [ ] **Step 1: Write failing tests**

Generator test: run `generate` with `projectRoot=/real/app`, `contextRoot=/ws` → context index written under `/ws/context/...` (via injected `files` fake), discovery still invoked with `projectRoot: "/real/app"` (assert mock call).

Loader test: `load({ projectRoot: "/real/app", workspaceRoot: "/ws", contextPath: "/ws/context/project-context.json" })` → reads index/module shards from `/ws/context/` and module evidence hashes are validated against `/real/app` files (inject `files` fake capturing reads; assert the context shard read path is `/ws/context/...`).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/application/context/context-generator.test.ts test/application/context/context-loader.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `context-generator.ts`:

```ts
export interface ContextGenerateInput {
  projectRoot: string;
  contextRoot?: string | undefined;
  ...
}
```

At the top of `generate`:

```ts
const root = input.contextRoot ?? input.projectRoot;
const contextPath = isAbsolute(input.contextPath)
  ? input.contextPath
  : resolve(root, input.contextPath);
const contextRelativePath = projectRelativePath(root, contextPath, ...);
```

and pass `{ projectRoot: root, relativePath: contextRelativePath }` for the context-document `files.inspectProjectFile` / writer calls, while `discoverModules({ projectRoot: input.projectRoot })` and evidence inspection keep `input.projectRoot`.

In `context-loader.ts`, replace path derivation for context documents with `tapHoundPath(projectRoot, workspaceRoot, relativePath)`; evidence file reads continue to use `projectRoot`. `load` signature gains `workspaceRoot?: string` and it is threaded into the internal `readContextDocument` paths only.

- [ ] **Step 4: Run tests**

Run: `npm test -- test/application/context/ test/cli/context-target.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/context/ src/cli/commands/context.ts src/cli/dependencies.ts test/application/context/ test/cli/context-target.test.ts
git commit -m "feat: root Project Context at the local target workspace"
```

---

### Task 10: `verify --target` (journeys, knowledge, artifacts in workspace)

**Files:**
- Modify: `src/ports/knowledge-registry.ts` + `src/adapters/filesystem/knowledge-registry.ts` (add optional `workspaceRoot` to `load`; route `.taphound` paths via `tapHoundPath`)
- Modify: `src/ports/journey-composition-store.ts` + `src/adapters/filesystem/journey-composition-store.ts` (add optional `workspaceRoot` to `read`/`listJourneyPaths`/`listFlowPaths`/`readJourneyMeta`/`writeText`; route via `tapHoundPath`)
- Modify: `src/adapters/filesystem/artifact-store.ts` (allow `.taphound/local/...` authority in `assertArtifactAuthorityBoundary`: after a `.taphound` segment, `build` **or** `local` is permitted)
- Modify: `src/cli/commands/verify.ts` (add `--target`/`--targets`; resolve target; synthesize config; journeys from workspace `journeys/<name>.json`; skip legacy guard for target mode)
- Modify: `src/cli/dependencies.ts` (`anchorResolverFor` gains workspaceRoot; verifier wiring unchanged)
- Test: `test/cli/verify-json.test.ts` (add target cases), `test/adapters/artifact-store.test.ts` (boundary case), `test/adapters/knowledge-registry.test.ts` (workspaceRoot case)

**Interfaces:**
- Produces: `KnowledgeRegistryPort.load(projectRoot, workspaceRoot?)`; `JourneyCompositionStore` methods accept optional `workspaceRoot` on their input objects.

- [ ] **Step 1: Write failing tests**

Artifact boundary:

```ts
it("allows artifacts under .taphound/local/<id>/", async () => {
  const base = await mkdtemp(...);
  const runs = join(base, ".taphound", "local", "app", "runs");
  const store = new FileSystemArtifactStore();
  const session = await store.begin(runs, "run-1");
  expect(session).toBeDefined();
});
```

Knowledge:

```ts
it("loads knowledge from the workspace root when provided", async () => {
  // write index.json under <ws>/knowledge/ and call registry.load("/real/app", ws)
});
```

Verify CLI (integration via existing harness with fake doctor + fake adb): `verify --target app --journey search-mail` reads journey from `<ws>/journeys/search-mail.json` and runs `verifier.verify` with `artifactsDir: <ws>/runs`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/adapters/artifact-store.test.ts test/adapters/knowledge-registry.test.ts test/cli/verify-json.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. `artifact-store.ts` boundary:

```ts
const workspaceIndex = segments.lastIndexOf(".taphound");
if (
  workspaceIndex >= 0
  && segments[workspaceIndex + 1] !== "build"
  && segments[workspaceIndex + 1] !== "local"
) {
  throw new Error(...);
}
```

Also harden: when `.taphound/local`, require at least `<id>/` depth (segments[workspaceIndex + 2] exists) so arbitrary `.taphound/local/...` cannot escape the target workspace; the canonical realpath already protects, and project-relative containment is enforced by TargetPathResolver — keep the check permissive for `local` only within `benchmarks/.taphound/local` (bail if not under it is acceptable; document decision: authority boundary allows `build` and `local` namespaces).

2. `knowledge-registry.ts`: add `workspaceRoot?: string` to `load` (and `writePromoted` only if simple); internal `ensureSafeDirectory(projectRoot, TAPHOUND_DIR)` becomes:

```ts
const dir = tapHoundPath(projectRoot, workspaceRoot, TAPHOUND_DIR);
```

and every subsequent `join(..., "knowledge", ...)` keeps its relative segment (the helper already stripped `.taphound/`).

3. `journey-composition-store.ts`: each method takes `workspaceRoot?: string` in its input; internal `join(projectRoot, JOURNEYS_DIR)` style calls change to `join(tapHoundPath(projectRoot, workspaceRoot, JOURNEYS_DIR), ...)` — or equivalently route the base: `const base = tapHoundPath(projectRoot, workspaceRoot, TAPHOUND_DIR)` then `join(base, "journeys")`.

4. `verify.ts`:

```ts
.option("--target <id>", "Registered local target id")
.option("--targets <path>", "Targets home", "benchmarks")
```

When `--target`: resolve → synthesize config (override `--package`/`--activity` still apply) → `journey` path = `join(workspaceRoot, "journeys", name)` where name keeps or drops `.json` (`name.endsWith(".json") ? name : name + ".json"`); require `--journey` is a bare name (no `/`); error `LOCAL_TARGET_NOT_FOUND` etc. with exit 2. `projectRoot` passed to `verifier.verify` = `resolvedPath` (device + source semantics); `artifactsDir` absolute → accepted by the store; skip `assertNoLegacyWorkspace` and keep `assertArtifactDirectory` (passes for absolute paths).

- [ ] **Step 4: Run tests**

Run: `npm test -- test/adapters/ test/cli/verify-json.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ports/knowledge-registry.ts src/adapters/filesystem/knowledge-registry.ts src/ports/journey-composition-store.ts src/adapters/filesystem/journey-composition-store.ts src/adapters/filesystem/artifact-store.ts src/cli/commands/verify.ts src/cli/dependencies.ts test/adapters/ test/cli/verify-json.test.ts
git commit -m "feat: verify --target runs Journeys from the local target workspace"
```

---

### Task 11: `verify-changes --target` + WORKTREE head + impact workspace root

**Files:**
- Modify: `src/application/impact/impact-resolver.ts` (resolve(input: { projectRoot, workspaceRoot?, changeSet }); deps get workspaceRoot)
- Modify: `src/ports/git-diff.ts` + adapter (`src/adapters/.../git-diff-*.ts`) — support `head: "WORKTREE"` meaning working-tree diff vs base (staged + unstaged), adding repo-root-relative paths; `GIT_REF_INVALID` when a ref does not exist
- Modify: `src/cli/commands/verify-changes.ts` (add `--target`/`--targets`; git root from resolved target; journeys/context/knowledge from workspace)
- Modify: `src/cli/dependencies.ts` (`impact` deps wiring gains workspaceRoot)
- Test: `test/application/impact/impact-resolver.test.ts` (workspaceRoot case), `test/adapters/git-diff.test.ts` (WORKTREE case), `test/cli/verify-changes.test.ts` (target case)

**Interfaces:**
- Produces: `ImpactResolver.resolve({ projectRoot, workspaceRoot?, changeSet })`; `GitDiffPort.diff` accepts `head: "HEAD" | "WORKTREE" | string`.

- [ ] **Step 1: Write failing tests**

```ts
it("diff(base, WORKTREE) includes staged and unstaged changes", ...);
it("diff reports GIT_ROOT_NOT_FOUND when projectRoot has no .git", ...);
it("diff reports GIT_REF_INVALID for an unknown base ref", ...);
it("verify-changes --target resolves gitRoot and journeys from the workspace", ...);
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/application/impact/impact-resolver.test.ts test/adapters/git-diff.test.ts test/cli/verify-changes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `impact-resolver.ts`: change `resolve(projectRoot, changeSet)` → `resolve(input: { projectRoot: string; workspaceRoot?: string; changeSet: ChangeSet })`; deps `loadContext(input: { projectRoot, workspaceRoot?, ... })`, `loadKnowledge(projectRoot, workspaceRoot?)`, `listJourneyPaths(projectRoot, workspaceRoot?)`; thread workspaceRoot through.
- Git diff adapter: `head === "WORKTREE"` → run `git -C root diff --name-status --find-renames <base>` and `git -C root diff --cached --name-status --find-renames <base>`-equivalent accumulated into a unified ChangeSet with `sha` omitted; validate refs first with `git rev-parse --verify <ref>` → `GIT_REF_INVALID`; no `.git` → `GIT_ROOT_NOT_FOUND`.
- `verify-changes.ts`: `--target` path: `gitDiff.diff({ projectRoot: target.project.gitRoot ?? resolvedPath, base, head })`; impact with `{ projectRoot: resolvedPath, workspaceRoot, changeSet }`; journeys listed/read from workspace (`tapHoundPath`-rooted store calls with `workspaceRoot`); synthesized config; skip legacy guard; keep one-JSON contract (payload gains `target: { id, resolvedPath }` when targeted).

- [ ] **Step 4: Run tests**

Run: `npm test -- test/application/impact/ test/adapters/git-diff.test.ts test/cli/verify-changes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/impact/ src/ports/git-diff.ts src/adapters/ src/cli/commands/verify-changes.ts src/cli/dependencies.ts test/
git commit -m "feat: verify-changes --target with WORKTREE diff and workspace-rooted impact"
```

---

### Task 12: Docs, example files, and real-project acceptance smoke

**Files:**
- Create: `docs/local-target.md` (workflow: register, doctor, context, verify, verify-changes; env var mapping; symlink example; privacy rules; JSON config example with the JSON-file deviation note; error code table with remediation)
- Modify: `README.md` + `README.zh-CN.md` (Feature list + FAQ/CLI section for `local` and `--target`)
- Create: `benchmarks/targets.example.json` (committed; template with `${TAPHOUND_WORK_APP}` placeholders)
- Modify: `.gitignore` if not already covered in Task 7
- Acceptance script: `scripts/acceptance-local-target.mjs` OR documented manual checklist in `docs/local-target.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Write `docs/local-target.md`** — include the complete Section 44 flow verbatim (adapted to JSON config), the symlink setup from Section 51, path-privacy rules, and the P0/P1/P2 scope note with `generation --target` deferred.
- [ ] **Step 2: Update READMEs** — add `local` command group and `--target` flags under CLI summary; note "Local Target validation is dogfooding, never publishable".
- [ ] **Step 3: Add example config** `benchmarks/targets.example.json`:

```json
{
  "version": 1,
  "targets": {
    "work-app": {
      "source": { "type": "local", "path": "${TAPHOUND_WORK_APP}" },
      "run": { "packageName": "com.example.app" },
      "git": { "enabled": true }
    }
  }
}
```

- [ ] **Step 4: Manual acceptance against a real project**

```bash
npm run dev:setup
export TAPHOUND_WORK_APP=/Users/<you>/Projects/<RealApp>
node dist/cli/main.js local add work-app --path '${TAPHOUND_WORK_APP}'
node dist/cli/main.js doctor --target work-app
node dist/cli/main.js context generate --target work-app
node dist/cli/main.js context status --target work-app
node dist/cli/main.js verify --target work-app --journey <name>
node dist/cli/main.js verify-changes --target work-app --base origin/main --head WORKTREE
```

Confirm: the real app repo gained no TapHound files (only developer changes), reports live under `benchmarks/.taphound/local/work-app/runs/`, and `.gitignore` keeps `benchmarks/.taphound/` out of commits.

- [ ] **Step 5: Full quality gate**

```bash
npm test && npm run typecheck && npm run lint && npm run build && npm run brand:render && git diff --exit-code -- assets/brand/png
```

- [ ] **Step 6: Commit**

```bash
git add docs/local-target.md README.md README.zh-CN.md benchmarks/targets.example.json
git commit -m "docs: document Local Target real-app validation workflow"
```

---

## Deferred (recorded next steps; NOT in this plan's gate)

- `generation --target` (P1): generation sessions must bind target id + fingerprint; session store already under `.taphound/build/generations` — for targets, route through workspace `generations/` with fingerprint binding.
- Local Journey lifecycle states (DRAFT/VERIFIED/SUSPECT/STALE/RETIRED) and `journey` command target awareness.
- `local link` convenience (P2) and YAML config format (needs a YAML dependency decision; JSON chosen to keep zode-strict zero-dependency parsing).

## Self-Review Summary (against design doc sections)

- §4-8 target model + Android project root detection → Task 1, Task 3.
- §6 env expansion, missing env → Task 3 (`LOCAL_TARGET_ENV_MISSING`).
- §7 symlink transparency → Task 3 (realpath) + Task 5 (workspaceRoot, targetId for reports).
- §9/10 config split + merge precedence + `TARGET_ID_CONFLICT` → Task 4.
- §13 package identity validation (`MATCH/MISMATCH/UNKNOWN`) → Task 8 check + `PACKAGE_IDENTITY_MISMATCH`.
- §14/15 local workspace → Task 6 (`.taphound/local/<id>/`; gitignored).
- §16 project fingerprint + `LOCAL_TARGET_PROJECT_CHANGED` → Task 5/6 (identity.json compare).
- §17/18 Git metadata + dirty worktree + WORKTREE head → Task 11.
- §19/29 journey storage + `verify --target` → Task 10.
- §25/27/29 `local add/list/inspect` + `verify --target` → Task 7, 10.
- §28 `doctor --target` → Task 8.
- §30 `verify-changes --target` → Task 11.
- §40 near-universal "ResolvedProjectRoot" cleanup → the `workspaceRoot`/`contextRoot` split (Tasks 9-11); full inspector cleanup beyond context/knowledge/journey stores is documented follow-up.
- §41 project-relative safety → retained; `projectRelativePath` still enforces containment (contextRoot path is relative to the workspace root, evidence still rooted at the real project).
- §42/43 resolver + integration tests → Task 3/5/6.
- §44 acceptance flow → Task 12.
- §45 P0 scope → Tasks 1-10. §46 P1 partial (`verify-changes --target`, fingerprint, git metadata, WORKTREE) → Task 11 + 5; `generation --target` deferred. §47 P2 partial (`add/list/inspect/remove`) → Task 7; `link` deferred.