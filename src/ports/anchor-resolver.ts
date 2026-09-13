import type { DisplayViewport } from "../domain/geometry.js";
import type { LayoutElement } from "../domain/layout.js";
import type { AnchorCandidateKind } from "../domain/knowledge.js";

export interface AnchorResolution {
  status: "found" | "notFound" | "ambiguous" | "visualOnly";
  point?: { x: number; y: number };
  bounds?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  element?: LayoutElement;
  message?: string;
  resolvedBy?: {
    kind: AnchorCandidateKind;
    confidence: "primary" | "fallback";
  };
}

export interface AnchorResolverPort {
  resolve: (input: {
    anchorId: string;
    layout: readonly LayoutElement[];
    viewport?: DisplayViewport | undefined;
    signal?: AbortSignal | undefined;
  }) => Promise<AnchorResolution>;
}