import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL(
  "../../assets/skills/taphound-flash/scripts/flash.mjs",
  import.meta.url
));
const fakeAdb = fileURLToPath(new URL("../fixtures/bin/fake-adb.mjs", import.meta.url));
const example = fileURLToPath(new URL(
  "../../assets/skills/taphound-flash/templates/flash-plan.example.json",
  import.meta.url
));

interface DeviceState {
  online: boolean;
  installed: boolean;
  awake: boolean;
  keyguard: boolean;
  secureLock: boolean;
  running: boolean;
  crashed: boolean;
  crashOnTap?: string;
  dumpFailures?: number;
  launchFrames?: number;
  screen: string;
  focused: boolean;
  typed: string;
  taps: [number, number][];
  log: string[];
}

interface FlashRun {
  code: number;
  result: {
    status: string;
    failure?: {
      code: string;
      message: string;
      stepIndex?: number | null;
      matches?: { id: string; text: string; className: string; bounds: string }[];
    };
    steps?: { status: string; detail?: string }[];
    evidence?: Record<string, string>;
  };
  device: DeviceState;
}

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function flash(
  plan: unknown,
  device: Partial<DeviceState> = {}
): Promise<FlashRun> {
  const dir = await mkdtemp(join(tmpdir(), "taphound-flash-test-"));
  scratch.push(dir);
  await chmod(fakeAdb, 0o755);
  const statePath = join(dir, "device.json");
  await writeFile(statePath, JSON.stringify({
    online: true, installed: true, awake: true, keyguard: false, secureLock: false,
    running: false, crashed: false, screen: "main", focused: false, typed: "",
    taps: [], log: [], ...device
  }));
  const planPath = join(dir, "plan.json");
  await writeFile(planPath, typeof plan === "string" ? plan : JSON.stringify(plan));
  const { code, stdout } = await new Promise<{ code: number; stdout: string }>((done) => {
    execFile(process.execPath, [script, "run", planPath, "--out", join(dir, "out")], {
      env: { ...process.env, ADB: fakeAdb, FAKE_ADB_STATE: statePath }
    }, (error, output) => {
      done({ code: error === null ? 0 : Number(error.code), stdout: output });
    });
  });
  return {
    code,
    result: JSON.parse(stdout) as FlashRun["result"],
    device: JSON.parse(await readFile(statePath, "utf8")) as DeviceState
  };
}

function plan(steps: unknown[]): Record<string, unknown> {
  return {
    version: 1,
    packageName: "dev.taphound.demo",
    activity: ".MainActivity",
    timeoutMs: 800,
    settleTimeoutMs: 800,
    steps
  };
}

