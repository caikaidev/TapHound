import { describe, expect, it, vi } from "vitest";

import { ExternalFlowResolver } from "../../../src/application/journey/external-flow-resolver.js";
import type {
  ExternalFlowCatalogEntry,
  ExternalFlowRecord
} from "../../../src/ports/external-flow-registry.js";

function mockRecord(
  overrides: Partial<ExternalFlowRecord> = {}
): ExternalFlowRecord {
  return {
    bytes: Buffer.from("{}"),
    flow: {
      version: 1,
      kind: "externalFlow",
      name: "test/click-ok",
      description: "Test flow",
      escapedPackageName: "com.example.external",
      expectedEscapeActivity: "com.example.external.MainActivity",
      includes: [],
      steps: [
        {
          action: "click",
          locator: { resourceId: "com.example.external:id/ok" },
          expectedActivity: "com.example.external.MainActivity"
        }
      ]
    },
    source: "project",
    path: ".taphound/flows/external/test/click-ok.json",
    ...overrides
  };
}

describe("ExternalFlowResolver", () => {
  it("resolves a flow and returns its sha256 and step count", async () => {
    const bytes = Buffer.from(
      `${JSON.stringify({
        version: 1,
        kind: "externalFlow",
        name: "test/click-ok",
        description: "Test flow",
        escapedPackageName: "com.example.external",
        expectedEscapeActivity: "com.example.external.MainActivity",
        includes: [],
        steps: [
          {
            action: "click",
            locator: { resourceId: "com.example.external:id/ok" },
            expectedActivity: "com.example.external.MainActivity"
          }
        ]
      }, null, 2)}\n`
    );
    const read = vi.fn(() => Promise.resolve(mockRecord({ bytes })));
    const resolver = new ExternalFlowResolver({
      registry: { read, list: vi.fn() }
    });

    const result = await resolver.resolve({
      projectRoot: "/project",
      name: "test/click-ok"
    });

    expect(read).toHaveBeenCalledWith({
      projectRoot: "/project",
      name: "test/click-ok"
    });
    expect(result.flow.name).toBe("test/click-ok");
    expect(result.stepCount).toBe(1);
    expect(result.flowSha256).toMatch(/^[a-f\d]{64}$/);
  });

  it("rejects a flow with non-empty includes", async () => {
    const record = mockRecord({
      flow: {
        ...mockRecord().flow,
        includes: ["other-flow"]
      }
    });
    const resolver = new ExternalFlowResolver({
      registry: { read: vi.fn(() => Promise.resolve(record)), list: vi.fn() }
    });

    await expect(resolver.resolve({
      projectRoot: "/project",
      name: "test/click-ok"
    })).rejects.toThrow(/includes.*not supported/i);
  });

  it("delegates list to the registry", async () => {
    const entries: ExternalFlowCatalogEntry[] = [
      {
        name: "camera/photo-capture",
        source: "builtin",
        path: "assets/external-flows/camera/photo-capture.json",
        status: "valid",
        escapedPackageName: "com.android.camera2",
        stepCount: 2
      }
    ];
    const list = vi.fn(() => Promise.resolve(entries));
    const resolver = new ExternalFlowResolver({
      registry: { read: vi.fn(), list }
    });

    const result = await resolver.list("/project");

    expect(list).toHaveBeenCalledWith("/project");
    expect(result).toEqual(entries);
  });
});
