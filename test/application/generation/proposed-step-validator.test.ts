import { describe, expect, it } from "vitest";

import {
  ProposedStepValidator
} from "../../../src/application/generation/proposed-step-validator.js";
import type { GenerationSession } from "../../../src/domain/generation.js";
import type { LayoutElement } from "../../../src/domain/layout.js";
import type { ProposedStep } from "../../../src/domain/proposed-step.js";
import {
  hashRuntimeSnapshot,
  type RuntimeSnapshot
} from "../../../src/domain/runtime-snapshot.js";

const activity = "com.example.app.MainActivity";
type ProposalDraft = ProposedStep extends infer Step
  ? Step extends ProposedStep
    ? Omit<Step, "binding" | "activity">
    : never
  : never;

function element(
  overrides: Partial<LayoutElement> = {}
): LayoutElement {
  return {
    id: "target",
    resourceId: "target",
    enabled: true,
    center: { x: 50, y: 50 },
    children: [],
    ...overrides
  };
}

function snapshot(
  layout: LayoutElement[],
  overrides: Partial<RuntimeSnapshot> = {}
): RuntimeSnapshot {
  return {
    version: 1,
    generationId: "generation-1",
    baseRevision: 2,
    deviceSerial: "emulator-5554",
    expectedPackageName: "com.example.app",
    foregroundPackageName: "com.example.app",
    activity,
    pid: 42,
    capturedAt: "2026-07-22T12:00:00.000Z",
    layout,
    ...overrides
  };
}

function session(runtime: RuntimeSnapshot): GenerationSession {
  return {
    version: 1,
    id: "generation-1",
    revision: 2,
    state: "active",
    bindings: {
      projectHash: "a".repeat(64),
      configHash: "b".repeat(64),
      contextHash: "c".repeat(64),
      snapshotHash: hashRuntimeSnapshot(runtime)
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: {
        allowedActions: ["click"],
        confirmationRequiredActions: [],
        forbiddenActions: []
      }
    },
    variables: {
      runId: "run-1",
      timestamp: "2026-07-22T12:00:00.000Z",
      randomHex: "a0"
    },
    candidateSteps: [],
    candidateSources: [],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" }
  };
}

function proposal(
  runtime: RuntimeSnapshot,
  value: ProposalDraft
): ProposedStep {
  return {
    ...value,
    binding: {
      generationId: "generation-1",
      baseRevision: 2,
      snapshotHash: hashRuntimeSnapshot(runtime)
    },
    activity: { before: activity }
  };
}

function validate(
  runtime: RuntimeSnapshot,
  value: ProposalDraft
): ProposedStep {
  return new ProposedStepValidator().validate({
    session: session(runtime),
    snapshot: runtime,
    proposal: proposal(runtime, value)
  });
}

