import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemUiCacheStore
} from "../../../src/adapters/filesystem/ui-cache-store.js";
import {
  flowFragmentCacheKey,
  screenModelCacheKey,
  type CachedFlowFragment,
  type CachedScreenModel
} from "../../../src/domain/ui-cache.js";

const temporaryRoots: string[] = [];
const sha = (value: string): string => value.repeat(64);
const backend = {
  id: "system-uiautomator" as const,
  adapterVersion: "v1",
  configSha256: sha("a")
};
const appBuild = {
  packageName: "dev.taphound.demo",
  versionCode: 1,
  lastUpdateTime: "2026-09-03T00:00:00.000Z",
  buildSha256: sha("b"),
  signingCertificateSha256: sha("c")
};
const environment = {
  apiLevel: 36,
  width: 1200,
  height: 2670,
  densityDpi: 420,
  fontScale: 1,
  rotation: 0 as const,
  locale: "en-US",
  nightMode: false
};

function screen(screenId = "home"): CachedScreenModel {
  return {
    schemaVersion: 1,
    screenId,
    appBuild,
    environment,
    backend,
    activity: "dev.taphound.demo.MainActivity",
    contract: {
      requiredAnchors: [{ resourceId: "home_anchor" }],
      semanticFingerprintVersion: 1,
      semanticFingerprint: sha("d")
    },
    targets: [{
      purpose: "open_search",
      locator: { resourceId: "open_search" },
      requiredCapability: "clickable"
    }],
    verifiedAt: "2026-09-03T00:00:00.000Z"
  };
}

function flow(name = "home-to-search"): CachedFlowFragment {
  return {
    schemaVersion: 1,
    name,
    start: {
      requiredAnchors: [{ resourceId: "home_anchor" }],
      semanticFingerprintVersion: 1,
      semanticFingerprint: sha("d")
    },
    end: {
      requiredAnchors: [{ resourceId: "search_anchor" }],
      semanticFingerprintVersion: 1,
      semanticFingerprint: sha("e")
    },
    steps: [{
      action: "click",
      locator: { resourceId: "open_search" },
      activity: {
        before: "dev.taphound.demo.MainActivity",
        after: "dev.taphound.demo.SearchActivity"
      }
    }],
    sourceSha256: sha("f"),
    verifiedBuilds: []
  };
}

async function store(options: { maxEntries?: number } = {}): Promise<{
  root: string;
  value: FileSystemUiCacheStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "taphound-ui-cache-"));
  temporaryRoots.push(root);
  return { root, value: new FileSystemUiCacheStore(root, options) };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

describe("FileSystemUiCacheStore", () => {
  it("atomically round-trips screen models without executable geometry or page text", async () => {
    const test = await store();
    const key = await test.value.writeScreen(screen());

    await expect(test.value.readScreen(key)).resolves.toEqual({
      status: "hit",
      value: screen()
    });
    const path = join(
      test.root,
      ".taphound/build/cache/ui/v1/screens",
      `${key}.json`
    );
    const bytes = await readFile(path, "utf8");
    expect(bytes).not.toMatch(/bounds|center|pageSource|screenshot|secret message/i);
  });

  it("treats corruption and unknown cache versions as misses", async () => {
    const test = await store();
    const key = await test.value.writeScreen(screen());
    const path = join(
      test.root,
      ".taphound/build/cache/ui/v1/screens",
      `${key}.json`
    );
    await writeFile(path, "not json");
    await expect(test.value.readScreen(key)).resolves.toEqual({
      status: "miss",
      reason: "corrupt"
    });
    await writeFile(path, JSON.stringify({ cacheSchemaVersion: 99 }));
    await expect(test.value.readScreen(key)).resolves.toEqual({
      status: "miss",
      reason: "unknownSchema"
    });
  });

  it("evicts least-recent entries and clears only the UI cache subtree", async () => {
    const test = await store({ maxEntries: 1 });
    const first = await test.value.writeScreen(screen("first"));
    const second = await test.value.writeScreen(screen("second"));

    expect((await test.value.status()).entries).toBe(1);
    await expect(test.value.readScreen(first)).resolves.toMatchObject({
      status: "miss"
    });
    await expect(test.value.readScreen(second)).resolves.toMatchObject({
      status: "hit"
    });
    await test.value.clear();
    await expect(test.value.status()).resolves.toMatchObject({
      entries: 0,
      bytes: 0
    });
  });

  it("promotes a flow only by appending a per-build verification receipt", async () => {
    const test = await store();
    await test.value.writeFlow(flow());
    expect(flowFragmentCacheKey("home-to-search")).toHaveLength(64);

    const updated = await test.value.addFlowVerification("home-to-search", {
      appBuild,
      environmentSha256: sha("1"),
      uiBackend: backend,
      reportSha256: sha("2"),
      verifiedAt: "2026-09-03T01:00:00.000Z"
    });
    expect(updated).toMatchObject({
      status: "hit",
      value: { verifiedBuilds: [{ reportSha256: sha("2") }] }
    });
  });

  it("rejects sensitive text and stale geometry at the strict schema boundary", async () => {
    const test = await store();
    await expect(test.value.writeScreen({
      ...screen(),
      targets: [{
        purpose: "unsafe",
        locator: { text: "secret message" }
      }]
    })).rejects.toThrow(/resourceId-based/);
    await expect(test.value.writeFlow({
      ...flow(),
      steps: [{
        action: "inputText",
        text: "token-123",
        activity: {
          before: "dev.taphound.demo.MainActivity",
          after: "dev.taphound.demo.MainActivity"
        }
      }]
    })).rejects.toThrow(/cannot contain/);
    await expect(test.value.writeFlow({
      ...flow(),
      steps: [{
        action: "click",
        locator: { resourceId: "open_search" },
        activity: {
          before: "dev.taphound.demo.MainActivity",
          after: "dev.taphound.demo.SearchActivity"
        },
        expect: {
          type: "logcat",
          tag: "Demo",
          pattern: "private runtime value",
          match: "literal",
          timeoutMs: 1000
        }
      }]
    })).rejects.toThrow(/cannot contain/);
    expect(screenModelCacheKey(screen())).toHaveLength(64);
  });
});
