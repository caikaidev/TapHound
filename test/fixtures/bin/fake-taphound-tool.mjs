#!/usr/bin/env node

import { basename, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const executable = basename(process.argv[1] ?? "");
const args = process.argv.slice(2);
const root = process.env.TAPHOUND_FAKE_ROOT;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

if (root === undefined) {
  fail("TAPHOUND_FAKE_ROOT is required");
}

if (executable === "android") {
  if (args[0] === "--version") {
    process.stdout.write("1.0.fixture\n");
    process.exit(0);
  }
  if (args[0] === "layout") {
    process.stdout.write(args.includes("--diff")
      ? "[]\n"
      : `${JSON.stringify([{
          text: "Ready",
          interactions: ["clickable"],
          center: "(50, 50)",
          "resource-id": "ready",
          key: 1
        }])}\n`);
    process.exit(0);
  }
  if (args[0] === "screen" && args[1] === "capture") {
    const output = args.find((argument) => argument.startsWith("--output="))
      ?.slice("--output=".length);
    if (output === undefined) {
      fail("screen capture output is required");
    }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, "fixture image");
    process.exit(0);
  }
  fail(`unsupported fake android command: ${args.join(" ")}`);
}

if (executable === "adb") {
  if (args[0] === "version") {
    process.stdout.write("Android Debug Bridge version 1.0.41\n");
    process.exit(0);
  }
  if (args[0] === "devices") {
    process.stdout.write(process.env.TAPHOUND_FAKE_DEVICE === "none"
      ? "List of devices attached\n\n"
      : "List of devices attached\nemulator-5554\tdevice\n");
    process.exit(0);
  }
  const command = args[0] === "-s" ? args.slice(2) : args;
  if (command[0] === "logcat") {
    process.stdout.write(
      "07-19 10:00:00.000  42  42 I TapHound: process fixture ready\n"
    );
    setInterval(() => {}, 1000);
  } else if (command[0] === "shell" && command[1] === "ps") {
    process.stdout.write(
      "  PID NAME\n"
        + "   42 com.example.app\n"
        + "   77 com.example.app:remote\n"
        + "  100 system_server\n"
    );
  } else if (
    command[0] === "shell"
    && command[1] === "pm"
    && command[2] === "path"
  ) {
    if (process.env.TAPHOUND_FAKE_APP === "absent") {
      process.exit(1);
    }
    process.stdout.write("package:/data/app/fixture/base.apk\n");
  } else if (
    command[0] === "shell"
    && command[1] === "am"
    && (command[2] === "start" || command[2] === "force-stop")
  ) {
    if (command[2] === "start" && process.env.TAPHOUND_FAKE_LAUNCH === "error") {
      process.stdout.write("Error: Activity not started\n");
    }
  } else if (
    command[0] === "shell"
    && command[1] === "input"
  ) {
    process.stdout.write("");
  } else if (
    command[0] === "shell"
    && command[1] === "dumpsys"
    && command[2] === "activity"
  ) {
    process.stdout.write(
      "mResumedActivity: ActivityRecord{42 u0 com.example.app/.MainActivity t9}\n"
    );
  } else {
    fail(`unsupported fake adb command: ${command.join(" ")}`);
  }
  process.exitCode = 0;
} else {
  fail(`unsupported fake executable: ${executable}`);
}
