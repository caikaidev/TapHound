import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const helper = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  "assets",
  "skills",
  "taphound-bug-fix",
  "scripts",
  "bug-fix.mjs"
);
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map(
    (path) => rm(path, { recursive: true, force: true })
  ));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "taphound-bug-fix-"));
  created.push(path);
  return path;
}

function run(
  args: string[],
  env: Record<string, string> = {}
): { code: number; output: Record<string, unknown> } {
  const base = { ...process.env };
  delete base.TAPHOUND_BUG_READER_SKILL;
  const result = spawnSync(process.execPath, [helper, ...args], {
    encoding: "utf8",
    env: { ...base, ...env }
  });
  return {
    code: result.status ?? -1,
    output: JSON.parse(result.stdout) as Record<string, unknown>
  };
}

const PREFIX = "10-09 12:00:00.123  4321  4321 E AndroidRuntime: ";

function javaCrash(line: number, rootType = "java.lang.NullPointerException"): string {
  return [
    "FATAL EXCEPTION: main",
    "Process: com.demo.app, PID: 4321",
    "java.lang.RuntimeException: Unable to start activity ComponentInfo{com.demo.app/com.demo.app.MailDetailActivity}",
    "\tat android.app.ActivityThread.performLaunchActivity(ActivityThread.java:3449)",
    `Caused by: ${rootType}: subject was null`,
    "\tat kotlin.text.StringsKt.trim(Strings.kt:10)",
    `\tat com.demo.app.mail.MailDetailViewModel.bindSubject(MailDetailViewModel.kt:${String(line)})`,
    "\tat com.demo.app.mail.MailDetailActivity.onCreate(MailDetailActivity.kt:41)",
    "\t... 12 more"
  ].map((text) => `${PREFIX}${text}`).join("\n");
}

describe("taphound-bug-fix helper", () => {
  it("resolves the reader Skill from env, then user config, then the placeholder", async () => {
    const config = await directory();
    const env = { TAPHOUND_USER_CONFIG_DIR: config };

    expect(run(["reader", "get"], env)).toMatchObject({
      code: 0,
      output: { readerSkill: "bug-tracker-reader", source: "default" }
    });
    expect(run(["reader", "set", "acme:jira-reader"], env)).toMatchObject({
      code: 0,
      output: { status: "saved", readerSkill: "acme:jira-reader" }
    });
    expect(JSON.parse(await readFile(join(config, "bug-fix.json"), "utf8")))
      .toEqual({ version: 1, readerSkill: "acme:jira-reader" });
    expect(run(["reader", "get"], env)).toMatchObject({
      output: { readerSkill: "acme:jira-reader", source: "userConfig" }
    });
    expect(run(["reader", "get"], {
      ...env,
      TAPHOUND_BUG_READER_SKILL: "team-tracker"
    })).toMatchObject({
      output: { readerSkill: "team-tracker", source: "env" }
    });
    expect(run(["reader", "reset"], env)).toMatchObject({
      code: 0,
      output: { status: "reset", readerSkill: "bug-tracker-reader", source: "default" }
    });
  });

  it("rejects reader names that are not Skill names", async () => {
    const env = { TAPHOUND_USER_CONFIG_DIR: await directory() };
    for (const name of ["Jira Reader", "../evil", "a:b:c"]) {
      expect(run(["reader", "set", name], env)).toMatchObject({
        code: 2,
        output: { status: "error", code: "READER_INVALID" }
      });
    }
  });

  it("normalizes a logcat Java crash to its root cause and first app frame", async () => {
    const dir = await directory();
    await writeFile(join(dir, "crash.txt"), javaCrash(88));

    const result = run(["crash", "parse", join(dir, "crash.txt")]);

    expect(result).toMatchObject({
      code: 0,
      output: {
        status: "parsed",
        crash: {
          kind: "java",
          thread: "main",
          packageName: "com.demo.app",
          rootCause: "java.lang.NullPointerException",
          topAppFrame: "com.demo.app.mail.MailDetailViewModel.bindSubject",
          topAppFrameLocation: "MailDetailViewModel.kt:88",
          signature: "java:java.lang.NullPointerException@com.demo.app.mail.MailDetailViewModel.bindSubject"
        }
      }
    });
  });

  it("parses a bare stack trace, an ANR, and a native signal", async () => {
    const dir = await directory();
    await writeFile(join(dir, "bare.txt"), [
      "java.lang.IllegalStateException: Fragment not attached",
      "    at com.demo.app.ui.InboxFragment.render(InboxFragment.kt:12)"
    ].join("\n"));
    await writeFile(join(dir, "anr.txt"), [
      "E ActivityManager: ANR in com.demo.app (com.demo.app/.MainActivity)",
      "E ActivityManager: Reason: Input dispatching timed out"
    ].join("\n"));
    await writeFile(join(dir, "native.txt"), [
      "F DEBUG   : pid: 4321, tid: 4321, name: demo  >>> com.demo.app <<<",
      "F DEBUG   : signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0",
      "F DEBUG   :       #00 pc 0000000000012345  /data/app/lib/arm64/libdemo.so (decode+20)"
    ].join("\n"));

    expect(run(["crash", "parse", join(dir, "bare.txt"), "--package", "com.demo.app"]).output)
      .toMatchObject({
        crash: {
          kind: "java",
          rootCause: "java.lang.IllegalStateException",
          topAppFrame: "com.demo.app.ui.InboxFragment.render"
        }
      });
    expect(run(["crash", "parse", join(dir, "anr.txt")]).output).toMatchObject({
      crash: {
        kind: "anr",
        processName: "com.demo.app",
        reason: "Input dispatching timed out",
        rootCause: "ANR"
      }
    });
    expect(run(["crash", "parse", join(dir, "native.txt")]).output).toMatchObject({
      crash: {
        kind: "native",
        signal: "SIGSEGV",
        rootCause: "SIGSEGV",
        topAppFrame: "/data/app/lib/arm64/libdemo.so.decode"
      }
    });
  });

  it("matches crashes by kind, root cause, and first app frame, not line numbers", async () => {
    const dir = await directory();
    await writeFile(join(dir, "reported.txt"), javaCrash(88));
    await writeFile(join(dir, "observed.txt"), javaCrash(91));
    await writeFile(join(dir, "other.txt"), javaCrash(88, "java.lang.IllegalStateException"));

    expect(run([
      "crash", "match", join(dir, "reported.txt"), join(dir, "observed.txt")
    ])).toMatchObject({
      code: 0,
      output: { status: "matched", differences: [] }
    });
    expect(run([
      "crash", "match", join(dir, "reported.txt"), join(dir, "other.txt")
    ])).toMatchObject({
      code: 1,
      output: { status: "mismatched", differences: ["rootCause"] }
    });
  });

  it("reports input without a crash and bad usage as exit 2", async () => {
    const dir = await directory();
    await writeFile(join(dir, "empty.txt"), "I ActivityManager: Start proc com.demo.app\n");

    expect(run(["crash", "parse", join(dir, "empty.txt")])).toMatchObject({
      code: 2,
      output: { status: "error", code: "CRASH_NOT_FOUND" }
    });
    expect(run(["crash", "explode"])).toMatchObject({
      code: 2,
      output: { code: "USAGE" }
    });
    expect(run(["nope"])).toMatchObject({ code: 2, output: { code: "USAGE" } });
  });
});
