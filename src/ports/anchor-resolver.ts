import type { DisplayViewport } from "../domain/geometry.js";
import type { LayoutElement } from "../domain/layout.js";

export interface AnchorResolution {
  status: "found" | "notFound" | "ambiguous";
  point?: { x: number; y: number };
  bounds?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  message?: string;
}

export interface AnchorResolverPort {
  resolve: (input: {
    anchorId: string;
    layout: readonly LayoutElement[];
    viewport?: DisplayViewport | undefined;
    signal?: AbortSignal | undefined;
  }) => Promise<AnchorResolution>;
}