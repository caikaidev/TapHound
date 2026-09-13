import type { LoadedKnowledgeBundle } from "../../ports/knowledge-registry.js";
import type { TransitionDefinition } from "../../domain/knowledge.js";
import {
  FeatureMapProjectionSchema,
  type FeatureMapAnchorEntry,
  type FeatureMapFeature,
  type FeatureMapProjection,
  type FeatureMapScreenEntry,
  type FeatureMapTransitionEntry
} from "../../domain/feature-map.js";

export interface FeatureMapProjectorDependencies {
  now?: (() => Date) | undefined;
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function transitionAnchorId(
  transition: TransitionDefinition
): string | undefined {
  if (transition.action.action === "inputText") {
    return undefined;
  }
  return "anchorId" in transition.action
    ? transition.action.anchorId
    : undefined;
}

function actionLabel(transition: TransitionDefinition): string {
  const { action } = transition.action;
  if (action === "click") {
    return `click(anchor=${transition.action.anchorId})`;
  }
  if (action === "longClick") {
    return `longClick(anchor=${transition.action.anchorId})`;
  }
  if (action === "swipe") {
    return `swipe(anchor=${transition.action.anchorId})`;
  }
  if (action === "inputText") {
    return `inputText(parameter=${transition.action.parameter})`;
  }
  if (action === "scrollTo") {
    return `scrollTo(anchor=${transition.action.anchorId})`;
  }
  return action;
}

/**
 * Derives an agent-friendly Feature Map from the committed Knowledge
 * Registry.
 *
 * Projection rules (deterministic, sorted by id; see docs/feature-map.md):
 *
 * - a Feature is the set of Screens reachable from one entry Screen;
 * - an entry Screen is a Screen with no incoming Transition — when every
 *   Screen has an incoming Transition, the lexicographically smallest Screen
 *   becomes the single entry;
 * - every Screen belongs to the feature of its smallest entry (a Screen may
 *   be reachable from several entries; it is claimed by the entry whose
 *   reachability set was first computed, in sorted order);
 * - Transitions and Anchors belong to the feature of their source Screen.
 */
export class FeatureMapProjector {
  public constructor(
    private readonly dependencies: FeatureMapProjectorDependencies
  ) {}

  private readonly assertReferences = (
    bundle: LoadedKnowledgeBundle
  ): void => {
    const screenIds = new Set(bundle.screens.map((screen) => screen.id));
    const anchorIds = new Set(bundle.anchors.map((anchor) => anchor.id));
    const firstOf = (ids: Iterable<string>): string | undefined => {
      for (const id of ids) {
        return id;
      }
      return undefined;
    };
    const badAnchor = firstOf(bundle.screens.flatMap((screen) => [
      ...screen.requiredAnchors,
      ...screen.optionalAnchors,
      ...screen.forbiddenAnchors
    ]).filter((id) => !anchorIds.has(id)));
    if (badAnchor !== undefined) {
      throw new Error(`Feature Map: Screen references unknown Anchor "${badAnchor}"`);
    }
    for (const transition of bundle.transitions) {
      if (!screenIds.has(transition.fromScreen)) {
        throw new Error(
          `Feature Map: Transition "${transition.id}" references unknown Screen "${transition.fromScreen}"`
        );
      }
      if (!screenIds.has(transition.toScreen)) {
        throw new Error(
          `Feature Map: Transition "${transition.id}" references unknown Screen "${transition.toScreen}"`
        );
      }
      const anchorId = transitionAnchorId(transition);
      if (anchorId !== undefined && !anchorIds.has(anchorId)) {
        throw new Error(
          `Feature Map: Transition "${transition.id}" references unknown Anchor "${anchorId}"`
        );
      }
    }
  };

  public readonly project = (
    bundle: LoadedKnowledgeBundle
  ): FeatureMapProjection => {
    this.assertReferences(bundle);

    const screenIds = new Set(bundle.screens.map((screen) => screen.id));
    const entryCandidates = sortById(bundle.screens).filter(
      (screen) => !bundle.transitions.some(
        (transition) => transition.toScreen === screen.id
      )
    );
    const entries = entryCandidates.length === 0
      ? [sortById(bundle.screens)[0]].filter(
          (screen): screen is NonNullable<typeof screen> => screen !== undefined
        )
      : entryCandidates;

    const reachability = (from: string): Set<string> => {
      const seen = new Set<string>([from]);
      let frontier = [from];
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const source of frontier) {
          for (const transition of bundle.transitions) {
            if (transition.fromScreen !== source) {
              continue;
            }
            if (seen.has(transition.toScreen)) {
              continue;
            }
            seen.add(transition.toScreen);
            next.push(transition.toScreen);
          }
        }
        frontier = next;
      }
      return seen;
    };

