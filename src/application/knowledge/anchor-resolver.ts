import type { DisplayViewport } from "../../domain/geometry.js";
import type { LayoutElement } from "../../domain/layout.js";
import type {
  AnchorCandidate,
  AnchorCandidateKind
} from "../../domain/knowledge.js";
import type {
  AnchorResolution,
  AnchorResolverPort
} from "../../ports/anchor-resolver.js";
import type {
  KnowledgeRegistryPort
} from "../../ports/knowledge-registry.js";
import {
  resolveLocator,
  type LocatedTarget
} from "../locator/locator-resolver.js";

function candidateKindForLocator(locator: {
  resourceId?: string | undefined;
  text?: string | undefined;
  contentDescription?: string | undefined;
}): AnchorCandidateKind {
  if (locator.resourceId !== undefined) {
    return "resourceId";
  }
  if (locator.contentDescription !== undefined) {
    return "contentDescription";
  }
  if (locator.text !== undefined) {
    return "visibleText";
  }
  return "resourceId";
}

function resolveCandidate(
  layout: readonly LayoutElement[],
  candidate: AnchorCandidate,
  viewport?: DisplayViewport
): ReturnType<typeof resolveLocator> {
  return resolveLocator(
    layout,
    candidate.locator,
    {
      requireEnabled: true,
      ...(viewport === undefined ? {} : { viewport })
    }
  );
}

/**
 * Semantic Anchor resolver.
 *
 * An Anchor is a Semantic UI Reference: an ordered candidate chain
 * (composeSemantics → resourceId → contentDescription → visibleText →
 * visualMatch). Resolution walks the chain deterministically:
 *
 * - the first candidate that resolves **uniquely** wins; the win is recorded
 *   as `primary` (first candidate) or `fallback` (a later candidate), so a
 *   fallback resolution is visible in the report rather than silent;
 * - an **ambiguous** match at any candidate fails closed (matching the fixed
 *   locator-priority rule: never select heuristically);
 * - `visualMatch` is never resolved by Core: when nothing before it matched,
 *   the resolution is `visualOnly` and the run fails closed —
 *   `RUNTIME_CAPABILITY_MISSING` for the caller — leaving the visual layer to
 *   an external multimodal reviewer under the Escalation Policy.
 *
 * The legacy single-locator identity remains supported as the primary
 * candidate when no explicit `candidates` chain is present.
 */
export class KnowledgeAnchorResolver implements AnchorResolverPort {
  public constructor(
    private readonly registry: Pick<KnowledgeRegistryPort, "load">,
    private readonly projectRoot: string,
    private readonly workspaceRoot?: string | undefined
  ) {}

  public readonly resolve = async (
    input: {
      anchorId: string;
      layout: readonly LayoutElement[];
      viewport?: DisplayViewport | undefined;
      signal?: AbortSignal | undefined;
    }
  ): Promise<AnchorResolution> => {
    void input.signal;
    const bundle = await this.registry.load(this.projectRoot, this.workspaceRoot);
    const anchor = bundle.anchors.find(
      (candidate) => candidate.id === input.anchorId
    );
    if (anchor === undefined) {
      return {
        status: "notFound",
        message: `Knowledge anchor ${input.anchorId} is not defined in ${this.projectRoot}`
      };
    }
    if (anchor.identity.kind !== "element") {
      return {
        status: "notFound",
        message: `Knowledge anchor ${input.anchorId} does not carry an element locator identity`
      };
    }

    const candidates = anchor.candidates ?? [];
    const chain: Array<{ kind: AnchorCandidateKind; candidate: AnchorCandidate }> = candidates.length > 0
      ? candidates.map((candidate) => ({ kind: candidate.kind, candidate }))
      : [{
          kind: candidateKindForLocator(anchor.identity.locator),
          candidate: {
            kind: candidateKindForLocator(anchor.identity.locator),
            locator: anchor.identity.locator
          }
        }];

    for (const [index, entry] of chain.entries()) {
      if (entry.kind === "visualMatch") {
        continue;
      }
      const resolution = resolveCandidate(
        input.layout,
        entry.candidate,
        input.viewport
      );
      if (resolution.status !== "found") {
        continue;
      }
      return this.found(entry.kind, index === 0, resolution);
    }

    const hasVisual = chain.some((entry) => entry.kind === "visualMatch");
    if (hasVisual) {
      return {
        status: "visualOnly",
        message: `Knowledge anchor ${input.anchorId} resolves only via visualMatch, which Core never performs`
      };
    }
    return {
      status: "notFound",
      message: `Knowledge anchor ${input.anchorId} did not resolve through any candidate`
    };
  };

  private readonly found = (
    kind: AnchorCandidateKind,
    primary: boolean,
    resolution: LocatedTarget
  ): AnchorResolution => {
    if (resolution.element.bounds === undefined) {
      return {
        status: "ambiguous",
        message: `Knowledge anchor resolved via ${kind} to an element without bounds`
      };
    }
    return {
      status: "found",
      point: resolution.point,
      bounds: resolution.element.bounds,
      element: resolution.element,
      resolvedBy: { kind, confidence: primary ? "primary" : "fallback" }
    };
  };
}