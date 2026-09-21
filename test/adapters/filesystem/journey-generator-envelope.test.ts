import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const helper = join(
  repo,
  "assets",
  "skills",
  "taphound-journey-generator",
  "scripts",
  "envelope.mjs"
);
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map(
    (path) => rm(path, { recursive: true, force: true })
  ));
});

interface HelperOutput {
  status: string;
  code?: string;
  message?: string;
  action?: string;
  binding?: {
    generationId: string;
    baseRevision: number;
    snapshotHash: string;
  };
  snapshotSource?: string;
  path?: string;
  snapshotRef?: string;
}

function command(...args: string[]): {
  code: number;
  stdout: string;
  output: HelperOutput;
} {
  const result = spawnSync(process.execPath, [helper, ...args], {
    encoding: "utf8"
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    output: JSON.parse(result.stdout) as HelperOutput
  };
}

async function put(name: string, value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-envelope-"));
  created.push(root);
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

const snapshotHash = "a".repeat(64);
const snapshotRef
  = ".taphound/build/generations/.generation-1.work/evidence/snapshots/"
    + "revision-000006/2026-09-17T12-00-00-000Z/snapshot.json";

function observeOutput(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    status: "observed",
    exitCode: 0,
    generationId: "generation-1",
    baseRevision: 6,
    snapshotHash,
    snapshotRef,
    ...overrides
  };
}

function proposal(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    action: "click",
    locator: { resourceId: "search_button" },
    binding: {
      generationId: "generation-1",
      baseRevision: 6,
      snapshotHash
    },
    activity: { before: "com.example.app.MainActivity" },
    ...overrides
  };
}

function envelope(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    version: 1,
    proposal: proposal(),
    snapshotRef,
    ...overrides
  };
}

