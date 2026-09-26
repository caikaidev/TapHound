import { describe, expect, it, vi } from "vitest";

import { ContractVerifier, type ContractVerifyInput } from "../../src/application/contract/contract-verifier.js";
import type { TapHoundReport } from "../../src/domain/report.js";
import { hashJourney } from "../../src/domain/report.js";
import { JourneySchema } from "../../src/domain/journey.js";
import type {
  VerifyHookContext,
  VerifyHookOutcome,
  VerifyHookResult,
  VerifyInput,
  VerifyResult
} from "../../src/application/runtime/verify-runtime.js";
import type { AdbPort } from "../../src/ports/adb.js";
import type { UiSnapshot } from "../../src/ports/ui-snapshot.js";
import type { LoadedKnowledgeBundle } from "../../src/ports/knowledge-registry.js";
import { FakeClock } from "../fakes/fake-clock.js";

const JOURNEY_PATH = "/project/.taphound/journeys/search.json";
const JOURNEY_TEXT = JSON.stringify({
  version: 2,
  name: "Search",
  devices: [{ role: "default" }],
  steps: [{
    action: "click",
    locator: { resourceId: "search" },
    activity: {
      before: "com.example.app.MainActivity",
      after: "com.example.app.SearchActivity"
    }
  }]
});

const journeyHash = hashJourney(JSON.parse(JOURNEY_TEXT));

const CONTRACT_TEXT = JSON.stringify({
  version: 1,
  id: "search-opens",
  goal: "Tapping search opens the search screen",
  journey: { path: ".taphound/journeys/search.json", sha256: journeyHash },
  preconditions: [{ kind: "installed" }],
  assertions: [{
    type: "element",
    locator: { resourceId: "search" },
    visibility: "visible",
    timeoutMs: 2000
  }],
  evidenceRequirements: [{ kind: "screenshot", required: true }]
});

const SNAPSHOT: UiSnapshot = {
  observationId: "obs-1",
  capturedAt: "2026-07-19T10:00:00.000Z",
  durationMs: 1,
  backend: {
    id: "system-uiautomator",
    adapterVersion: "test-v1",
    configSha256: "0".repeat(64)
  },
  viewport: {
    width: 1080,
    height: 1920,
    rotation: 0,
    coordinateSpace: "physicalDisplayPixels"
  },
  roots: [{
    id: "search",
    resourceId: "search",
    clickable: true,
    longClickable: true,
    scrollable: true,
    enabled: true,
    bounds: { left: 0, top: 0, right: 100, bottom: 50 },
    children: []
  }]
};

const EMPTY_SNAPSHOT: UiSnapshot = { ...SNAPSHOT, roots: [] };

function adbStub(
  current: string,
  foregroundPackage = "com.example.app"
): AdbPort {
  return {
    devices: vi.fn(),
    foregroundComponent: vi.fn(() => Promise.resolve({
      packageName: foregroundPackage,
      activity: current
    })),
    currentActivity: vi.fn(() => Promise.resolve(current)),
    isInstalled: vi.fn(),
    launchActivity: vi.fn(),
    startActivityByIntent: vi.fn(),
    resolveLauncherActivity: vi.fn(),
    forceStop: vi.fn(),
    appProcesses: vi.fn(),
    windowTopology: vi.fn(),
    tap: vi.fn(),
    longClick: vi.fn(),
    swipe: vi.fn(),
    back: vi.fn(),
    inputText: vi.fn(),
    startLogcat: vi.fn(),
    dumpLogcat: vi.fn()
  };
}