describe("taphound-flash", () => {
  it("passes the shipped example plan and saves a final screenshot", async () => {
    const run = await flash(await readFile(example, "utf8"));

    expect(run.code).toBe(0);
    expect(run.result.status).toBe("passed");
    expect(run.result.steps?.every((step) => step.status === "passed")).toBe(true);
    expect(run.device.typed).toBe("hello world");
    const screenshot = run.result.evidence?.screenshot;
    expect(screenshot).toBeDefined();
    await expect(stat(screenshot ?? "")).resolves.toBeTruthy();
  }, 60_000);

  it("taps a label at its own point, reaching its clickable row", async () => {
    const run = await flash(plan([
      { action: "tap", target: { text: "Settings" } },
      { action: "expect", target: { id: "settings_title" } }
    ]));

    expect(run.result.status).toBe("passed");
    // The label center, not the row center that the favorite toggle covers.
    expect(run.device.taps).toEqual([[190, 1100]]);
  }, 60_000);

  it("reuses the settled UI dump for the next target lookup", async () => {
    const run = await flash(plan([{ action: "tap", target: { id: "open_search" } }]));

    const launched = run.device.log.findIndex((entry) => entry.includes("am start"));
    const tapped = run.device.log.findIndex((entry) => entry.includes("input tap"));
    const dumps = run.device.log.slice(launched, tapped)
      .filter((entry) => entry.includes("uiautomator dump"));
    // Two identical dumps settle the launched app; the tap looks up its
    // target in the second one instead of dumping again.
    expect(dumps).toHaveLength(2);
  }, 60_000);

  it("fails with evidence when a target never appears", async () => {
    const run = await flash(plan([{ action: "tap", target: { id: "missing" } }]));

    expect(run.code).toBe(1);
    expect(run.result.failure).toMatchObject({ code: "TARGET_NOT_FOUND", stepIndex: 0 });
    expect(run.result.evidence).toHaveProperty("screenshot");
    expect(run.result.evidence).toHaveProperty("hierarchy");
  }, 60_000);

  it("refuses an ambiguous target instead of picking one", async () => {
    const run = await flash(plan([{ action: "tap", target: { text: "Twin" } }]));

    expect(run.result.failure?.code).toBe("TARGET_AMBIGUOUS");
    expect(run.result.failure?.message).toContain("[100,1400][500,1500]");
    expect(run.result.failure?.matches?.map((match) => match.bounds))
      .toEqual(["[100,1400][500,1500]", "[600,1400][980,1500]"]);
    expect(run.device.taps).toEqual([]);
  }, 60_000);

  it("lists every match when an expectation is ambiguous", async () => {
    const run = await flash(plan([{ action: "expect", target: { text: "Twin" } }]));

    expect(run.result.failure?.code).toBe("TARGET_AMBIGUOUS");
    expect(run.result.failure?.matches).toHaveLength(2);
  }, 60_000);

  it("retries a UI dump that fails while the app cold-starts", async () => {
    const run = await flash(plan([{ action: "tap", target: { id: "open_search" } }]), {
      dumpFailures: 3
    });

    expect(run.result.status).toBe("passed");
    expect(run.device.log.filter((entry) => entry.includes("uiautomator dump")).length)
      .toBeGreaterThan(3);
  }, 60_000);

  it("reports UI_DUMP_FAILED once dumps keep failing past the timeout", async () => {
    const run = await flash({ ...plan([{ action: "back" }]), launchTimeoutMs: 1_500 }, { dumpFailures: 1_000 });

    expect(run.code).toBe(1);
    expect(run.result.failure).toMatchObject({ code: "UI_DUMP_FAILED", stepIndex: null });
    expect(run.result.failure?.message).toContain("null root node");
  }, 60_000);

  it("gives the first screen launchTimeoutMs to stop changing", async () => {
    const loading = { launchFrames: 8 };
    const passed = await flash(plan([{ action: "expect", target: { id: "open_search" } }]), loading);
    const unsettled = await flash({
      ...plan([{ action: "expect", target: { id: "open_search" } }]),
      launchTimeoutMs: 800
    }, loading);

    expect(passed.result.status).toBe("passed");
    expect(unsettled.result.failure).toMatchObject({ code: "UNSETTLED", stepIndex: null });
    expect(unsettled.result.failure?.message).toContain("launchTimeoutMs");
  }, 60_000);

  it("reports a crash with the crash log", async () => {
    const run = await flash(plan([{ action: "tap", target: { id: "open_search" } }]), {
      crashOnTap: "open_search"
    });

    expect(run.result.failure?.code).toBe("APP_CRASHED");
    expect(await readFile(run.result.evidence?.crashLog ?? "", "utf8"))
      .toContain("FATAL EXCEPTION");
  }, 60_000);

  it("wakes the screen and dismisses a non-secure keyguard", async () => {
    const run = await flash(plan([{ action: "expect", target: { id: "open_search" } }]), {
      awake: false,
      keyguard: true
    });

    expect(run.result.status).toBe("passed");
    expect(run.device.log).toContain("shell input keyevent 224");
  }, 60_000);

  it("stops with an environment error on a secure lock screen", async () => {
    const run = await flash(plan([{ action: "back" }]), {
      awake: false,
      keyguard: true,
      secureLock: true
    });

    expect(run.code).toBe(3);
    expect(run.result.failure?.code).toBe("DEVICE_LOCKED");
  }, 60_000);

  it.each([
    ["an unknown field", plan([{ action: "tap", target: { id: "a" }, x: 1 }])],
    ["two target keys", plan([{ action: "tap", target: { id: "a", text: "b" } }])],
    ["non-ASCII text", plan([{ action: "type", text: "你好" }])],
    ["no steps", plan([])]
  ])("rejects a plan with %s before touching the device", async (_name, invalid) => {
    const run = await flash(invalid);

    expect(run.code).toBe(2);
    expect(run.result.failure?.code).toBe("PLAN_INVALID");
    expect(run.device.log).toEqual([]);
  }, 60_000);

  it("needs exactly one online device", async () => {
    const run = await flash(plan([{ action: "back" }]), { online: false });

    expect(run.code).toBe(3);
    expect(run.result.failure?.code).toBe("DEVICE_UNAVAILABLE");
  }, 60_000);
});
