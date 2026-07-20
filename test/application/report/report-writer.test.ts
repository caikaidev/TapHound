import {
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSystemArtifactStore } from "../../../src/adapters/filesystem/artifact-store.js";
import { ReportWriter } from "../../../src/application/report/report-writer.js";
import { validReport } from "../../fixtures/report.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-report-test-"));
  roots.push(root);
  return root;
}

describe("ReportWriter", () => {
  it("writes JSON and human summary before publishing", async () => {
    const root = await temporaryRoot();
    const session = await new FileSystemArtifactStore().begin(root, "run-123");
    await session.writeText("logcat.txt", "logs");
    const report = validReport({
      artifacts: {
        ...validReport().artifacts,
        directory: session.finalDirectory
      }
    });

    const result = await new ReportWriter().writeAndPublish(session, report);

    expect(result.directory).toBe(join(root, "run-123"));
    await expect(readFile(join(result.directory, "report.json"), "utf8"))
      .resolves.toContain('"schemaVersion": 1');
    await expect(readFile(join(result.directory, "summary.txt"), "utf8"))
      .resolves.toContain("TapHound run run-123: PASSED");
  });

  it("includes primary and secondary failures in the summary", async () => {
    const root = await temporaryRoot();
    const session = await new FileSystemArtifactStore().begin(root, "run-failed");
    const report = validReport({
      runId: "run-failed",
      status: "failed",
      artifacts: {
        ...validReport().artifacts,
        directory: session.finalDirectory
      },
      primaryFailure: {
        code: "LOCATOR_NOT_FOUND",
        message: "missing",
        phase: "replay",
        stepIndex: 0
      },
      secondaryErrors: [{
        code: "COLLECTION_FAILED",
        message: "screenshot missing",
        phase: "collection"
      }]
    });

    const result = await new ReportWriter().writeAndPublish(session, report);
    const summary = await readFile(join(result.directory, "summary.txt"), "utf8");

    expect(summary).toContain("LOCATOR_NOT_FOUND: missing");
    expect(summary).toContain("COLLECTION_FAILED: screenshot missing");
  });
});