    const featureByScreen = new Map<string, string>();
    const screenByFeature = new Map<string, string[]>();
    for (const entry of entries) {
      const reachable = reachability(entry.id);
      for (const screenId of [...reachable].sort()) {
        if (featureByScreen.has(screenId)) {
          continue;
        }
        featureByScreen.set(screenId, entry.id);
        const group = screenByFeature.get(entry.id) ?? [];
        group.push(screenId);
        screenByFeature.set(entry.id, group);
      }
    }

    const entriesByFeature = new Map<string, FeatureMapScreenEntry>();
    for (const entry of entries) {
      entriesByFeature.set(entry.id, {
        id: entry.id,
        status: entry.status,
        feature: entry.id
      });
    }

    const features: FeatureMapFeature[] = [];
    for (const entry of sortById(entries)) {
      const screens = screenByFeature.get(entry.id) ?? [];
      const transitions = sortById(bundle.transitions).filter(
        (transition) => featureByScreen.get(transition.fromScreen) === entry.id
      );
      const anchors = sortById(bundle.anchors).filter(
        (anchor) => bundle.screens.some(
          (screen) => screenByFeature.get(entry.id)?.includes(screen.id)
            && [
              ...screen.requiredAnchors,
              ...screen.optionalAnchors,
              ...screen.forbiddenAnchors
            ].includes(anchor.id)
        ) || transitions.some(
          (transition) => transitionAnchorId(transition) === anchor.id
        )
      ).map((anchor) => anchor.id);
      features.push({
        id: entry.id,
        screens,
        transitions: transitions.map((transition) => transition.id),
        anchors
      });
    }

    const transitionEntries: FeatureMapTransitionEntry[] = sortById(
      bundle.transitions
    ).map((transition) => ({
      id: transition.id,
      status: transition.status,
      fromScreen: transition.fromScreen,
      toScreen: transition.toScreen,
      action: actionLabel(transition),
      observations: transition.observations
    }));

    const anchorEntries: FeatureMapAnchorEntry[] = sortById(
      bundle.anchors
    ).map((anchor) => ({
      id: anchor.id,
      status: anchor.status,
      roles: anchor.roles
    }));

    const entryScreens = sortById(entries.map((entry) => (
      entriesByFeature.get(entry.id)
    )).filter(
      (entry): entry is FeatureMapScreenEntry => entry !== undefined
    ));

    if (screenIds.size === 0) {
      throw new Error("Feature Map: Knowledge Registry has no Screens");
    }

    return FeatureMapProjectionSchema.parse({
      version: 1,
      packageName: bundle.index.packageName,
      knowledgeHash: bundle.knowledgeHash,
      revision: bundle.index.revision,
      entryScreens,
      features,
      transitions: transitionEntries,
      anchors: anchorEntries
    });
  };
}

/**
 * Renders a compact, deterministic, token-lean Markdown projection of the
 * Feature Map for agent consumption. Core never narrates in natural language;
 * this is a faithful 1:1 rendering of the structured projection.
 */
export function renderFeatureMapMarkdown(
  projection: FeatureMapProjection
): string {
  const lines: string[] = [];
  lines.push(`# Feature Map: ${projection.packageName}`);
  lines.push("");
  lines.push(`Knowledge hash: \`${projection.knowledgeHash.slice(0, 12)}\` (revision ${String(projection.revision)})`);
  lines.push("");
  lines.push(`Entry screens (${String(projection.entryScreens.length)}):`);
  for (const entry of projection.entryScreens) {
    lines.push(`- ${entry.id} \`${entry.status}\``);
  }
  lines.push("");
  for (const feature of projection.features) {
    lines.push(`## ${feature.id}`);
    lines.push("");
    lines.push(`Screens (${String(feature.screens.length)}):`);
    for (const screen of feature.screens) {
      lines.push(`- ${screen}`);
    }
    if (feature.transitions.length > 0) {
      lines.push("");
      lines.push(`Transitions (${String(feature.transitions.length)}):`);
      for (const transitionId of feature.transitions) {
        const transition = projection.transitions.find(
          (item) => item.id === transitionId
        );
        if (transition === undefined) {
          continue;
        }
        lines.push(
          `- ${transitionId}: ${transition.fromScreen} → ${transition.toScreen} (\`${transition.action}\`, ${String(transition.observations.successes)}/${String(transition.observations.attempts)})`
        );
      }
    }
    if (feature.anchors.length > 0) {
      lines.push("");
      lines.push(`Anchors (${String(feature.anchors.length)}):`);
      for (const anchorId of feature.anchors) {
        const anchor = projection.anchors.find((item) => item.id === anchorId);
        lines.push(
          `- ${anchorId} \`${anchor?.status ?? "unknown"}\` [${(anchor?.roles ?? []).join(", ")}]`
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}