function report(overrides: Partial<TapHoundReport> = {}): TapHoundReport {
  return {
    schemaVersion: 4,
    runId: "run-123",
    status: "passed",
    startedAt: "2026-07-19T10:00:00.000Z",
    finishedAt: "2026-07-19T10:00:05.000Z",
    durationMs: 5000,
    project: {
      root: "/project",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    },
    journey: { name: "Search", sha256: journeyHash },
    environment: {
      devices: [{
        role: "default",
        deviceSerial: "emulator-5554"
      }],
      tools: { node: "24.3.0" }
    },
    layers: {
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
      startedAtMs: 1000,
      finishedAtMs: 2000,
      durationMs: 1000,
      locator: { status: "found", fallbackUsed: false }
    }],
    artifacts: {
      directory: "/project/.taphound/build/runs/run-123",
      report: "report.json",
      summary: "summary.txt",
      screenshots: [{ role: "default", path: "screenshot-default.png" }],
      logcats: [{ role: "default", path: "logcat-default.txt" }],
      stepLogs: []
    },
    secondaryErrors: [],
    fallbackUsed: false,
    ...overrides
  };
}

type StubOptions = {
  status?: VerifyResult["status"];
  reportOverrides?: Partial<TapHoundReport>;
  runHooks?: boolean;
  snapshot?: UiSnapshot;
  activity?: string;
  foregroundPackage?: string;
};

function verifyStub(options: StubOptions = {}): {
  verify: (input: VerifyInput) => Promise<VerifyResult>;
  calls: VerifyInput[];
} {
  const calls: VerifyInput[] = [];
  const verify = (input: VerifyInput): Promise<VerifyResult> => {
    calls.push(input);
    const hookResults: VerifyHookOutcome[] = [];
    const before: ((context: VerifyHookContext) => Promise<VerifyHookResult>) | undefined
      = input.hooks?.beforeSteps;
    if (options.runHooks !== false && before !== undefined) {
      return before(hookContext(options)).then((outcome) => {
        hookResults.push({
          ...outcome,
          phase: "beforeSteps",
          deviceRole: "default"
        });
        return finishHookResults(hookResults, options, input);
      });
    }
    return finishHookResults(hookResults, options, input);
  };
  return { verify, calls };
}

function finishHookResults(
  hookResults: VerifyHookOutcome[],
  options: StubOptions,
  input: VerifyInput
): Promise<VerifyResult> {
  const after: ((context: VerifyHookContext) => Promise<VerifyHookResult>) | undefined
    = input.hooks?.afterSteps;
  return Promise.resolve().then(async (): Promise<VerifyResult> => {
    if (options.runHooks !== false && after !== undefined) {
      const outcome = await after(hookContext(options));
      hookResults.push({
        ...outcome,
        phase: "afterSteps",
        deviceRole: "default"
      });
    }
    const status = options.status ?? "passed";
    return {
      status,
      exitCode: status === "passed" ? 0 : 4,
      report: report(options.reportOverrides),
      reportPath: "/project/.taphound/build/runs/run-123/report.json",
      summaryPath: "/project/.taphound/build/runs/run-123/summary.txt",
      ...(hookResults.length === 0 ? {} : { hookOutcomes: hookResults })
    };
  });
}

function hookContext(options: {
  snapshot?: UiSnapshot;
  activity?: string;
  foregroundPackage?: string;
}): VerifyHookContext {
  return {
    deviceRole: "default",
    deviceSerial: "emulator-5554",
    adb: adbStub(
      options.activity ?? "com.example.app.MainActivity",
      options.foregroundPackage
    ),
    uiSnapshotProvider: {
      descriptor: SNAPSHOT.backend,
      capture: vi.fn(),
      close: vi.fn()
    },
    logcat: {} as never,
    clock: new FakeClock(),
    snapshot: options.snapshot ?? SNAPSHOT
  };
}

