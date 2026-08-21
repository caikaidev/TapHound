import { z } from "zod";

import { JourneyStepSchema } from "./journey.js";
import { ProjectRelativePathSchema } from "./project-context.js";
import {
  JOURNEYS_DIR,
  JOURNEY_SOURCES_DIR
} from "./workspace.js";

export const FlowNameSchema = z.string().trim().min(1).superRefine(
  (name, context) => {
    if (
      name.includes("\\")
      || name.startsWith("/")
      || name.endsWith("/")
      || /^[A-Za-z]:/.test(name)
      || name.split("/").some(
        (segment) => (
          segment.length === 0
          || segment === "."
          || segment === ".."
          || !/^[A-Za-z\d](?:[A-Za-z\d._-]*[A-Za-z\d])?$/.test(segment)
        )
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Flow name must be a safe slash-separated identifier"
      });
    }
  }
);

export const JourneySourcePathSchema = ProjectRelativePathSchema.refine(
  (path) => (
    path.startsWith(`${JOURNEY_SOURCES_DIR}/`)
    && path.endsWith(".json")
    && path.split("/").every(
      (segment) => segment.length > 0 && segment !== "."
    )
  ),
  `Journey source must be a normalized JSON file under ${JOURNEY_SOURCES_DIR}`
);

export const ResolvedJourneyPathSchema = ProjectRelativePathSchema.refine(
  (path) => (
    path.startsWith(`${JOURNEYS_DIR}/`)
    && path.endsWith(".json")
    && !path.endsWith(".resolve.json")
    && path.split("/").every(
      (segment) => segment.length > 0 && segment !== "."
    )
  ),
  `Resolved Journey must be a normalized JSON file under ${JOURNEYS_DIR}`
);

const IncludesSchema = z.array(FlowNameSchema).superRefine(
  (includes, context) => {
    const names = new Set<string>();
    for (const [index, name] of includes.entries()) {
      if (names.has(name)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Flow includes must be unique"
        });
      }
      names.add(name);
    }
  }
);

export const FlowSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("flow"),
  name: FlowNameSchema,
  includes: IncludesSchema,
  steps: z.array(JourneyStepSchema).min(1)
});

export const JourneySourceSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("journeySource"),
  name: z.string().trim().min(1),
  includes: IncludesSchema,
  steps: z.array(JourneyStepSchema).min(1)
});

const Sha256Schema = z.string().regex(/^[a-f\d]{64}$/);

export const JourneyResolutionDependencySchema = z.strictObject({
  name: FlowNameSchema,
  path: ProjectRelativePathSchema,
  sha256: Sha256Schema,
  stepCount: z.number().int().positive()
});

export const JourneyResolutionManifestSchema = z.strictObject({
  version: z.literal(1),
  source: z.strictObject({
    path: ProjectRelativePathSchema,
    sha256: Sha256Schema
  }),
  flows: z.array(JourneyResolutionDependencySchema),
  expansion: z.array(FlowNameSchema),
  journey: z.strictObject({
    name: z.string().trim().min(1),
    sha256: Sha256Schema,
    stepCount: z.number().int().positive()
  }),
  resolutionSha256: Sha256Schema
}).superRefine((manifest, context) => {
  if (
    manifest.flows.length !== manifest.expansion.length
    || manifest.flows.some(
      (flow, index) => flow.name !== manifest.expansion[index]
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["expansion"],
      message: "Flow dependencies must align with expansion order"
    });
  }
});

export type Flow = z.infer<typeof FlowSchema>;
export type JourneySource = z.infer<typeof JourneySourceSchema>;
export type JourneyResolutionManifest = z.infer<
  typeof JourneyResolutionManifestSchema
>;
