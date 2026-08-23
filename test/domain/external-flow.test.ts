import { describe, expect, it } from "vitest";

import {
  ExternalFlowSchema
} from "../../src/domain/external-flow.js";
import { ExternalStepSchema } from "../../src/domain/journey.js";

const validClickStep = {
  action: "click" as const,
  locator: { resourceId: "shutter_button" },
  expectedActivity: "com.android.camera.CameraActivity"
};

const validBackStep = {
  action: "back" as const,
  expectedActivity: "com.android.camera.CameraActivity"
};

const validWaitStep = {
  action: "wait" as const,
  expectedActivity: "com.android.camera.CameraActivity"
};

const validInputTextStep = {
  action: "inputText" as const,
  text: "hello",
  expectedActivity: "com.android.camera.CameraActivity"
};

const validSwipeStep = {
  action: "swipe" as const,
  locator: { resourceId: "viewfinder" },
  direction: "up" as const,
  expectedActivity: "com.android.camera.CameraActivity"
};

const validScrollToStep = {
  action: "scrollTo" as const,
  locator: { resourceId: "mode_toggle" },
  container: { resourceId: "mode_list" },
  direction: "up" as const,
  expectedActivity: "com.android.camera.CameraActivity"
};

const validLongClickStep = {
  action: "longClick" as const,
  locator: { resourceId: "focus_ring" },
  expectedActivity: "com.android.camera.CameraActivity"
};

describe("ExternalStepSchema", () => {
  it.each([
    validClickStep,
    validLongClickStep,
    validInputTextStep,
    validSwipeStep,
    validScrollToStep,
    validBackStep,
    validWaitStep
  ])("accepts a valid $action external step", (step) => {
    expect(() => ExternalStepSchema.parse(step)).not.toThrow();
  });

  it("rejects a click step whose locator lacks resourceId and evidence", () => {
    expect(() => ExternalStepSchema.parse({
      action: "click",
      locator: { text: "Shutter" },
      expectedActivity: "com.android.camera.CameraActivity"
    })).toThrow(/resourceId.*evidence/i);
  });

  it("accepts a click step whose locator has evidence but no resourceId", () => {
    expect(() => ExternalStepSchema.parse({
      action: "click",
      locator: {
        text: "Shutter",
        index: 0,
        evidence: {
          version: 1,
          semanticSha256: "a".repeat(64)
        }
      },
      expectedActivity: "com.android.camera.CameraActivity"
    })).not.toThrow();
  });

  it("rejects an element expectation whose locator lacks resourceId and evidence", () => {
    expect(() => ExternalStepSchema.parse({
      action: "click",
      locator: { resourceId: "shutter_button" },
      expectedActivity: "com.android.camera.CameraActivity",
      expect: {
        type: "element",
        locator: { text: "Capture" },
        timeoutMs: 3000
      }
    })).toThrow(/resourceId.*evidence/i);
  });

  it("applies defaults for longClick durationMs", () => {
    const parsed = ExternalStepSchema.parse(validLongClickStep);
    expect(parsed).toMatchObject({ durationMs: 800 });
  });

  it("applies defaults for swipe distancePercent and durationMs", () => {
    const parsed = ExternalStepSchema.parse(validSwipeStep);
    expect(parsed).toMatchObject({
      distancePercent: 0.6,
      durationMs: 300
    });
  });

  it("applies defaults for scrollTo maxSwipes, distancePercent, and durationMs", () => {
    const parsed = ExternalStepSchema.parse(validScrollToStep);
    expect(parsed).toMatchObject({
      maxSwipes: 20,
      distancePercent: 0.6,
      durationMs: 300
    });
  });

  it("rejects an unknown action", () => {
    expect(() => ExternalStepSchema.parse({
      action: "tap",
      locator: { resourceId: "x" },
      expectedActivity: "com.android.camera.CameraActivity"
    })).toThrow();
  });
});

describe("ExternalFlowSchema", () => {
  function validFlow(): unknown {
    return {
      version: 1,
      kind: "externalFlow",
      name: "camera/photo-capture",
      description: "Capture a photo using the default camera app",
      escapedPackageName: "com.android.camera",
      includes: [],
      steps: [
        {
          action: "click",
          locator: { resourceId: "shutter_button" },
          expectedActivity: "com.android.camera.CameraActivity"
        },
        {
          action: "wait",
          expectedActivity: "com.android.camera.CameraActivity"
        }
      ]
    };
  }

  it("parses a valid external flow", () => {
    const parsed = ExternalFlowSchema.parse(validFlow());
    expect(parsed.name).toBe("camera/photo-capture");
    expect(parsed.steps).toHaveLength(2);
  });

  it("accepts an optional expectedEscapeActivity", () => {
    expect(() => ExternalFlowSchema.parse({
      ...validFlow() as object,
      expectedEscapeActivity: "com.android.camera.CameraActivity"
    })).not.toThrow();
  });

  it("rejects an empty steps array", () => {
    expect(() => ExternalFlowSchema.parse({
      ...validFlow() as object,
      steps: []
    })).toThrow();
  });

  it("rejects an invalid escapedPackageName", () => {
    expect(() => ExternalFlowSchema.parse({
      ...validFlow() as object,
      escapedPackageName: "not-qualified"
    })).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => ExternalFlowSchema.parse({
      ...validFlow() as object,
      kind: "flow"
    })).toThrow();
  });

  it("rejects an unknown field", () => {
    expect(() => ExternalFlowSchema.parse({
      ...validFlow() as object,
      author: "agent"
    })).toThrow();
  });

  it("rejects a step with a non-deterministic locator", () => {
    expect(() => ExternalFlowSchema.parse({
      ...validFlow() as object,
      steps: [{
        action: "click",
        locator: { text: "Shutter" },
        expectedActivity: "com.android.camera.CameraActivity"
      }]
    })).toThrow();
  });

  it("accepts includes referencing other external flows", () => {
    expect(() => ExternalFlowSchema.parse({
      ...validFlow() as object,
      includes: ["camera/shared-focus"]
    })).not.toThrow();
  });
});
