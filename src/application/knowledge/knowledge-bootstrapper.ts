import { createHash } from "node:crypto";

import {
  AnchorDefinitionSchema,
  ScreenDefinitionSchema,
  TransitionDefinitionSchema,
  type AnchorDefinition,
  type ScreenDefinition,
  type TransitionDefinition
} from "../../domain/knowledge.js";
import type {
  ProjectContextModule
} from "../../domain/project-context.js";
import type {
  KnowledgeRegistryPort,
  WriteKnowledgeBundleResult
} from "../../ports/knowledge-registry.js";

function stableId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length > 0 && normalized.length <= 120) return normalized;
  return `knowledge-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function locatorKey(locator: {
  resourceId?: string | undefined;
  text?: string | undefined;
  contentDescription?: string | undefined;
}): string {
  return JSON.stringify(locator);
}

export class KnowledgeBootstrapper {
  public constructor(
    private readonly registry: Pick<KnowledgeRegistryPort, "writePromoted">
  ) {}

  public readonly bootstrap = async (input: {
    projectRoot: string;
    packageName: string;
    modules: readonly ProjectContextModule[];
    expectedKnowledgeHash?: string | undefined;
  }): Promise<WriteKnowledgeBundleResult> => {
    const anchors = new Map<string, AnchorDefinition>();
    const anchorsByScreenAndLocator = new Map<string, string>();
    const screens = new Map<string, ScreenDefinition>();

    for (const module of input.modules) {
      const activitiesByScreen = new Map<string, string[]>();
      for (const activity of module.summary.activities) {
        for (const screen of activity.screens) {
          const values = activitiesByScreen.get(screen) ?? [];
          values.push(activity.name);
          activitiesByScreen.set(screen, values);
        }
      }
      for (const [rawScreen, activities] of activitiesByScreen) {
        const screenId = stableId(rawScreen);
        const anchorIds: string[] = [];
        for (const element of module.summary.elements.filter(
          (candidate) => candidate.screen === rawScreen
        )) {
          const locator = {
            ...(element.resourceId === undefined
              ? {}
              : { resourceId: element.resourceId }),
            ...(element.text === undefined ? {} : { text: element.text }),
            ...(element.contentDescription === undefined
              ? {}
              : { contentDescription: element.contentDescription })
          };
          const suffix = createHash("sha256")
            .update(locatorKey(locator))
            .digest("hex")
            .slice(0, 10);
          const anchorId = stableId(`${screenId}-${suffix}`);
          anchors.set(anchorId, AnchorDefinitionSchema.parse({
            version: 1,
            id: anchorId,
            status: "inferred",
            roles: [
              "screenIdentity",
              ...(element.actions.some(
                (action) => action !== "wait" && action !== "inputText"
              ) ? ["actionable" as const] : [])
            ],
            identity: { kind: "element", locator },
            description: `Bootstrapped from Project Context screen ${rawScreen}`
          }));
          anchorsByScreenAndLocator.set(
            `${rawScreen}\0${locatorKey(locator)}`,
            anchorId
          );
          anchorIds.push(anchorId);
        }
        const activity = [...new Set(activities)].sort()[0];
        if (activity !== undefined) {
          const activityAnchorId = stableId(`${screenId}-activity`);
          anchors.set(activityAnchorId, AnchorDefinitionSchema.parse({
            version: 1,
            id: activityAnchorId,
            status: "inferred",
            roles: ["screenIdentity"],
            identity: { kind: "activity", activity }
          }));
          anchorIds.push(activityAnchorId);
        }
        if (anchorIds.length > 0) {
          screens.set(screenId, ScreenDefinitionSchema.parse({
            version: 1,
            id: screenId,
            status: "inferred",
            requiredAnchors: [...new Set(anchorIds)],
            optionalAnchors: [],
            forbiddenAnchors: [],
            predicates: activity === undefined
              ? []
              : [{ kind: "activityIs", activity }],
            description: `Bootstrapped from Project Context screen ${rawScreen}`
          }));
        }
      }
    }

    const screenByActivity = new Map<string, string[]>();
    for (const module of input.modules) {
      for (const activity of module.summary.activities) {
        const ids = activity.screens
          .map(stableId)
          .filter((id) => screens.has(id));
        screenByActivity.set(activity.name, [
          ...new Set([...(screenByActivity.get(activity.name) ?? []), ...ids])
        ]);
      }
    }
    const transitions: TransitionDefinition[] = [];
    for (const module of input.modules) {
      for (const transition of module.summary.transitions) {
        const from = screenByActivity.get(transition.fromActivity) ?? [];
        const to = screenByActivity.get(transition.toActivity) ?? [];
        if (from.length !== 1 || to.length !== 1) continue;
        const locator = transition.actionResourceId === undefined
          ? { text: transition.actionText as string }
          : { resourceId: transition.actionResourceId };
        const anchorId = anchorsByScreenAndLocator.get(
          `${module.summary.activities
            .find((activity) => activity.name === transition.fromActivity)
            ?.screens[0] ?? ""}\0${locatorKey(locator)}`
        ) ?? stableId(`${from[0] as string}-transition-${
          createHash("sha256").update(locatorKey(locator)).digest("hex").slice(0, 10)
        }`);
        if (!anchors.has(anchorId)) {
          anchors.set(anchorId, AnchorDefinitionSchema.parse({
            version: 1,
            id: anchorId,
            status: "inferred",
            roles: ["actionable"],
            identity: { kind: "element", locator }
          }));
        }
        const id = stableId(`${from[0] as string}-to-${to[0] as string}-${anchorId}`);
        transitions.push(TransitionDefinitionSchema.parse({
          version: 1,
          id,
          status: "inferred",
          fromScreen: from[0],
          toScreen: to[0],
          semantic: stableId(`open-${to[0] as string}`),
          action: { action: "click", anchorId },
          verification: {
            targetScreen: to[0],
            timeoutMs: 5000
          },
          observations: { attempts: 0, successes: 0, recoveryCost: 0 }
        }));
      }
    }

    return this.registry.writePromoted({
      projectRoot: input.projectRoot,
      packageName: input.packageName,
      ...(input.expectedKnowledgeHash === undefined
        ? {}
        : { expectedKnowledgeHash: input.expectedKnowledgeHash }),
      anchors: [...anchors.values()],
      screens: [...screens.values()],
      transitions
    });
  };
}
