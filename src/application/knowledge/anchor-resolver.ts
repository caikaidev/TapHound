import type { DisplayViewport } from "../../domain/geometry.js";
import type { LayoutElement } from "../../domain/layout.js";
import type {
  AnchorResolution,
  AnchorResolverPort
} from "../../ports/anchor-resolver.js";
import type {
  KnowledgeRegistryPort
} from "../../ports/knowledge-registry.js";
import { resolveLocator } from "../locator/locator-resolver.js";

export class KnowledgeAnchorResolver implements AnchorResolverPort {
  public constructor(
    private readonly registry: Pick<KnowledgeRegistryPort, "load">,
    private readonly projectRoot: string
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
    const bundle = await this.registry.load(this.projectRoot);
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
    const resolution = resolveLocator(
      input.layout,
      anchor.identity.locator,
      {
        requireEnabled: true,
        ...(input.viewport === undefined ? {} : { viewport: input.viewport })
      }
    );
    if (resolution.status !== "found") {
      return {
        status: "notFound",
        message: resolution.message
      };
    }
    if (resolution.element.bounds === undefined) {
      return {
        status: "ambiguous",
        message: `Knowledge anchor ${input.anchorId} resolved to an element without bounds`
      };
    }
    return {
      status: "found",
      point: resolution.point,
      bounds: resolution.element.bounds
    };
  };
}