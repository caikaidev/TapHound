import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { LayoutElement } from "../../domain/layout.js";
import {
  CachedScreenModelSchema,
  screenModelCacheKey,
  type AppBuildIdentity,
  type CachedFlowFragment,
  type CachedScreenModel,
  type FlowVerificationReceipt,
  type UiCacheTelemetry,
  type UiEnvironmentIdentity
} from "../../domain/ui-cache.js";
import type { UiBackendDescriptor } from "../../domain/ui-backend.js";
import type {
  UiSnapshot,
  UiSnapshotProvider
} from "../../ports/ui-snapshot.js";
import type { UiCacheStore } from "../../ports/ui-cache-store.js";
import {
  resolveLocator,
  type LocatedTarget
} from "../locator/locator-resolver.js";

function canonicalizeElement(element: LayoutElement): unknown {
  return {
    ...(element.windowId === undefined ? {} : { windowId: element.windowId }),
    ...(element.resourceId === undefined ? {} : { resourceId: element.resourceId }),
    ...(element.clickable === undefined ? {} : { clickable: element.clickable }),
    ...(element.longClickable === undefined
      ? {}
      : { longClickable: element.longClickable }),
    ...(element.scrollable === undefined ? {} : { scrollable: element.scrollable }),
    ...(element.focusable === undefined ? {} : { focusable: element.focusable }),
    enabled: element.enabled,
    children: element.children.map(canonicalizeElement)
  };
}

export function semanticUiFingerprint(
  roots: readonly LayoutElement[]
): string {
  return createHash("sha256")
    .update(JSON.stringify(roots.map(canonicalizeElement)))
    .digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type ScreenTargetLookup = {
  status: "found";
  target: LocatedTarget;
  snapshot: UiSnapshot;
} | {
  status: "miss";
  reason:
    | "absent"
    | "corrupt"
    | "unknownSchema"
    | "identity"
    | "contract"
    | "target";
};

export type FlowCandidateLookup = {
  status: "verified" | "probation";
  fragment: CachedFlowFragment;
} | {
  status: "miss";
  reason: "absent" | "corrupt" | "unknownSchema";
};

export class UiKnowledgeCache {
  private readonly counters: UiCacheTelemetry = {
    hits: 0,
    misses: 0,
    stale: 0,
    relearns: 0,
    capturesSaved: 0,
    validationDurationMs: 0
  };

  public constructor(private readonly store: UiCacheStore) {}

  public async rememberScreen(model: CachedScreenModel): Promise<string> {
    const parsed = CachedScreenModelSchema.parse(model);
    const key = await this.store.writeScreen(parsed);
    this.counters.relearns += 1;
    return key;
  }

  public async resolveTarget(input: {
    key: string;
    purpose: string;
    appBuild: AppBuildIdentity;
    environment: UiEnvironmentIdentity;
    packageName: string;
    activity: string;
    provider: UiSnapshotProvider;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  }): Promise<ScreenTargetLookup> {
    const startedAt = performance.now();
    const cached = await this.store.readScreen(input.key);
    if (cached.status === "miss") {
      this.counters.misses += 1;
      return { status: "miss", reason: cached.reason };
    }
    const model = cached.value;
    if (
      input.packageName !== model.appBuild.packageName
      || input.activity !== model.activity
      || !sameJson(input.appBuild, model.appBuild)
      || !sameJson(input.environment, model.environment)
      || !sameJson(input.provider.descriptor, model.backend)
      || screenModelCacheKey(model) !== input.key
    ) {
      await this.store.invalidateScreen(input.key).catch(() => undefined);
      this.stale(startedAt);
      return { status: "miss", reason: "identity" };
    }
    const snapshot = await input.provider.capture({
      reason: "locate",
      freshness: "forceFresh",
      timeoutMs: input.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (
      !sameJson(snapshot.backend, model.backend)
      || semanticUiFingerprint(snapshot.roots)
        !== model.contract.semanticFingerprint
      || model.contract.requiredAnchors.some((anchor) => (
        resolveLocator(snapshot.roots, anchor, { requireEnabled: false }).status
          !== "found"
      ))
      || model.contract.forbiddenAnchors?.some((anchor) => (
        resolveLocator(snapshot.roots, anchor, { requireEnabled: false }).status
          === "found"
      )) === true
    ) {
      await this.store.invalidateScreen(input.key).catch(() => undefined);
      this.stale(startedAt);
      return { status: "miss", reason: "contract" };
    }
    const selected = model.targets.find((target) => target.purpose === input.purpose);
    if (selected === undefined) {
      this.counters.misses += 1;
      this.counters.validationDurationMs += performance.now() - startedAt;
      return { status: "miss", reason: "target" };
    }
    const requiredCapability = selected.requiredCapability === "scrollable"
      ? undefined
      : selected.requiredCapability;
    const resolution = resolveLocator(snapshot.roots, selected.locator, {
      ...(requiredCapability === undefined ? {} : { requiredCapability }),
      viewport: snapshot.viewport
    });
    if (
      resolution.status === "failed"
      || (
        selected.requiredCapability === "scrollable"
        && resolution.element.scrollable !== true
      )
    ) {
      const remaining = model.targets.filter(
        (target) => target.purpose !== input.purpose
      );
      if (remaining.length === 0) {
        await this.store.invalidateScreen(input.key).catch(() => undefined);
      } else {
        await this.store.writeScreen({ ...model, targets: remaining }).catch(
          () => undefined
        );
      }
      this.stale(startedAt);
      return { status: "miss", reason: "target" };
    }
    this.counters.hits += 1;
    this.counters.validationDurationMs += performance.now() - startedAt;
    return { status: "found", target: resolution, snapshot };
  }

  public async findFlow(input: {
    name: string;
    appBuild: AppBuildIdentity;
    environmentSha256: string;
    uiBackend: UiBackendDescriptor;
  }): Promise<FlowCandidateLookup> {
    const cached = await this.store.readFlow(input.name);
    if (cached.status === "miss") {
      this.counters.misses += 1;
      return { status: "miss", reason: cached.reason };
    }
    const verified = cached.value.verifiedBuilds.some((receipt) => (
      sameJson(receipt.appBuild, input.appBuild)
      && receipt.environmentSha256 === input.environmentSha256
      && sameJson(receipt.uiBackend, input.uiBackend)
    ));
    this.counters.hits += 1;
    return {
      status: verified ? "verified" : "probation",
      fragment: cached.value
    };
  }

  public verifyFlow(
    name: string,
    receipt: FlowVerificationReceipt
  ): Promise<unknown> {
    return this.store.addFlowVerification(name, receipt);
  }

  public telemetry(): UiCacheTelemetry {
    return { ...this.counters };
  }

  private stale(startedAt: number): void {
    this.counters.misses += 1;
    this.counters.stale += 1;
    this.counters.validationDurationMs += performance.now() - startedAt;
  }
}
