import { vi } from "vitest";

import {
  ReportWriter,
  type PublishedReport
} from "../../src/application/report/report-writer.js";
import type { AprReport } from "../../src/domain/report.js";
import type { VerifyRuntimeDependencies } from "../../src/application/runtime/verify-runtime.js";
import type { AprConfig } from "../../src/domain/config.js";
import type { Journey } from "../../src/domain/journey.js";
import type { AdbPort, LogcatOptions } from "../../src/ports/adb.js";
import type { AndroidCliPort } from "../../src/ports/android-cli.js";
import type { GradlePort } from "../../src/ports/gradle.js";
import type { ArtifactSession } from "../../src/ports/artifact-store.js";
import { MemoryArtifactStore } from "./artifact-store.js";
import { FakeClock } from "./fake-clock.js";
import { commandResult } from "./process-runner.js";

export const runtimeConfig: AprConfig = {
  version: 1,
  build: { task: ":app:assembleDebug" },
  artifact: { target: "app", variant: "debug" },
  run: {
    packageName: "com.example.app",
    activity: ".MainActivity"
  },
  idle: {
    pollIntervalMs: 100,
    stablePolls: 1,
    timeoutMs: 500
  },
  artifactsDir: ".apr/runs"
};

export const runtimeJourney: Journey = {
  version: 1,
  name: "Search",
  steps: [{
    action: "click",
    locator: { resourceId: "search" },
    activity: {
      before: "com.example.app.MainActivity",
      after: "com.example.app.SearchActivity"
    }
  }]
};

export interface RuntimeFixture {
  order: string[];
  dependencies: VerifyRuntimeDependencies;
  gradle: GradlePort;
  androidCli: AndroidCliPort;
  adb: AdbPort;
  artifacts: MemoryArtifactStore;
}

export function runtimeFixture(): RuntimeFixture {
  const order: string[] = [];
  const artifacts = new MemoryArtifactStore();
  const gradle: GradlePort = {
    build: vi.fn(() => {
      order.push("build");
      return Promise.resolve(commandResult());
    })
  };
  const activities = [
    "com.example.app.MainActivity",
    "com.example.app.MainActivity",
    "com.example.app.SearchActivity"
  ];
  let layoutCalls = 0;
  const androidCli: AndroidCliPort = {
    describeProject: vi.fn(() => {
      order.push("describe");
      return Promise.resolve({
        apkPath: "/project/app-debug.apk",
        metadataPaths: ["/project/output-metadata.json"]
      });
    }),
    runApp: vi.fn(() => {
      order.push("run");
      return Promise.resolve(commandResult());
    }),
    layout: vi.fn(() => {
      layoutCalls += 1;
      order.push(layoutCalls === 1 ? "baseline" : "step-layout");
      return Promise.resolve([{
        id: "search",
        resourceId: "search",
        clickable: true,
        longClickable: true,
        scrollable: true,
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        children: []
      }]);
    }),
    layoutDiff: vi.fn(() => {
      order.push("idle");
      return Promise.resolve([]);
    }),
    captureScreen: vi.fn(() => {
      order.push("screenshot");
      return Promise.resolve(commandResult());
    }),
    resolveScreen: vi.fn(() => Promise.resolve({ x: 50, y: 25 }))
  };
  const adb: AdbPort = {
    devices: vi.fn(),
    currentActivity: vi.fn(() => {
      const value = activities.shift() ?? "com.example.app.SearchActivity";
      order.push(value.endsWith("MainActivity") ? "activity-main" : "activity-search");
      return Promise.resolve(value);
    }),
    pid: vi.fn(() => {
      order.push("pid");
      return Promise.resolve(42);
    }),
    tap: vi.fn(() => {
      order.push("action");
      return Promise.resolve(commandResult());
    }),
    longClick: vi.fn(() => Promise.resolve(commandResult())),
    swipe: vi.fn(() => Promise.resolve(commandResult())),
    back: vi.fn(() => Promise.resolve(commandResult())),
    inputText: vi.fn(() => Promise.resolve(commandResult())),
    startLogcat: vi.fn((options: LogcatOptions) => {
      order.push("logcat-start");
      options.onStdoutLine("07-19 10:00:00.000  42  42 I APR: ready");
      const completion = Promise.resolve(commandResult());
      return {
        completion,
        stop: vi.fn(() => {
          order.push("logcat-stop");
          return completion;
        })
      };
    })
  };
  const writer = new ReportWriter();
  return {
    order,
    gradle,
    androidCli,
    adb,
    artifacts,
    dependencies: {
      gradle,
      androidCli,
      adb,
      clock: new FakeClock(),
      artifactStore: artifacts,
      reportWriter: {
        writeAndPublish: async (
          session: ArtifactSession,
          report: AprReport
        ): Promise<PublishedReport> => {
          order.push("report");
          return writer.writeAndPublish(session, report);
        }
      },
      now: () => new Date("2026-07-19T10:00:00.000Z"),
      createRunId: () => "run-123"
    }
  };
}
