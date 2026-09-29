import { spawnSync } from "node:child_process";
import {
  mkdir, mkdtemp, readdir, readFile, rm, writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(repo, "scripts", "feedback-pack.mjs");
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map(
    (path) => rm(path, { recursive: true, force: true })
  ));
});

async function put(root: string, path: string, value: unknown): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    typeof value === "string" ? value : `${JSON.stringify(value)}\n`
  );
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

async function fixture(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "taphound-feedback-project-"));
  created.push(project);
  const generation = ".taphound/build/generations/gen-1";
  const step = `${generation}/evidence/steps/0-attempt`;
  await put(project, ".taphound/config.json", {
    run: { packageName: "com.acme.shop" }
  });
  await put(project, `${generation}/evidence/snapshots/revision-000002/s1/snapshot.json`, {
    deviceSerial: "R58M123ABC",
    expectedPackageName: "com.acme.shop",
    activity: "com.acme.checkout.PayActivity",
    screenshotPath: `${project}/.taphound/build/shot.png`,
    layout: [{
      id: "n1",
      resourceId: "com.acme.shop:id/btn_pay",
      text: "Pay now",
      contentDescription: "passed",
      enabled: true,
      children: [{ id: "n2", resourceId: "loading", enabled: true, children: [] }]
    }]
  });
  await put(project, `${step}/proposal.json`, {
    action: "click",
    locator: { text: "Pay now" },
    activity: { before: "com.acme.checkout.PayActivity" }
  });
  await put(project, `${step}/result.json`, {
    outcome: {
      status: "passed",
      message: "Locator text \"Pay now\" missed #loading in com.acme.checkout.PayActivity",
      timing: { idleWaitMs: 4800 },
      step: { expect: { type: "logcat", tag: "ShopPay", pattern: "order_created id=" } }
    }
  });
  await put(project, `${step}/screenshot.png`, "png");
  await put(project, `${step}/logcat.txt`, "secret log");
  await put(project, ".taphound/build/generations/.locks/gen-1.lock", "{}");
  await put(project, ".taphound/build/runs/run-1/report.json", {
    status: "passed",
    project: { root: project, packageName: "com.acme.shop" }
  });
  return project;
}

function run(project: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: project,
    encoding: "utf8"
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

describe("feedback-pack script", () => {
  it("packs redacted generation JSON and keeps the mapping outside the archive", async () => {
    const project = await fixture();
    const out = join(project, "out", "feedback.tgz");
    const result = run(project, "--run", "run-1", "--out", out);
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain("Mapping:");

    const extracted = join(project, "extracted");
    await mkdir(extracted);
    expect(spawnSync("tar", ["-xzf", out, "-C", extracted]).status).toBe(0);
    const root = join(extracted, "taphound-feedback");
    expect(await listFiles(root)).toEqual([
      ".taphound/build/generations/gen-1/evidence/snapshots/revision-000002/s1/snapshot.json",
      ".taphound/build/generations/gen-1/evidence/steps/0-attempt/proposal.json",
      ".taphound/build/generations/gen-1/evidence/steps/0-attempt/result.json",
      ".taphound/build/runs/run-1/report.json",
      "README.txt"
    ]);

    const files = await listFiles(root);
    const contents = (await Promise.all(
      files.map((file) => readFile(join(root, file), "utf8"))
    )).join("\n");
    for (const secret of [
      "acme", "R58M123ABC", "Pay now", "PayActivity", "btn_pay", "ShopPay",
      "order_created", project
    ]) {
      expect(contents).not.toContain(secret);
    }

    const snapshot = JSON.parse(await readFile(join(root, files[0] ?? ""), "utf8")) as {
      activity: string;
      deviceSerial: string;
      screenshotPath: string;
      layout: [{ resourceId: string; text: string; contentDescription: string;
        children: [{ resourceId: string }]; }];
    };
    expect(snapshot).toMatchObject({
      activity: "com.example.app.Activity1",
      deviceSerial: "device-1",
      screenshotPath: "<project>/.taphound/build/shot.png"
    });
    expect(snapshot.layout[0].resourceId).toBe("com.example.app:id/r1");
    expect(snapshot.layout[0].text).toMatch(/^T\d+$/);
    expect(snapshot.layout[0].children[0].resourceId).toMatch(/^r\d+$/);

    const stepResult = JSON.parse(await readFile(join(root, files[2] ?? ""), "utf8")) as {
      outcome: { status: string; message: string; timing: { idleWaitMs: number } };
    };
    // A UI text equal to a status keyword does not rewrite the status field.
    expect(stepResult.outcome.status).toBe("passed");
    expect(stepResult.outcome.timing.idleWaitMs).toBe(4800);
    expect(stepResult.outcome.message).toMatch(
      /^Locator text "T\d+" missed #r\d+ in com\.example\.app\.Activity1$/
    );

    const mapping = JSON.parse(
      await readFile(join(project, "out", "feedback.mapping.json"), "utf8")
    ) as { class: Record<string, string> };
    expect(mapping.class["com.example.app.Activity1"])
      .toBe("com.acme.checkout.PayActivity");
  });

  it("writes into the ignored diagnostics directory by default", async () => {
    const project = await fixture();
    expect(run(project, "--generation", "gen-1").code).toBe(0);
    const written = await readdir(join(project, ".taphound", "build", "diagnostics"));
    expect(written.some((name) => /^taphound-feedback-.+\.tgz$/.test(name))).toBe(true);
    expect(written.some((name) => name.endsWith(".mapping.json"))).toBe(true);
  });

  it("fails on an unknown generation and prints help", async () => {
    const project = await fixture();
    const missing = run(project, "--generation", "nope");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("No matching generation bundles found");
    expect(run(project, "--help").stdout).toContain("Usage: node feedback-pack.mjs");
  });
});
