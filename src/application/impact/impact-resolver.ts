import { createHash } from "node:crypto";

import {
  ImpactSetSchema,
  type ChangeSet,
  type ImpactSet,
  type JourneySelection
} from "../../domain/impact.js";
import type { Journey } from "../../domain/journey.js";
import type {
  ProjectContextModule,
  ResolvedProjectContext
} from "../../domain/project-context.js";
import type {
  LoadedKnowledgeBundle
} from "../../ports/knowledge-registry.js";

export interface ImpactResolverDependencies {
  loadContext: (input: {
    projectRoot: string;
    workspaceRoot?: string | undefined;
  }) => Promise<{
    context: ResolvedProjectContext;
    modules: ProjectContextModule[];
  }>;
  loadKnowledge: (input: {
    projectRoot: string;
    workspaceRoot?: string | undefined;
    packageName: string;
  }) => Promise<LoadedKnowledgeBundle>;
  listJourneyPaths: (input: {
    projectRoot: string;
    workspaceRoot?: string | undefined;
  }) => Promise<readonly string[]>;
  readJourney: (input: {
    projectRoot: string;
    workspaceRoot?: string | undefined;
    path: string;
  }) => Promise<Journey | null>;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function contextEvidenceHash(
  context: ResolvedProjectContext,
  modules: readonly ProjectContextModule[]
): string {
  const canonicalModules = modules
    .map((module) => ({
      moduleId: module.moduleId,
      projectDir: module.projectDir,
      inventory: module.inventory,
      manifest: module.manifest
    }))
    .sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  const canonical = JSON.stringify({
    selection: context.selection,
    modules: canonicalModules
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function journeyAnchorIds(journey: Journey): string[] {
  return journey.steps
    .map((step) => ("anchor" in step && step.anchor !== undefined ? step.anchor : undefined))
    .filter((id): id is string => id !== undefined);
}

function moduleForChangedFiles(
  modules: readonly ProjectContextModule[],
  changeSet: ChangeSet
): string[] {
  const changed = changeSet.files.flatMap((file) => [
    file.path,
    ...(file.oldPath === undefined ? [] : [file.oldPath])
  ]);
  const result: string[] = [];
  for (const module of modules) {
    const evidencePaths = new Set(
      module.manifest.files.map((file) => file.path)
    );
    const touched = changed.some((path) => (
      evidencePaths.has(path)
      || (
        module.projectDir !== "."
        && path.startsWith(`${module.projectDir}/`)
      )
    ));
    if (touched) {
      result.push(module.moduleId);
    }
  }
  return result;
}

export class ImpactResolver {
  public constructor(
    private readonly dependencies: ImpactResolverDependencies
  ) {}

  public readonly resolve = async (input: {
    projectRoot: string;
    workspaceRoot?: string | undefined;
    packageName: string;
    changeSet: ChangeSet;
  }): Promise<ImpactSet> => {
    const { projectRoot, packageName, changeSet } = input;
    const workspaceRoot = input.workspaceRoot;
    const [context, knowledge, journeyPaths] = await Promise.all([
      this.dependencies.loadContext({
        projectRoot,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot })
      }),
      this.dependencies.loadKnowledge({
        projectRoot,
        packageName,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot })
      }),
      this.dependencies.listJourneyPaths({
        projectRoot,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot })
      })
    ]);
    const contextModules = context.modules;
    const changedPathSet = new Set(
      changeSet.files.flatMap((file) => [
        file.path,
        ...(file.oldPath === undefined ? [] : [file.oldPath])
      ])
    );

    const affectedModules = unique(
      moduleForChangedFiles(contextModules, changeSet)
    );
    const affectedAnchors = unique(
      knowledge.anchors
        .filter((anchor) => (
          (anchor.sourceFiles ?? []).some((path) => changedPathSet.has(path))
        ))
        .map((anchor) => anchor.id)
    );
    const affectedAnchorsSet = new Set(affectedAnchors);
    const affectedScreens = unique(
      knowledge.screens
        .filter((screen) => (
          (screen.sourceFiles ?? []).some((path) => changedPathSet.has(path))
          || screen.requiredAnchors.some((id) => affectedAnchorsSet.has(id))
          || screen.optionalAnchors.some((id) => affectedAnchorsSet.has(id))
          || screen.forbiddenAnchors.some((id) => affectedAnchorsSet.has(id))
          || screen.predicates.some((predicate) => (
            "anchorId" in predicate
            && affectedAnchorsSet.has(predicate.anchorId)
          ))
        ))
        .map((screen) => screen.id)
    );
    const affectedScreensSet = new Set(affectedScreens);
    const affectedTransitions = unique(
      knowledge.transitions
        .filter((transition) => (
          (transition.sourceFiles ?? []).some((path) => changedPathSet.has(path))
          || affectedScreensSet.has(transition.fromScreen)
          || affectedScreensSet.has(transition.toScreen)
          || (
            "anchorId" in transition.action
            && affectedAnchorsSet.has(transition.action.anchorId)
          )
        ))
        .map((transition) => transition.id)
    );

    const affectedModulesSet = new Set(affectedModules);
    const affectedFeatures = unique(
      contextModules
        .filter((module) => affectedModulesSet.has(module.moduleId))
        .flatMap((module) => module.summary.features)
    );

    const p0: JourneySelection[] = [];
    const p1: JourneySelection[] = [];
    const p2: JourneySelection[] = [];
    const skipped: JourneySelection[] = [];
    for (const path of journeyPaths) {
      const journey = await this.dependencies.readJourney({
        projectRoot,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        path
      });
      if (journey === null) {
        continue;
      }
      const anchorsInJourney = journeyAnchorIds(journey);
      const directAnchor = anchorsInJourney.find((id) => (
        affectedAnchorsSet.has(id)
      ));
      if (directAnchor !== undefined) {
        p0.push({
          id: path,
          reason: `journey resolves affected Knowledge anchor ${directAnchor}`
        });
        continue;
      }
      const affectedAnchorByScreen = anchorsInJourney.find((id) => (
        knowledge.screens.some((screen) => (
          affectedScreensSet.has(screen.id)
          && (
            screen.requiredAnchors.includes(id)
            || screen.optionalAnchors.includes(id)
            || screen.forbiddenAnchors.includes(id)
          )
        ))
      ));
      if (affectedAnchorByScreen !== undefined) {
        p1.push({
          id: path,
          reason: `journey anchors share a screen with the affected change ${affectedAnchorByScreen}`
        });
        continue;
      }
      if (anchorsInJourney.length === 0) {
        if (affectedModules.length > 0) {
          p1.push({
            id: path,
            reason: "affected module requires conservative coverage for a locator-only journey"
          });
        } else {
          skipped.push({
            id: path,
            reason: "journey uses only runtime locators; no semantic anchor binding"
          });
        }
        continue;
      }
      if (affectedModules.length > 0) {
        p1.push({
          id: path,
          reason: "affected module requires conservative semantic journey coverage"
        });
        continue;
      }
      p2.push({
        id: path,
        reason: "journey anchors do not resolve affected anchor/screen ids"
      });
    }

    return ImpactSetSchema.parse({
      version: 1,
      base: changeSet.base,
      head: changeSet.head,
      affectedModules,
      affectedFeatures,
      affectedScreens,
      affectedAnchors,
      affectedTransitions,
      selectedJourneys: { p0, p1, p2 },
      skippedJourneys: skipped,
      provenance: {
        contextHash: contextEvidenceHash(context.context, contextModules),
        knowledgeHash: knowledge.knowledgeHash
      }
    });
  };
}