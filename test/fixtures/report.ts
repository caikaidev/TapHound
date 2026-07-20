import type { TapHoundReport } from "../../src/domain/report.js";

export function validReport(
  overrides: Partial<TapHoundReport> = {}
): TapHoundReport {
  return {
    schemaVersion: 1,
    runId: "run-123",
    status: "passed",
    startedAt: "2026-07-19T10:00:00.000Z",
    finishedAt: "2026-07-19T10:00:01.000Z",
    durationMs: 1000,
    project: {
      root: "/project",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    },
    journey: {
      name: "Search",
      sha256: "a".repeat(64)
    },
    environment: {
      deviceSerial: "emulator-5554",
      tools: {
        node: "24.3.0",
        adb: "1.0.41",
        android: "1.0.0"
      }
    },
    layers: {
      build: "passed",
      run: "passed",
      structural: "passed",
      activityCheckpoint: "passed",
      explicitExpect: "passed",
      collection: "passed"
    },
    steps: [{
      index: 0,
      action: "click",
      status: "passed",
      startedAtMs: 0,
      finishedAtMs: 300,
      durationMs: 300,
      locator: {
        status: "found",
        matchedBy: "resourceId",
        fallbackUsed: false
      },
      idle: {
        status: "stable",
        polls: 2
      },
      activity: {
        before: {
          status: "passed",
          expected: "com.example.app.MainActivity",
          actual: "com.example.app.MainActivity"
        },
        after: {
          status: "passed",
          expected: "com.example.app.SearchActivity",
          actual: "com.example.app.SearchActivity"
        }
      },
      expectation: {
        type: "element",
        status: "passed"
      },
      logcatPath: "steps/001-logcat.txt"
    }],
    artifacts: {
      directory: "/reports/run-123",
      report: "report.json",
      summary: "summary.txt",
      screenshot: "screenshot.png",
      logcat: "logcat.txt",
      stepLogs: ["steps/001-logcat.txt"]
    },
    secondaryErrors: [],
    fallbackUsed: false,
    ...overrides
  };
}
