import { mkdtemp, mkdir, realpath, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TargetPathResolver } from "../../src/adapters/filesystem/target-path-resolver.js";

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
      resolvedPath: await realpath(project)
    });
    await expect(resolver.resolve("$TAPHOUND_WORK_APP", "/")).resolves.toMatchObject({
      resolvedPath: await realpath(project)
    });
  });

  it("expands multiple environment variables in one path", async () => {
    const project = await androidProject();
    const resolver = new TargetPathResolver({
      env: {
        TAPHOUND_ROOT: dirname(project),
        TAPHOUND_APP: basename(project)
      }
    });
    await expect(
      resolver.resolve("${TAPHOUND_ROOT}/${TAPHOUND_APP}", "/")
    ).resolves.toMatchObject({ resolvedPath: await realpath(project) });
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
    const resolved = await resolver.resolve(basename(project), join(project, ".."));
    expect(resolved.resolvedPath.replace(/\/$/, "")).toBe(await realpath(project));
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

  it("fails with LOCAL_TARGET_SYMLINK_BROKEN for a missing path", async () => {
    const resolver = new TargetPathResolver({ env: {} });
    await expect(resolver.resolve("/no/such/dir", "/")).rejects.toMatchObject({
      code: "LOCAL_TARGET_SYMLINK_BROKEN"
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
      resolvedPath: await realpath(project)
    });
  });
});