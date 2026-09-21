import { z } from "zod";
import { posix } from "node:path";
import { WORKFLOWS_DIR } from "./workspace.js";

const DigestSchema = z.string().regex(/^[a-f\d]{64}$/);
const ArtifactRefSchema = z.string().trim().min(1);

const DiffReferenceSchema = z.strictObject({
  path: ArtifactRefSchema,
  sha256: DigestSchema
});

export const WorkflowManifestSchema = z.strictObject({
  version: z.literal(1),
  case: z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    path: z.enum(["accept", "preserve"]),
    requirement: z.strictObject({
      sourceRef: ArtifactRefSchema,
      summarySha256: DigestSchema
    })
  }),
  diffs: z.strictObject({
    implementation: DiffReferenceSchema,
    verificationAssets: DiffReferenceSchema
  }),
  bindings: z.strictObject({
    journeySha256: DigestSchema,
    contractSha256: DigestSchema.optional(),
    knowledgeHash: DigestSchema.optional(),
    replayPolicy: z.strictObject({
      metaPath: ArtifactRefSchema,
      sha256: DigestSchema,
      strict: z.boolean()
    }).optional(),
    diffScope: z.strictObject({
      used: z.boolean(),
      base: z.string().trim().min(1).optional(),
      head: z.string().trim().min(1).optional(),
      tiers: z.array(z.enum(["p0", "p1", "p2"]))
    }).superRefine((scope, context) => {
      if (scope.used && (scope.base === undefined || scope.tiers.length === 0)) {
        context.addIssue({
          code: "custom", message: "Used diff scope requires base and selected tiers"
        });
      }
    })
  }),
  commands: z.array(z.strictObject({
    argv: z.array(z.string().min(1)).min(1),
    exitCode: z.number().int().nonnegative(),
    jsonResultPath: ArtifactRefSchema
  })),
  evidence: z.strictObject({
    beforeReportPath: ArtifactRefSchema.optional(),
    reportPath: ArtifactRefSchema.optional(),
    verdictPath: ArtifactRefSchema.optional(),
    baselinePath: ArtifactRefSchema.optional(),
    compareResultPath: ArtifactRefSchema.optional()
  }),
  outcome: z.discriminatedUnion("path", [
    z.strictObject({
      path: z.literal("accept"),
      verdict: z.enum(["pass", "fail", "inconclusive", "needsReview", "invalid"])
        .optional()
    }),
    z.strictObject({
      path: z.literal("preserve"),
      equivalent: z.boolean().optional()
    })
  ]),
  status: z.enum(["PASS", "FAIL", "PAUSED"]),
  pauseReason: z.string().trim().min(1).optional()
}).superRefine((manifest, context) => {
  const caseDir = `${WORKFLOWS_DIR}/${manifest.case.id}/`;
  const insideCase = (path: string): boolean => path.startsWith(caseDir)
    && !path.includes("\\")
    && !path.startsWith("/")
    && posix.normalize(path) === path;
  for (const [index, command] of manifest.commands.entries()) {
    if (!insideCase(command.jsonResultPath)) {
      context.addIssue({
        code: "custom", path: ["commands", index, "jsonResultPath"],
        message: "Command JSON must stay in the Case build directory"
      });
    }
  }
  for (const kind of ["implementation", "verificationAssets"] as const) {
    if (!insideCase(manifest.diffs[kind].path)) {
      context.addIssue({
        code: "custom", path: ["diffs", kind, "path"],
        message: "Diff evidence must stay in the Case build directory"
      });
    }
  }
  if (manifest.case.path !== manifest.outcome.path) {
    context.addIssue({ code: "custom", path: ["outcome"], message: "Outcome path must match Case" });
  }
  if (manifest.status === "PAUSED" && manifest.pauseReason === undefined) {
    context.addIssue({ code: "custom", path: ["pauseReason"], message: "Paused Case needs a reason" });
  }
  if (manifest.status !== "PASS") return;
  if (manifest.evidence.reportPath === undefined
    || manifest.commands.length === 0
    || manifest.commands.some((command) => command.exitCode !== 0)) {
    context.addIssue({
      code: "custom", path: ["status"],
      message: "PASS needs a report and successful recorded commands"
    });
  }
  if (manifest.bindings.replayPolicy?.strict !== true) {
    context.addIssue({
      code: "custom", path: ["bindings", "replayPolicy"],
      message: "PASS requires a bound strict Replay policy"
    });
  }
  if (manifest.case.path === "accept") {
    if (manifest.outcome.path !== "accept"
      || manifest.outcome.verdict !== "pass"
      || manifest.evidence.verdictPath === undefined
      || manifest.bindings.contractSha256 === undefined) {
      context.addIssue({
        code: "custom", path: ["status"],
        message: "Accept PASS needs a bound passing Contract Verdict"
      });
    }
  } else if (manifest.outcome.path !== "preserve"
    || manifest.outcome.equivalent !== true
    || manifest.evidence.beforeReportPath === undefined
    || manifest.evidence.baselinePath === undefined
    || manifest.evidence.compareResultPath === undefined) {
    context.addIssue({
      code: "custom", path: ["status"],
      message: "Preserve PASS needs a Baseline and equivalent comparison"
    });
  }
});

export type WorkflowManifest = z.infer<typeof WorkflowManifestSchema>;
