import { describe, expect, it } from "vitest";

import {
  JourneyResolver
} from "../../../src/application/journey/journey-resolver.js";
import type {
  JourneyCompositionStore
} from "../../../src/ports/journey-composition-store.js";
import { hashJourney } from "../../../src/domain/report.js";

const main = "com.example.app.MainActivity";
const home = "com.example.app.HomeActivity";
const chat = "com.example.app.ChatActivity";

function wait(before: string, after: string): object {
  return { action: "wait", activity: { before, after } };
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function fixture(files: Record<string, unknown>): JourneyResolver {
  const values = new Map(
    Object.entries(files).map(([path, value]) => [path, json(value)])
  );
  const store: Pick<JourneyCompositionStore, "read" | "listFlowPaths"> = {
    read: ({ relativePath }): Promise<Buffer> => {
      const value = values.get(relativePath);
      return value === undefined
        ? Promise.reject(new Error("not found"))
        : Promise.resolve(value);
    },
    listFlowPaths: (): Promise<readonly string[]> => Promise.resolve(
      [...values.keys()].filter((path) => path.startsWith(".taphound/flows/"))
    )
  };
  return new JourneyResolver(store);
}

function flow(
  name: string,
  includes: string[],
  steps: object[]
): object {
  return { version: 1, kind: "flow", name, includes, steps };
}

describe("JourneyResolver", () => {
  it("expands nested Flows in stable dependency order", async () => {
    const resolver = fixture({
      ".taphound/flows/core/home.json":
        flow("core/home", [], [wait(home, home)]),
      ".taphound/flows/chat/open-thread.json":
        flow("chat/open-thread", ["core/home"], [wait(home, chat)]),
      ".taphound/sources/chat/send.json": {
        version: 1,
        kind: "journeySource",
        name: "chat/send",
        includes: ["chat/open-thread"],
        steps: [wait(chat, chat)]
      }
    });

    const first = await resolver.resolve({
      projectRoot: "/project",
      sourcePath: ".taphound/sources/chat/send.json"
    });
    const second = await resolver.resolve({
      projectRoot: "/project",
      sourcePath: ".taphound/sources/chat/send.json"
    });

    expect(first.journey.steps.map((step) => step.activity)).toEqual([
      { before: home, after: home },
      { before: home, after: chat },
      { before: chat, after: chat }
    ]);
    expect(first.manifest.expansion).toEqual([
      "core/home",
      "chat/open-thread"
    ]);
    expect(first.manifest.resolutionSha256)
      .toBe(second.manifest.resolutionSha256);
    expect(first.manifest.journey.sha256).toBe(hashJourney(first.journey));
  });

  it("resolves a reusable Flow as a runnable prefix", async () => {
    const resolver = fixture({
      ".taphound/flows/core/home.json":
        flow("core/home", [], [wait(home, home)]),
      ".taphound/flows/chat/open-thread.json":
        flow("chat/open-thread", ["core/home"], [wait(home, chat)])
    });

    const result = await resolver.resolveFlow({
      projectRoot: "/project",
      name: "chat/open-thread"
    });

    expect(result.journey.name).toBe("chat/open-thread");
    expect(result.journey.steps).toHaveLength(2);
    expect(result.manifest.expansion).toEqual([
      "core/home",
      "chat/open-thread"
    ]);
  });

  it("rejects cycles, duplicate diamonds, and Activity gaps", async () => {
    const cycle = fixture({
      ".taphound/flows/a.json": flow("a", ["b"], [wait(main, main)]),
      ".taphound/flows/b.json": flow("b", ["a"], [wait(main, main)])
    });
    await expect(cycle.resolveFlow({
      projectRoot: "/project",
      name: "a"
    })).rejects.toMatchObject({
      code: "FLOW_CYCLE"
    });

    const duplicate = fixture({
      ".taphound/flows/root.json":
        flow("root", ["left", "right"], [wait(main, main)]),
      ".taphound/flows/left.json":
        flow("left", ["shared"], [wait(main, main)]),
      ".taphound/flows/right.json":
        flow("right", ["shared"], [wait(main, main)]),
      ".taphound/flows/shared.json":
        flow("shared", [], [wait(main, main)])
    });
    await expect(duplicate.resolveFlow({
      projectRoot: "/project",
      name: "root"
    })).rejects.toMatchObject({
      code: "FLOW_DUPLICATE"
    });

    const gap = fixture({
      ".taphound/flows/core.json":
        flow("core", [], [wait(main, home)]),
      ".taphound/flows/chat.json":
        flow("chat", ["core"], [wait(main, chat)])
    });
    await expect(gap.resolveFlow({
      projectRoot: "/project",
      name: "chat"
    })).rejects.toMatchObject({
      code: "ACTIVITY_BOUNDARY_MISMATCH"
    });
  });

  it("lists valid and invalid local Flows without hiding failures", async () => {
    const resolver = fixture({
      ".taphound/flows/core/home.json":
        flow("core/home", [], [wait(home, home)]),
      ".taphound/flows/wrong.json":
        flow("declared-elsewhere", [], [wait(main, main)])
    });

    await expect(resolver.listFlows("/project")).resolves.toEqual([
      expect.objectContaining({
        name: "core/home",
        status: "valid",
        entryActivity: home,
        exitActivity: home
      }),
      expect.objectContaining({
        name: "wrong",
        status: "invalid"
      })
    ]);
  });
});