function readTextStub(files: Record<string, string> = {}): ReturnType<typeof vi.fn<(path: string) => Promise<string>>> {
  return vi.fn((path: string): Promise<string> => {
    const content = files[path];
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: ${path}`));
    }
    return Promise.resolve(content);
  });
}

function parseContract(text: string): Record<string, unknown> & {
  assertions: unknown[];
  preconditions: unknown[];
} {
  const value = JSON.parse(text) as Record<string, unknown> & {
    assertions?: unknown[];
    preconditions?: unknown[];
  };
  return {
    ...value,
    assertions: value.assertions ?? [],
    preconditions: value.preconditions ?? []
  };
}

function makeVerifier(options: {
  verify?: ReturnType<typeof verifyStub>["verify"];
  readText?: ReturnType<typeof readTextStub>;
  knowledge?: LoadedKnowledgeBundle | undefined;
}): ContractVerifier {
  const knowledge = options.knowledge;
  const dependencies = {
    verify: options.verify ?? verifyStub().verify,
    readText: options.readText ?? readTextStub({
      [JOURNEY_PATH]: JOURNEY_TEXT,
      "/project/contracts/search.json": CONTRACT_TEXT
    }),
    ...(knowledge === undefined ? {} : {
      loadKnowledge: vi.fn((_input: {
        projectRoot: string;
        workspaceRoot?: string | undefined;
        packageName: string;
      }): Promise<LoadedKnowledgeBundle> => {
        void _input;
        return Promise.resolve(knowledge);
      })
    }),
    now: (): Date => new Date("2026-07-19T10:10:00.000Z")
  };
  return new ContractVerifier(dependencies);
}

const verifyInput: ContractVerifyInput = {
  projectRoot: "/project",
  config: {
    version: 1,
    run: { packageName: "com.example.app", activity: ".MainActivity" },
    idle: {
      strategy: "hybrid",
      pollIntervalMs: 100,
      stablePolls: 1,
      timeoutMs: 500
    },
    artifactsDir: ".taphound/build/runs"
  },
  devices: [{ role: "default", deviceSerial: "emulator-5554" }],
  toolVersions: { node: "24.3.0" },
  contractPath: "/project/contracts/search.json"
};

describe("ContractVerifier", () => {
  it("requires complete, bound allOf event evidence for a required Checkpoint", async () => {
    const expectEvent = {
      type: "logcatEvent", tag: "Search", event: "results",
      window: { from: "runStart" }
    };
    const journey = JourneySchema.parse({
      ...JSON.parse(JOURNEY_TEXT) as Record<string, unknown>,
      checkpoints: [{
        version: 1, id: "search-event", name: "Search event", stepIndex: 0,
        expect: { timeoutMs: 200, allOf: [
          { kind: "absentElement", locator: { resourceId: "spinner" } },
          { kind: "logcatEvent", expect: expectEvent }
        ] }
      }]
    });
    const sha256 = hashJourney(journey);
    const contract = {
      ...parseContract(CONTRACT_TEXT),
      journey: { path: ".taphound/journeys/search.json", sha256 },
      requiredCheckpoints: ["search-event"]
    };
    const eventCondition = journey.checkpoints?.[0]?.expect.allOf[1];
    if (eventCondition?.kind !== "logcatEvent") {
      throw new Error("Missing event Checkpoint fixture");
    }
    const valid: NonNullable<TapHoundReport["checkpoints"]>[number] = {
      id: "search-event", stepIndex: 0, status: "passed",
      conditions: [
        { kind: "absentElement", status: "passed",
          locator: { resourceId: "spinner" } },
        { kind: "logcatEvent", status: "passed",
          expect: eventCondition.expect,
          matchedCount: 1, matchedLineSha256: "a".repeat(64),
          startedAtMs: 10, matchedAtMs: 20,
          evidenceRef: "logcat-default.txt" }
      ]
    };
    const verifyWith = (overrides: Partial<TapHoundReport>): ReturnType<
      ContractVerifier["verify"]
    > => makeVerifier({
      verify: verifyStub({ reportOverrides: {
        journey: { name: "Search", sha256 }, checkpoints: [valid], ...overrides
      } }).verify,
      readText: readTextStub({
        [JOURNEY_PATH]: JSON.stringify(journey),
        "/project/contracts/search.json": JSON.stringify(contract)
      })
    }).verify(verifyInput);
    const passed = await verifyWith({});
    expect(passed.view).toMatchObject({
      verdict: "pass", checkpoints: [{ id: "search-event", status: "passed" }]
    });
    const beforeWindow = await verifyWith({ logcatEvidence: [{
      role: "default", status: "incomplete",
      droppedLines: 1, droppedBytes: 20, lastDroppedAtMs: 5
    }] });
    expect(beforeWindow.view.checkpoints).toMatchObject([{ status: "passed" }]);
    const overflow = await verifyWith({ logcatEvidence: [{
      role: "default", status: "incomplete", droppedLines: 1, droppedBytes: 20
    }] });
    expect(overflow.view.checkpoints).toMatchObject([{ status: "unresolved" }]);
    const withoutHash = await verifyWith({
      checkpoints: [{
        ...valid,
        conditions: [{
          kind: "absentElement", status: "passed",
          locator: { resourceId: "spinner" }
        }, {
          kind: "logcatEvent", status: "passed",
          expect: eventCondition.expect,
          matchedCount: 1, startedAtMs: 10
        }]
      }]
    });
    expect(withoutHash.view.checkpoints).toMatchObject([{ status: "unresolved" }]);
  });

  function requiredCheckpointHarness(options: StubOptions = {}): ContractVerifier {
    const journey = {
      ...JSON.parse(JOURNEY_TEXT) as Record<string, unknown>,
      checkpoints: [{
        version: 1,
        id: "search-ready",
        name: "Search ready",
        stepIndex: 0,
        expect: {
          allOf: [
            { kind: "absentElement", locator: { resourceId: "loading" } }
          ],
          timeoutMs: 100
        }
      }]
    };
    const contract = {
      ...parseContract(CONTRACT_TEXT),
      journey: {
        path: ".taphound/journeys/search.json",
        sha256: hashJourney(JourneySchema.parse(journey))
      },
      requiredCheckpoints: ["search-ready"]
    };
    const reportOverrides: Partial<TapHoundReport> = {
      journey: { name: "Search", sha256: contract.journey.sha256 },
      ...options.reportOverrides
    };
    return makeVerifier({
      verify: verifyStub({ ...options, reportOverrides }).verify,
      readText: readTextStub({
        [JOURNEY_PATH]: JSON.stringify(journey),
        "/project/contracts/search.json": JSON.stringify(contract)
      })
    });
  }

  it("requires a bound Checkpoint result before passing", async () => {
    const missing = await requiredCheckpointHarness().verify(verifyInput);
    expect(missing.view).toMatchObject({
      verdict: "inconclusive",
      reason: "CHECKPOINT_UNRESOLVED",
      checkpoints: [{ id: "search-ready", status: "notRun" }]
    });
    const passed = await requiredCheckpointHarness({
      reportOverrides: {
        checkpoints: [{
          id: "search-ready",
          stepIndex: 0,
          status: "passed",
          conditions: [{
            kind: "absentElement",
            status: "passed",
            locator: { resourceId: "loading" }
          }]
        }]
      }
    }).verify(verifyInput);
    expect(passed.view).toMatchObject({
      verdict: "pass",
      checkpoints: [{ id: "search-ready", status: "passed" }]
    });
  });

  it("rejects mismatched or duplicate required evidence", async () => {
    const mismatch = await requiredCheckpointHarness({
      reportOverrides: {
        checkpoints: [{
          id: "search-ready",
          status: "passed",
          conditions: [{
            kind: "absentElement",
            status: "passed",
            locator: { resourceId: "different" }
          }]
        }]
      }
    }).verify(verifyInput);
    expect(mismatch.view).toMatchObject({
      verdict: "inconclusive",
      checkpoints: [{ status: "unresolved" }]
    });
    const valid = {
      id: "search-ready",
      stepIndex: 0,
      status: "passed" as const,
      conditions: [{
        kind: "absentElement" as const,
        status: "passed" as const,
        locator: { resourceId: "loading" }
      }]
    };
    const duplicate = await requiredCheckpointHarness({
      reportOverrides: { checkpoints: [valid, valid] }
    }).verify(verifyInput);
    expect(duplicate.view.checkpoints?.[0]?.status).toBe("notRun");
  });

  it("does not pass required evidence from a report bound to another Journey", async () => {
    const result = await requiredCheckpointHarness({
      reportOverrides: {
        journey: { name: "Search", sha256: "b".repeat(64) },
        checkpoints: [{
          id: "search-ready", stepIndex: 0, status: "passed",
          conditions: [{
            kind: "absentElement", status: "passed",
            locator: { resourceId: "loading" }
          }]
        }]
      }
    }).verify(verifyInput);
    expect(result.view).toMatchObject({
      verdict: "inconclusive",
      reason: "RUN_ERROR"
    });
  });

  it("uses a Checkpoint-specific reason for failed or unresolved replay", async () => {
    for (const [code, conditionStatus, verdict] of [
      ["CHECKPOINT_FAILED", "failed", "fail"],
      ["CHECKPOINT_UNRESOLVED", "unresolved", "inconclusive"]
    ] as const) {
      const result = await requiredCheckpointHarness({
        status: "failed",
        reportOverrides: {
          status: "failed",
          primaryFailure: { code, message: "Checkpoint not satisfied", phase: "replay" },
          checkpoints: [{
            id: "search-ready",
            stepIndex: 0,
            status: conditionStatus,
            conditions: [{
              kind: "absentElement",
              status: conditionStatus,
              locator: { resourceId: "loading" }
            }]
          }]
        }
      }).verify(verifyInput);
      expect(result.view).toMatchObject({
        verdict,
        reason: code,
        checkpoints: [{ status: conditionStatus }]
      });
    }
  });

  it("rejects a required Checkpoint absent from the bound Journey", async () => {
    const contract = {
      ...parseContract(CONTRACT_TEXT),
      requiredCheckpoints: ["not-in-journey"]
    };
    const result = await makeVerifier({
      readText: readTextStub({
        [JOURNEY_PATH]: JOURNEY_TEXT,
        "/project/contracts/search.json": JSON.stringify(contract)
      })
    }).verify(verifyInput);
    expect(result.view).toMatchObject({
      verdict: "invalid",
      reason: "CONTRACT_INVALID"
    });
  });

  it("forwards strict Replay flags without changing the Contract verdict", async () => {
    const stub = verifyStub();
    const verifier = makeVerifier({ verify: stub.verify });
    const result = await verifier.verify({
      ...verifyInput,
      generatedReplayPolicy: true,
      requireFocusedInput: true,
      config: {
        ...verifyInput.config,
        idle: {
          strategy: "structural",
          pollIntervalMs: 250,
          stablePolls: 4,
          timeoutMs: 45000
        }
      }
    });
    expect(result.view.verdict).toBe("pass");
    expect(stub.calls[0]).toMatchObject({
      generatedReplayPolicy: true,
      requireFocusedInput: true,
      config: { idle: { strategy: "structural" } }
    });
  });
  it("returns pass when the run, hooks, and evidence all succeed", async () => {
    const verifier = makeVerifier({});
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("pass");
    expect(result.view.reason).toBe("CONTRACT_OK");
    expect(result.exitCode).toBe(0);
    expect(result.view.reportStatus).toBe("passed");
    expect(result.view.preconditions).toEqual([{
      kind: "installed",
      status: "passed"
    }]);
    expect(result.view.assertions).toEqual([{
      type: "element",
      status: "passed"
    }]);
    expect(result.view.evidence[0]).toMatchObject({
      kind: "screenshot",
      required: true,
      satisfied: true
    });
    expect(result.view.reportPath).toBe(
      "/project/.taphound/build/runs/run-123/report.json"
    );
  });

  it("fails when the Journey replay fails", async () => {
    const verifier = makeVerifier({
      verify: verifyStub({
        status: "failed",
        reportOverrides: {
          status: "failed",
          primaryFailure: {
            code: "EXTERNAL_PACKAGE_MISMATCH",
            message: "left the package",
            phase: "replay"
          }
        }
      }).verify
    });
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("fail");
    expect(result.view.reason).toBe("RUN_FAILED");
  });

  it("fails when a post-journey assertion does not hold", async () => {
    const verifier = makeVerifier({
      verify: verifyStub({
        snapshot: EMPTY_SNAPSHOT
      }).verify
    });
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("fail");
    expect(result.view.reason).toBe("ASSERTION_FAILED");
    expect(result.view.assertions[0]).toMatchObject({
      type: "element",
      status: "failed"
    });
  });

  it("is inconclusive when a required evidence kind is missing", async () => {
    const verifier = makeVerifier({
      verify: verifyStub({
        reportOverrides: {
          artifacts: {
            directory: "/project/.taphound/build/runs/run-123",
            report: "report.json",
            summary: "summary.txt",
            screenshots: [],
            logcats: [],
            stepLogs: []
          }
        }
      }).verify
    });
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("inconclusive");
    expect(result.view.reason).toBe("EVIDENCE_INSUFFICIENT");
    expect(result.view.evidence[0]).toMatchObject({
      satisfied: false
    });
  });

  it("does not satisfy anyStep Logcat evidence with only a final Logcat", async () => {
    const contract = parseContract(CONTRACT_TEXT);
    contract.evidenceRequirements = [{
      kind: "logcat",
      scope: "anyStep",
      required: true
    }];
    const verifier = makeVerifier({
      readText: readTextStub({
        [JOURNEY_PATH]: JOURNEY_TEXT,
        "/project/contracts/search.json": JSON.stringify(contract)
      })
    });

    const result = await verifier.verify(verifyInput);
    expect(result.view.reason).toBe("EVIDENCE_INSUFFICIENT");
    expect(result.view.evidence).toEqual([expect.objectContaining({
      kind: "logcat",
      satisfied: false
    })]);
  });

  it("is inconclusive when the run errored", async () => {
    const verifier = makeVerifier({
      verify: verifyStub({
        status: "error",
        runHooks: false,
        reportOverrides: {
          status: "error",
          primaryFailure: {
            code: "APP_NOT_INSTALLED",
            message: "not installed",
            phase: "install"
          }
        }
      }).verify
    });
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("inconclusive");
    expect(result.view.reason).toBe("RUN_ERROR");
  });

  it("is inconclusive when the Journey needs a manual step", async () => {
    const verifier = makeVerifier({
      verify: verifyStub({
        status: "manualRequired",
        reportOverrides: {
          status: "manualRequired",
          primaryFailure: {
            code: "MANUAL_STEP_REQUIRED",
            message: "manual",
            phase: "replay"
          }
        }
      }).verify
    });
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("inconclusive");
    expect(result.view.reason).toBe("RUN_MANUAL_REQUIRED");
  });

  it("is invalid with JOURNEY_DRIFT when the bound Journey content changed", async () => {
    const drifted = JOURNEY_TEXT.replace(
      '"Search"',
      '"Search Renamed"'
    );
    const verifier = makeVerifier({
      readText: readTextStub({
        [JOURNEY_PATH]: drifted,
        "/project/contracts/search.json": CONTRACT_TEXT
      })
    });
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("invalid");
    expect(result.view.reason).toBe("JOURNEY_DRIFT");
    expect(result.exitCode).toBe(2);
  });

  it("is invalid with JOURNEY_MISSING when the bound Journey is absent", async () => {
    const verifier = makeVerifier({
      readText: readTextStub({
        "/project/contracts/search.json": CONTRACT_TEXT
      })
    });
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("invalid");
    expect(result.view.reason).toBe("JOURNEY_MISSING");
  });

  it("is invalid with CONTRACT_INVALID when the contract file is malformed", async () => {
    const verifier = makeVerifier({
      readText: readTextStub({
        [JOURNEY_PATH]: JOURNEY_TEXT,
        "/project/contracts/search.json": "{ nope"
      })
    });
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("invalid");
    expect(result.view.reason).toBe("CONTRACT_INVALID");
  });

  it("is invalid with KNOWLEDGE_UNAVAILABLE when screen terms need Knowledge and none is configured", async () => {
    const contract = parseContract(CONTRACT_TEXT);
    contract.assertions.push({ type: "screen", screen: "search-screen", timeoutMs: 2000 });
    const verifier = makeVerifier({
      readText: readTextStub({
        [JOURNEY_PATH]: JOURNEY_TEXT,
        "/project/contracts/search.json": JSON.stringify(contract)
      })
    });
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("invalid");
    expect(result.view.reason).toBe("KNOWLEDGE_UNAVAILABLE");
  });

  it("is invalid when targetScreen is absent from loaded Knowledge", async () => {
    const contract = parseContract(CONTRACT_TEXT);
    contract.targetScreen = "missing-screen";
    const verifier = makeVerifier({
      knowledge: {
        index: {
          version: 1,
          packageName: "com.example.app",
          revision: 1,
          anchors: [],
          screens: []
        },
        indexSha256: "a".repeat(64),
        knowledgeHash: "b".repeat(64),
        anchors: [],
        screens: []
      },
      readText: readTextStub({
        [JOURNEY_PATH]: JOURNEY_TEXT,
        "/project/contracts/search.json": JSON.stringify(contract)
      })
    });

    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("invalid");
    expect(result.view.reason).toBe("KNOWLEDGE_UNAVAILABLE");
    expect(result.view.message).toContain("missing-screen");
  });

  it("fails an element assertion when its package is not foreground", async () => {
    const contract = parseContract(CONTRACT_TEXT);
    contract.assertions = [{
      type: "element",
      locator: { resourceId: "search" },
      visibility: "visible",
      packageName: "com.example.external",
      timeoutMs: 2000
    }];
    const verifier = makeVerifier({
      verify: verifyStub({ foregroundPackage: "com.example.app" }).verify,
      readText: readTextStub({
        [JOURNEY_PATH]: JOURNEY_TEXT,
        "/project/contracts/search.json": JSON.stringify(contract)
      })
    });

    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("fail");
    expect(result.view.assertions[0]?.message).toContain(
      "Expected foreground package com.example.external"
    );
  });

  it("evaluates activity preconditions against the live Activity", async () => {
    const contract = parseContract(CONTRACT_TEXT);
    contract.preconditions = [{
      kind: "activity",
      activity: "com.example.app.MainActivity",
      timeoutMs: 2000
    }];
    const verifier = makeVerifier({
      readText: readTextStub({
        [JOURNEY_PATH]: JOURNEY_TEXT,
        "/project/contracts/search.json": JSON.stringify(contract)
      })
    });
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("pass");
    expect(result.view.preconditions).toEqual([{
      kind: "activity",
      status: "passed"
    }]);
  });

  it("fails when an activity precondition does not match", async () => {
    const contract = parseContract(CONTRACT_TEXT);
    contract.preconditions = [{
      kind: "activity",
      activity: "com.example.app.OtherActivity",
      timeoutMs: 2000
    }];
    const verifier = makeVerifier({
      readText: readTextStub({
        [JOURNEY_PATH]: JOURNEY_TEXT,
        "/project/contracts/search.json": JSON.stringify(contract)
      })
    });
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("fail");
    expect(result.view.reason).toBe("PRECONDITION_FAILED");
  });

  it("publishes the verdict through writeVerdict when configured", async () => {
    const writeVerdict = vi.fn();
    const dependencies = {
      verify: verifyStub().verify,
      readText: readTextStub({
        [JOURNEY_PATH]: JOURNEY_TEXT,
        "/project/contracts/search.json": CONTRACT_TEXT
      }),
      writeVerdict,
      now: (): Date => new Date("2026-07-19T10:10:00.000Z")
    };
    const verifier = new ContractVerifier(dependencies);
    const result = await verifier.verify(verifyInput);
    expect(result.view.verdict).toBe("pass");
    expect(writeVerdict).toHaveBeenCalledTimes(1);
    const verdictCall = writeVerdict.mock.calls[0]?.[0] as
      | { reportPath: string; verdict: { verdict: string } }
      | undefined;
    expect(verdictCall?.reportPath).toBe(
      "/project/.taphound/build/runs/run-123/report.json"
    );
    expect(verdictCall?.verdict.verdict).toBe("pass");
  });
});