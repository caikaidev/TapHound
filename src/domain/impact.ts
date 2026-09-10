import { z } from "zod";

import { KnowledgeIdSchema } from "./knowledge.js";
import { ProjectRelativePathSchema } from "./project-context.js";

export const ChangedFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed"
]);

export const ChangedFileSchema = z.strictObject({
  path: ProjectRelativePathSchema,
  status: ChangedFileStatusSchema,
  oldPath: ProjectRelativePathSchema.optional()
}).superRefine((file, context) => {
  if (file.status === "renamed" && file.oldPath === undefined) {
    context.addIssue({
      code: "custom",
      path: ["oldPath"],
      message: "A renamed file must declare its old path"
    });
  }
  if (file.oldPath === file.path) {
    context.addIssue({
      code: "custom",
      path: ["oldPath"],
      message: "A renamed file cannot keep its own path"
    });
  }
});

export const ChangeSetSchema = z.strictObject({
  version: z.literal(1),
  base: z.string().trim().min(1),
  head: z.string().trim().min(1),
  files: z.array(ChangedFileSchema).min(1)
}).superRefine((changeSet, context) => {
  const allPaths = new Set<string>();
  for (const [index, file] of changeSet.files.entries()) {
    const candidates = [
      file.path,
      ...(file.oldPath === undefined ? [] : [file.oldPath])
    ];
    for (const path of candidates) {
      if (allPaths.has(path)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: `ChangeSet path ${path} appears more than once`
        });
      }
      allPaths.add(path);
    }
  }
});

export const JourneySelectionSchema = z.strictObject({
  id: z.string().trim().min(1),
  reason: z.string().trim().min(1)
});

export const ImpactSetSchema = z.strictObject({
  version: z.literal(1),
  base: z.string().trim().min(1),
  head: z.string().trim().min(1),
  affectedModules: z.array(KnowledgeIdSchema),
  affectedFeatures: z.array(z.string().trim().min(1)),
  affectedScreens: z.array(KnowledgeIdSchema),
  affectedAnchors: z.array(KnowledgeIdSchema),
  affectedTransitions: z.array(KnowledgeIdSchema),
  selectedJourneys: z.strictObject({
    p0: z.array(JourneySelectionSchema),
    p1: z.array(JourneySelectionSchema),
    p2: z.array(JourneySelectionSchema)
  }),
  skippedJourneys: z.array(JourneySelectionSchema),
  provenance: z.strictObject({
    contextHash: z.string().regex(/^[a-f\d]{64}$/),
    knowledgeHash: z.string().regex(/^[a-f\d]{64}$/)
  })
});

export type ChangeSet = z.infer<typeof ChangeSetSchema>;
export type ChangedFile = z.infer<typeof ChangedFileSchema>;
export type ImpactSet = z.infer<typeof ImpactSetSchema>;
export type JourneySelection = z.infer<typeof JourneySelectionSchema>;