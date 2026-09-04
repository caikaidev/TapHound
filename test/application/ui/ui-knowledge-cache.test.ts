import { describe, expect, it, vi } from "vitest";

import {
  UiKnowledgeCache,
  semanticUiFingerprint
} from "../../../src/application/ui/ui-knowledge-cache.js";
import {
  screenModelCacheKey,
  type CachedFlowFragment,
  type CachedScreenModel
} from "../../../src/domain/ui-cache.js";
import type { UiCacheStore } from "../../../src/ports/ui-cache-store.js";
import { uiSnapshotProvider } from "../../fakes/ui-snapshot.js";

const sha = (value: string): string => value.repeat(64);
const roots = [{
  id: "volatile-node-9",
  resourceId: "home_anchor",
  enabled: true,
  bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
  children: [{
    id: "volatile-node-10",
    resourceId: "open_search",
    text: "private user content",
    clickable: true,
    enabled: true,
    bounds: { left: 100, top: 200, right: 400, bottom: 300 },
    children: []
  }]
}];
const appBuild = {
  packageName: "dev.taphound.demo",
  versionCode: 1,
  lastUpdateTime: "2026-09-03T00:00:00.000Z",
  buildSha256: sha("b"),
  signingCertificateSha256: sha("c")
};
const environment = {
  apiLevel: 36,
  width: 1080,
  height: 1920,
  densityDpi: 420,
  fontScale: 1,
  rotation: 0 as const,
  locale: "en-US",
  nightMode: false
};
const backend = {
  id: "system-uiautomator" as const,
  adapterVersion: "test-v1",
  configSha256: sha("0")
};

function model(): CachedScreenModel {
  return {
    schemaVersion: 1,
    screenId: "home",
    appBuild,
    environment,
    backend,
    activity: "dev.taphound.demo.MainActivity",
    contract: {
      requiredAnchors: [{ resourceId: "home_anchor" }],
      semanticFingerprintVersion: 1,
      semanticFingerprint: semanticUiFingerprint(roots)
    },
    targets: [
      {
        purpose: "open_search",
        locator: { resourceId: "open_search" },
        requiredCapability: "clickable"
      },
      {
        purpose: "other",
        locator: { resourceId: "other" }
      }
    ],
    verifiedAt: "2026-09-03T00:00:00.000Z"
  };
}

function cacheStore(value: CachedScreenModel): {
  store: UiCacheStore;
  writeScreen: ReturnType<typeof vi.fn<UiCacheStore["writeScreen"]>>;
  invalidateScreen: ReturnType<typeof vi.fn<UiCacheStore["invalidateScreen"]>>;
  readFlow: ReturnType<typeof vi.fn<UiCacheStore["readFlow"]>>;
} {
  const writeScreen = vi.fn<UiCacheStore["writeScreen"]>((next) => (
    Promise.resolve(screenModelCacheKey(next))
  ));
  const invalidateScreen = vi.fn<UiCacheStore["invalidateScreen"]>(
    () => Promise.resolve()
  );
  const readFlow = vi.fn<UiCacheStore["readFlow"]>(() => Promise.resolve({
    status: "miss" as const,
    reason: "absent" as const
  }));
  return {
    store: {
    readScreen: vi.fn<UiCacheStore["readScreen"]>(() => Promise.resolve({
      status: "hit" as const,
      value
    })),
    writeScreen,
    invalidateScreen,
    readFlow,
    writeFlow: vi.fn(() => Promise.resolve(sha("f"))),
    addFlowVerification: vi.fn<UiCacheStore["addFlowVerification"]>(() => Promise.resolve({
      status: "miss" as const,
      reason: "absent" as const
    })),
    status: vi.fn(() => Promise.resolve({ directory: "cache", entries: 0, bytes: 0 })),
    clear: vi.fn(() => Promise.resolve())
    },
    writeScreen,
    invalidateScreen,
    readFlow
  };
}

describe("UiKnowledgeCache", () => {
  it("always force-captures and computes an executable point from live geometry", async () => {
    const cached = model();
    const { store } = cacheStore(cached);
    const provider = uiSnapshotProvider(roots);
    const subject = new UiKnowledgeCache(store);

    const result = await subject.resolveTarget({
      key: screenModelCacheKey(cached),
      purpose: "open_search",
      appBuild,
      environment,
      packageName: appBuild.packageName,
      activity: cached.activity,
      provider,
      timeoutMs: 1000
    });

    expect(result).toMatchObject({
      status: "found",
      target: { point: { x: 250, y: 250 } }
    });
    expect(provider.capture).toHaveBeenCalledWith(expect.objectContaining({
      freshness: "forceFresh"
    }));
    expect(subject.telemetry()).toMatchObject({ hits: 1, stale: 0 });
  });

  it("invalidates only a stale target when other screen knowledge remains", async () => {
    const cached = model();
    const { store, writeScreen, invalidateScreen } = cacheStore(cached);
    const root = roots[0];
    if (root === undefined) throw new Error("test fixture missing root");
    const provider = uiSnapshotProvider([{ ...root, children: [] }]);
    const subject = new UiKnowledgeCache(store);
    cached.contract.semanticFingerprint = semanticUiFingerprint([
      { ...root, children: [] }
    ]);

    await expect(subject.resolveTarget({
      key: screenModelCacheKey(cached),
      purpose: "open_search",
      appBuild,
      environment,
      packageName: appBuild.packageName,
      activity: cached.activity,
      provider,
      timeoutMs: 1000
    })).resolves.toEqual({ status: "miss", reason: "target" });

    expect(writeScreen).toHaveBeenCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ purpose: "other" })]
    }));
    expect(invalidateScreen).not.toHaveBeenCalled();
    expect(subject.telemetry()).toMatchObject({ misses: 1, stale: 1 });
  });

  it("marks a new build flow probation until an exact receipt exists", async () => {
    const fragment: CachedFlowFragment = {
      schemaVersion: 1 as const,
      name: "home-to-search",
      start: model().contract,
      end: model().contract,
      steps: [{
        action: "click" as const,
        locator: { resourceId: "open_search" },
        activity: {
          before: "dev.taphound.demo.MainActivity",
          after: "dev.taphound.demo.SearchActivity"
        }
      }],
      sourceSha256: sha("f"),
      verifiedBuilds: []
    };
    const { store, readFlow } = cacheStore(model());
    readFlow.mockResolvedValue({ status: "hit", value: fragment });
    const subject = new UiKnowledgeCache(store);

    await expect(subject.findFlow({
      name: fragment.name,
      appBuild,
      environmentSha256: sha("1"),
      uiBackend: backend
    })).resolves.toMatchObject({ status: "probation" });

    fragment.verifiedBuilds.push({
      appBuild,
      environmentSha256: sha("1"),
      uiBackend: backend,
      reportSha256: sha("2"),
      verifiedAt: "2026-09-03T01:00:00.000Z"
    });
    await expect(subject.findFlow({
      name: fragment.name,
      appBuild,
      environmentSha256: sha("1"),
      uiBackend: backend
    })).resolves.toMatchObject({ status: "verified" });
  });
});
