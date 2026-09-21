import { describe, expect, it } from "vitest";

import { WorkflowManifestSchema } from "../../src/domain/workflow-manifest.js";
import {
  WORKFLOWS_DIR,
  workflowManifestPath
} from "../../src/domain/workspace.js";

const sha = "a".repeat(64);

interface CommonCaseFields {
  version: number;
  diffs: {
    implementation: { path: string; sha256: string };
    verificationAssets: { path: string; sha256: string };
  };
  bindings: {
    journeySha256: string;
    replayPolicy: { metaPath: string; sha256: string; strict: boolean };
    diffScope: { used: boolean; base: string; head: string; tiers: string[] };
  };
  commands: { argv: string[]; exitCode: number; jsonResultPath: string }[];
  status: string;
}

const common = (id: string): CommonCaseFields => ({
  version: 1,
  diffs: {
    implementation: { path: `${WORKFLOWS_DIR}/${id}/impl.diff`, sha256: sha },
    verificationAssets: { path: `${WORKFLOWS_DIR}/${id}/assets.diff`, sha256: sha }
  },
  bindings: {
    journeySha256: sha,
    replayPolicy: {
      metaPath: "journeys/case.meta.json", sha256: sha, strict: true
    },
    diffScope: {
      used: true, base: "main", head: "WORKTREE", tiers: ["p0", "p1", "p2"]
    }
  },
  commands: [{
    argv: ["taphound", "verify", "--json"],
    exitCode: 0,
    jsonResultPath: `${WORKFLOWS_DIR}/${id}/verify-result.json`
  }],
  status: "PASS"
});

describe("Workflow manifest", () => {
  it("derives Case paths only under the ephemeral build workspace", () => {
    expect(workflowManifestPath("mixed-accept")).toBe(
      `${WORKFLOWS_DIR}/mixed-accept/manifest.json`
    );
    expect(() => workflowManifestPath("../generations")).toThrow(/safe lowercase/);
    expect(() => workflowManifestPath("Case A")).toThrow(/safe lowercase/);
  });

  it("keeps mixed Accept and Preserve Cases independent and reconstructible", () => {
    const accept = WorkflowManifestSchema.parse({
      ...common("mixed-accept"),
      case: {
        id: "mixed-accept", path: "accept",
        requirement: { sourceRef: "tickets/change", summarySha256: sha }
      },
      bindings: { ...common("mixed-accept").bindings,
        contractSha256: sha, knowledgeHash: sha },
      evidence: {
        reportPath: "runs/accept/report.json",
        verdictPath: "runs/accept/verdict.json"
      },
      outcome: { path: "accept", verdict: "pass" }
    });
    const preserve = WorkflowManifestSchema.parse({
      ...common("mixed-preserve"),
      case: {
        id: "mixed-preserve", path: "preserve",
        requirement: { sourceRef: "tickets/change", summarySha256: sha }
      },
      evidence: {
        beforeReportPath: "runs/before/report.json",
        reportPath: "runs/after/report.json",
        baselinePath: "baselines/original.json",
        compareResultPath: "build/compare-result.json"
      },
      outcome: { path: "preserve", equivalent: true }
    });
    expect(accept.status).toBe("PASS");
    expect(preserve.status).toBe("PASS");
    expect(accept.case.id).not.toBe(preserve.case.id);
    expect(accept.bindings.diffScope.tiers).toEqual(["p0", "p1", "p2"]);
    expect(JSON.stringify([accept, preserve])).not.toContain("private-request-token");
  });

  it("refuses an invalid success and records a reason for PAUSED", () => {
    const acceptCase = {
      ...common("accept"),
      case: {
        id: "accept", path: "accept",
        requirement: { sourceRef: "request", summarySha256: sha }
      },
      evidence: { reportPath: "runs/report.json" },
      outcome: { path: "accept", verdict: "fail" }
    };
    expect(() => WorkflowManifestSchema.parse(acceptCase)).toThrow(/Accept PASS/);
    expect(() => WorkflowManifestSchema.parse({
      ...acceptCase,
      commands: [{
        ...common("accept").commands[0],
        argv: ["taphound", "verify"],
        exitCode: 0,
        jsonResultPath: `${WORKFLOWS_DIR}/accept/../generations/private.json`
      }]
    })).toThrow(/Case build directory/);
    expect(() => WorkflowManifestSchema.parse({
      ...acceptCase, status: "PAUSED"
    })).toThrow(/Paused Case/);
    expect(WorkflowManifestSchema.parse({
      ...acceptCase, status: "PAUSED",
      pauseReason: "Pre-change evidence unavailable"
    }).status).toBe("PAUSED");
    expect(() => WorkflowManifestSchema.parse({
      ...acceptCase, bindings: {
        ...common("accept").bindings,
        replayPolicy: { ...common("accept").bindings.replayPolicy, strict: false },
        contractSha256: sha
      },
      outcome: { path: "accept", verdict: "pass" },
      evidence: { reportPath: "runs/report.json", verdictPath: "runs/verdict.json" }
    })).toThrow(/strict Replay/);
  });
});
