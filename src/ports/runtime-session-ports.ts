import type { AdbPort } from "./adb.js";
import type { AnnotatedScreenResolverPort } from "./annotated-screen-resolver.js";
import type { RuntimeSession } from "./runtime-backend.js";
import type { ScreenshotPort } from "./screenshot.js";
import type { UiStabilityProbe } from "./ui-stability.js";

/**
 * Legacy port views over one borrowed `RuntimeSession`.
 *
 * Level 1 session-first orchestrators borrow one session per run and feed
 * their unchanged `AdbPort`-shaped helpers through these views so the whole
 * run flows through a single session. Level 2 retypes the helpers onto
 * `Pick<RuntimeSession, ...>` and deletes the views.
 */
export interface RuntimeSessionPortViews {
  adb: AdbPort;
  screenshots: ScreenshotPort;
  annotatedScreens: AnnotatedScreenResolverPort;
  uiStability: UiStabilityProbe;
}

/**
 * Builds the legacy port views for one borrowed session. Implementations
 * live in the runtime adapters; application services depend on this factory
 * type only.
 */
export type RuntimeSessionPortViewsFactory =
  (session: RuntimeSession) => RuntimeSessionPortViews;