describe("ProposedStepValidator", () => {
  it.each([
    ["click", { clickable: true }, { action: "click", locator: { resourceId: "target" } }],
    ["longClick", { longClickable: true }, {
      action: "longClick",
      locator: { resourceId: "target" },
      durationMs: 800
    }],
    ["swipe", { scrollable: true, bounds: { left: 0, top: 0, right: 100, bottom: 100 } }, {
      action: "swipe",
      locator: { resourceId: "target" },
      direction: "up",
      distancePercent: 0.6,
      durationMs: 300
    }]
  ] as const)("accepts a unique enabled capable %s target", (_name, capability, step) => {
    const runtime = snapshot([element(capability)]);
    expect(validate(runtime, step as ProposalDraft))
      .toMatchObject(step);
  });

  it.each([
    ["click", {}, { action: "click", locator: { resourceId: "target" } }],
    ["longClick", {}, {
      action: "longClick",
      locator: { resourceId: "target" },
      durationMs: 800
    }],
    ["swipe", { scrollable: true }, {
      action: "swipe",
      locator: { resourceId: "target" },
      direction: "up",
      distancePercent: 0.6,
      durationMs: 300
    }]
  ] as const)("rejects a %s target missing its required capability", (_name, capability, step) => {
    const runtime = snapshot([element(capability)]);
    expect(() => validate(
      runtime,
      step as ProposalDraft
    )).toThrow(/capability|clickable|longClickable|bounds/i);
  });

  it.each([
    ["missing", []],
    ["ambiguous", [element({ id: "one" }), element({ id: "two" })]],
    ["disabled", [element({ clickable: true, enabled: false })]]
  ])("rejects a %s click target", (_name, layout) => {
    const runtime = snapshot(layout);
    expect(() => validate(runtime, {
      action: "click",
      locator: { resourceId: "target" }
    })).toThrow();
  });

  it.each([
    ["longClick", {
      action: "longClick",
      locator: { resourceId: "target" },
      durationMs: 800
    }, { longClickable: true }],
    ["swipe", {
      action: "swipe",
      locator: { resourceId: "target" },
      direction: "up",
      distancePercent: 0.6,
      durationMs: 300
    }, {
      scrollable: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 100 }
    }]
  ] as const)("rejects missing, ambiguous, and disabled %s targets", (
    _name,
    step,
    capability
  ) => {
    for (const layout of [
      [],
      [
        element({ id: "one", ...capability }),
        element({ id: "two", ...capability })
      ],
      [element({ ...capability, enabled: false })]
    ]) {
      expect(() => validate(snapshot(layout), step as ProposalDraft)).toThrow();
    }
  });

  it("accepts scrollTo with an absent target but rejects an ambiguous target", () => {
    const container = element({
      id: "container",
      resourceId: "container",
      scrollable: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 200 }
    });
    const absent = snapshot([container]);
    expect(validate(absent, {
      action: "scrollTo",
      locator: { text: "later" },
      container: { resourceId: "container" },
      direction: "up",
      maxSwipes: 20,
      distancePercent: 0.6,
      durationMs: 300
    }).action).toBe("scrollTo");

    const ambiguous = snapshot([
      container,
      element({ id: "one", resourceId: undefined, text: "later" }),
      element({ id: "two", resourceId: undefined, text: "later" })
    ]);
    expect(() => validate(ambiguous, {
      action: "scrollTo",
      locator: { text: "later" },
      container: { resourceId: "container" },
      direction: "up",
      maxSwipes: 20,
      distancePercent: 0.6,
      durationMs: 300
    })).toThrow(/ambiguous/i);
  });

  it("rejects an invalid scrollTo container", () => {
    const runtime = snapshot([element({ resourceId: "container" })]);
    expect(() => validate(runtime, {
      action: "scrollTo",
      locator: { text: "later" },
      container: { resourceId: "container" },
      direction: "up",
      maxSwipes: 20,
      distancePercent: 0.6,
      durationMs: 300
    })).toThrow(/scrollable|bounds/i);
  });

  it("rejects missing, ambiguous, and disabled scrollTo containers", () => {
    const step = {
      action: "scrollTo",
      locator: { text: "later" },
      container: { resourceId: "container" },
      direction: "up",
      maxSwipes: 20,
      distancePercent: 0.6,
      durationMs: 300
    } as const;
    for (const layout of [
      [],
      [
        element({
          id: "one",
          resourceId: "container",
          scrollable: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 }
        }),
        element({
          id: "two",
          resourceId: "container",
          scrollable: true,
          bounds: { left: 0, top: 100, right: 100, bottom: 200 }
        })
      ],
      [element({
        resourceId: "container",
        enabled: false,
        scrollable: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 }
      })]
    ]) {
      expect(() => validate(snapshot(layout), step)).toThrow();
    }
  });

  it("requires exactly one enabled focused parsed input element", () => {
    const focused = element({ focused: true });
    const valid = snapshot([focused]);
    expect(validate(valid, { action: "inputText", text: "hello" }).action)
      .toBe("inputText");

    for (const layout of [
      [],
      [element({ focused: true, enabled: false })],
      [element({ focused: false })],
      [focused, element({ id: "other", resourceId: "other", focused: true })]
    ]) {
      expect(() => validate(
        snapshot(layout),
        { action: "inputText", text: "hello" }
      )).toThrow(/focused/i);
    }
  });

  it("allows back and wait without a target", () => {
    const runtime = snapshot([]);
    expect(validate(runtime, { action: "back" }).action).toBe("back");
    expect(validate(runtime, { action: "wait" }).action).toBe("wait");
  });

  it.each([
    ["generation id", { generationId: "other" }, {}],
    ["revision", { baseRevision: 3 }, {}],
    ["snapshot hash", { snapshotHash: "f".repeat(64) }, {}],
    ["foreground package", {}, { foregroundPackageName: "com.other.app" }],
    ["before activity", {}, { activity: "com.example.app.OtherActivity" }]
  ])("rejects stale or escaped %s binding", (_name, bindingChange, snapshotChange) => {
    const runtime = snapshot([], snapshotChange);
    const proposed = proposal(runtime, { action: "wait" });
    proposed.binding = { ...proposed.binding, ...bindingChange };
    expect(() => new ProposedStepValidator().validate({
      session: session(runtime),
      snapshot: runtime,
      proposal: proposed
    })).toThrow();
  });
});