describe("journey-generator envelope helper", () => {
  it("prints help", () => {
    const result = spawnSync(process.execPath, [helper, "help"], {
      encoding: "utf8"
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("validate --input");
    expect(result.stdout).toContain("bind --input");
  });

  it("validates a reference-bound click envelope", () => {
    const result = command(
      "validate",
      "--input",
      "/tmp/unused.json"
    );
    expect(result.output.status).toBe("error");
    expect(result.output.code).toBe("ENVELOPE_IO");
  });

  it("accepts a valid envelope and reports its binding", async () => {
    const input = await put("envelope.json", envelope());
    const result = command("validate", "--input", input);
    expect(result.code).toBe(0);
    expect(result.output).toEqual({
      status: "valid",
      exitCode: 0,
      action: "click",
      binding: {
        generationId: "generation-1",
        baseRevision: 6,
        snapshotHash
      },
      snapshotSource: "reference"
    });
  });

  it("reports snapshotSource inline for a snapshot-bound envelope", async () => {
    const input = await put("envelope.json", {
      version: 1,
      proposal: proposal(),
      snapshot: {
        version: 1,
        generationId: "generation-1",
        baseRevision: 6,
        deviceSerial: "emulator-5554",
        expectedPackageName: "com.example.app",
        foregroundPackageName: "com.example.app",
        activity: "com.example.app.MainActivity",
        pid: 1234,
        capturedAt: "2026-09-17T12:00:00.000Z",
        layout: []
      }
    });
    const result = command("validate", "--input", input);
    expect(result.code).toBe(0);
    expect(result.output.snapshotSource).toBe("inline");
  });

  it("rejects an envelope with an unknown top-level field", async () => {
    const input = await put("envelope.json", {
      ...envelope(),
      extra: true
    });
    const result = command("validate", "--input", input);
    expect(result.code).toBe(2);
    expect(result.output.status).toBe("error");
    expect(result.output.code).toBe("ENVELOPE_INVALID");
    expect(result.output.message).toContain("unknown field");
  });

  it("names the expected fields when a known expect type gets a foreign field", async () => {
    const input = await put("envelope.json", envelope({
      proposal: proposal({
        expect: {
          type: "activity",
          locator: { resourceId: "search_button" }
        }
      })
    }));
    const result = command("validate", "--input", input);
    expect(result.code).toBe(2);
    expect(result.output.code).toBe("ENVELOPE_INVALID");
    expect(result.output.message).toContain('unknown field "locator"');
    expect(result.output.message).toContain(
      'expect.type "activity" allows fields: type, value, timeoutMs'
    );
  });

  it("names the expected fields when an action gets a foreign field", async () => {
    const input = await put("envelope.json", envelope({
      proposal: proposal({ durationMs: 500 })
    }));
    const result = command("validate", "--input", input);
    expect(result.code).toBe(2);
    expect(result.output.code).toBe("ENVELOPE_INVALID");
    expect(result.output.message).toContain(
      'action "click" allows fields: action, locator, binding, activity, expect'
    );
  });

  it("rejects an envelope that carries both snapshot and snapshotRef", async () => {
    const input = await put("envelope.json", {
      version: 1,
      proposal: proposal(),
      snapshot: { generationId: "generation-1", baseRevision: 6 },
      snapshotRef
    });
    const result = command("validate", "--input", input);
    expect(result.code).toBe(2);
    expect(result.output.code).toBe("ENVELOPE_INVALID");
    expect(result.output.message).toContain("exactly one of snapshot or snapshotRef");
  });

  it("rejects a locator without an identity field", async () => {
    const input = await put("envelope.json", {
      version: 1,
      proposal: proposal({ locator: { index: 0 } }),
      snapshotRef
    });
    const result = command("validate", "--input", input);
    expect(result.code).toBe(2);
    expect(result.output.message).toContain(
      "at least one of resourceId, text, or contentDescription"
    );
  });

  it("rejects a wait step that is missing activity", async () => {
    const input = await put("envelope.json", {
      version: 1,
      proposal: proposal({ action: "wait", locator: undefined, activity: undefined }),
      snapshotRef
    });
    const result = command("validate", "--input", input);
    expect(result.code).toBe(2);
    expect(result.output.message).toContain("missing required field");
  });

  it("rejects an absent expect combined with enabled", async () => {
    const input = await put("envelope.json", {
      version: 1,
      proposal: proposal({
        expect: {
          type: "element",
          locator: { resourceId: "progress" },
          absent: true,
          enabled: true,
          timeoutMs: 1000
        }
      }),
      snapshotRef
    });
    const result = command("validate", "--input", input);
    expect(result.code).toBe(2);
    expect(result.output.message).toContain("absent");
  });

  it("rejects an inline snapshot that contradicts the binding revision", async () => {
    const input = await put("envelope.json", {
      version: 1,
      proposal: proposal(),
      snapshot: {
        generationId: "generation-1",
        baseRevision: 5
      }
    });
    const result = command("validate", "--input", input);
    expect(result.code).toBe(2);
    expect(result.output.message).toContain("baseRevision does not match");
  });

  it("binds a proposal from an observe output without --out", async () => {
    const input = await put("proposal.json", {
      version: 1,
      proposal: {
        action: "wait",
        binding: {
          generationId: "stale",
          baseRevision: 1,
          snapshotHash: "0".repeat(64)
        },
        activity: { before: "com.example.app.MainActivity" }
      }
    });
    const from = await put("observe.json", observeOutput());
    const result = command("bind", "--input", input, "--from", from);
    expect(result.code).toBe(0);
    const bound = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(bound).toEqual(envelope({
      proposal: {
        action: "wait",
        binding: {
          generationId: "generation-1",
          baseRevision: 6,
          snapshotHash
        },
        activity: { before: "com.example.app.MainActivity" }
      }
    }));
  });

  it("binds from a step output nextBinding and writes the envelope to --out", async () => {
    const input = await put("proposal.json", {
      version: 1,
      proposal: {
        action: "click",
        locator: { text: "Search" },
        activity: { before: "com.example.app.MainActivity" }
      }
    });
    const from = await put("step.json", {
      status: "succeeded",
      exitCode: 0,
      generationId: "generation-1",
      revision: 8,
      stepIndex: 0,
      nextBinding: {
        generationId: "generation-1",
        baseRevision: 9,
        snapshotHash
      },
      nextSnapshotRef: snapshotRef
    });
    const out = join(await mkdtemp(join(tmpdir(), "taphound-envelope-out-")), "step.json");
    created.push(dirname(out));
    const result = command("bind", "--input", input, "--from", from, "--out", out);
    expect(result.code).toBe(0);
    expect(result.output.status).toBe("bound");
    expect(result.output.path).toBe(out);
    expect(result.output.binding).toEqual({
      generationId: "generation-1",
      baseRevision: 9,
      snapshotHash
    });
    const written = JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>;
    expect(written).toEqual({
      version: 1,
      proposal: {
        action: "click",
        locator: { text: "Search" },
        binding: {
          generationId: "generation-1",
          baseRevision: 9,
          snapshotHash
        },
        activity: { before: "com.example.app.MainActivity" }
      },
      snapshotRef
    });
    const validated = command("validate", "--input", out);
    expect(validated.code).toBe(0);
    expect(validated.output.status).toBe("valid");
  });

  it("rejects a bind source without usable binding fields", async () => {
    const input = await put("proposal.json", {
      version: 1,
      proposal: proposal({ binding: undefined })
    });
    const from = await put("bad.json", { status: "unrelated" });
    const result = command("bind", "--input", input, "--from", from);
    expect(result.code).toBe(2);
    expect(result.output.code).toBe("ENVELOPE_INVALID");
  });

  it("rejects unknown commands", () => {
    const result = command("nope");
    expect(result.code).toBe(2);
    expect(result.output.code).toBe("ENVELOPE_USAGE");
  });
});
