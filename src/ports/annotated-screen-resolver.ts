import type { Point } from "../domain/geometry.js";

export interface AnnotatedScreenResolverPort {
  resolve: (
    screenshotPath: string,
    label: string,
    signal?: AbortSignal
  ) => Promise<Point>;
}
