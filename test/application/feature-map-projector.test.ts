import { describe, expect, it } from "vitest";

import {
  FeatureMapProjector,
  renderFeatureMapMarkdown
} from "../../src/application/knowledge/feature-map-projector.js";
import type { LoadedKnowledgeBundle } from "../../src/ports/knowledge-registry.js";
import type {
  ScreenDefinition,
  TransitionDefinition
} from "../../src/domain/knowledge.js";

const inboxScreen: ScreenDefinition = {
  version: 1,
  id: "inbox",
  status: "observed",
  requiredAnchors: ["inbox.list"],
  optionalAnchors: [],
  forbiddenAnchors: [],
  predicates: []
};

const mailDetailScreen: ScreenDefinition = {
  version: 1,
  id: "mail_detail",
  status: "inferred",
  requiredAnchors: ["inbox.list"],
  optionalAnchors: [],
  forbiddenAnchors: [],
  predicates: []
};

const openMailTransition: TransitionDefinition = {
  version: 1,
  id: "inbox.open_mail",
  status: "inferred",
  fromScreen: "inbox",
  toScreen: "mail_detail",
  semantic: "open-mail-detail",
  action: { action: "click", anchorId: "inbox.list" },
  verification: { targetScreen: "mail_detail", timeoutMs: 2000 },
  observations: { attempts: 3, successes: 2, recoveryCost: 0.5 }
};

function bundle(overrides: { transitions?: TransitionDefinition[] } = {}): LoadedKnowledgeBundle {
  const screens = [inboxScreen, mailDetailScreen];
  const transitions = overrides.transitions ?? [openMailTransition];
  return {
    index: {
      version: 1,
      packageName: "com.example.app",
      revision: 2,
      anchors: [{
        id: "inbox.list",
        path: ".taphound/knowledge/anchors/inbox.list.json",
        sha256: "a".repeat(64),
        status: "verified"
      }],
      screens: screens.map((screen) => ({
        id: screen.id,
        path: `.taphound/knowledge/screens/${screen.id}.json`,
        sha256: screen.id.startsWith("mail")
          ? "b1".repeat(32)
          : "b".repeat(64),
        status: screen.status
      })),
      transitions: transitions.map((transition) => ({
        id: transition.id,
        path: `.taphound/knowledge/transitions/${transition.id}.json`,
        sha256: "c".repeat(64),
        status: transition.status
      }))
    },
    indexSha256: "d".repeat(64),
    knowledgeHash: "e".repeat(64),
    anchors: [{
      version: 1,
      id: "inbox.list",
      status: "verified",
      roles: ["actionable"],
      identity: {
        kind: "element",
        locator: { resourceId: "inbox_list" }
      }
    }],
    screens,
    transitions
  };
}

describe("FeatureMapProjector", () => {
  const projector = new FeatureMapProjector({});

  it("projects entry screens from screens without incoming transitions", () => {
    const projection = projector.project(bundle());
    expect(projection.entryScreens.map((entry) => entry.id)).toEqual(["inbox"]);
    expect(projection.features).toHaveLength(1);
    expect(projection.features[0]?.id).toBe("inbox");
    expect(projection.features[0]?.screens).toEqual(["inbox", "mail_detail"]);
  });

  it("orders transitions by id in the projection", () => {
    const searchTransition: TransitionDefinition = {
      version: 1,
      id: "inbox.open_mail_2",
      status: "inferred",
      fromScreen: "inbox",
      toScreen: "mail_detail",
      semantic: "open-search",
      action: { action: "click", anchorId: "inbox.list" },
      verification: { targetScreen: "mail_detail", timeoutMs: 2000 },
      observations: { attempts: 1, successes: 0, recoveryCost: 0 }
    };
    const projection = projector.project(bundle({
      transitions: [openMailTransition, searchTransition]
    }));
    expect(projection.features[0]?.transitions).toEqual([
      "inbox.open_mail",
      "inbox.open_mail_2"
    ]);
  });

  it("falls back to a single entry when every screen has an incoming transition", () => {
    const backTransition: TransitionDefinition = {
      ...openMailTransition,
      id: "mail_detail.back",
      fromScreen: "mail_detail",
      toScreen: "inbox"
    };
    const projection = projector.project(bundle({
      transitions: [openMailTransition, backTransition]
    }));
    expect(projection.entryScreens).toHaveLength(1);
    expect(projection.entryScreens[0]?.id).toBe("inbox");
  });

  it("carries knowledge hash and revision", () => {
    const projection = projector.project(bundle());
    expect(projection.knowledgeHash).toBe("e".repeat(64));
    expect(projection.revision).toBe(2);
  });

  it("fails closed on a transition referencing an unknown screen", () => {
    const broken = bundle({
      transitions: [{
        ...openMailTransition,
        toScreen: "not-a-screen"
      }]
    });
    expect(() => projector.project(broken)).toThrow(/unknown Screen/);
  });

  it("fails closed on a screen referencing an unknown anchor", () => {
    const broken: LoadedKnowledgeBundle = {
      ...bundle(),
      screens: bundle().screens.map((screen) => (
        screen.id === "inbox"
          ? { ...screen, requiredAnchors: ["missing.anchor"] }
          : screen
      ))
    };
    expect(() => projector.project(broken)).toThrow(/unknown Anchor/);
  });
});

describe("renderFeatureMapMarkdown", () => {
  it("renders a deterministic low-token view", () => {
    const projection = new FeatureMapProjector({}).project(bundle());
    const markdown = renderFeatureMapMarkdown(projection);
    expect(markdown).toContain("# Feature Map: com.example.app");
    expect(markdown).toContain("Entry screens (1):");
    expect(markdown).toContain("- inbox `observed`");
    expect(markdown).toContain("## inbox");
    expect(markdown).toContain("inbox.open_mail: inbox → mail_detail");
    expect(markdown).toContain("`click(anchor=inbox.list)`");
    expect(markdown).toContain("2/3");
    expect(markdown).toContain("- inbox.list `verified` [actionable]");
  });
});