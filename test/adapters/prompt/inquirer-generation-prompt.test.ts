import { describe, expect, it, vi } from "vitest";

import {
  InquirerGenerationPrompt,
  type GenerationPromptFunctions
} from "../../../src/adapters/prompt/inquirer-generation-prompt.js";
import type { PendingConfirmation } from "../../../src/domain/generation.js";
import type { LayoutElement } from "../../../src/domain/layout.js";
import type { ManualProposalInput } from "../../../src/ports/generation-prompt.js";

const binding = {
  generationId: "generation-1",
  baseRevision: 2,
  snapshotHash: "a".repeat(64)
};
const before = "com.example.app.MainActivity";
const layout: LayoutElement[] = [
  {
    id: "button",
    resourceId: "button",
    clickable: true,
    longClickable: true,
    enabled: true,
    center: { x: 20, y: 20 },
    children: []
  },
  {
    id: "list",
    resourceId: "list",
    scrollable: true,
    enabled: true,
    bounds: { left: 0, top: 50, right: 100, bottom: 200 },
    children: []
  },
  {
    id: "row",
    text: "Row",
    enabled: true,
    center: { x: 20, y: 80 },
    children: []
  }
];

function functions(answers: unknown[]): GenerationPromptFunctions {
  const next = (): Promise<unknown> => Promise.resolve(answers.shift());
  return {
    select: vi.fn(next),
    input: vi.fn(next),
    confirm: vi.fn(next),
    number: vi.fn(next)
  };
}

function input(
  action: ManualProposalInput["action"]
): ManualProposalInput {
  return {
    action,
    binding,
    before,
    layout,
    expect: {
      type: "activity",
      value: "com.example.app.NextActivity",
      timeoutMs: 1000
    }
  };
}

describe("InquirerGenerationPrompt", () => {
  it("uses stderr/TTY for confirmation and never requires stdout", async () => {
    const diagnostics = { write: vi.fn(() => true), isTTY: true };
    const prompt = new InquirerGenerationPrompt(
      functions([true]),
      diagnostics
    );
    const challenge: PendingConfirmation = {
      challengeId: "challenge-1",
      stepIndex: 0,
      proposalHash: "b".repeat(64),
      snapshotHash: "a".repeat(64),
      actionSummary: "Back from com.example.app.MainActivity",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "pending"
    };

    await expect(prompt.confirm(challenge)).resolves.toBe(true);
    expect(diagnostics.write).toHaveBeenCalledWith(
      "TapHound confirmation: Back from com.example.app.MainActivity\n"
    );
  });

  it("rejects confirmation without a local TTY", async () => {
    const prompt = new InquirerGenerationPrompt(
      functions([true]),
      { write: vi.fn(), isTTY: false }
    );
    await expect(prompt.confirm({
      challengeId: "challenge-1",
      stepIndex: 0,
      proposalHash: "b".repeat(64),
      snapshotHash: "a".repeat(64),
      actionSummary: "Wait",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "pending"
    })).rejects.toThrow(/TTY/i);
  });

  it.each([
    ["click", ["button"], {
      action: "click",
      locator: { resourceId: "button" }
    }],
    ["longClick", ["button", 900], {
      action: "longClick",
      locator: { resourceId: "button" },
      durationMs: 900
    }],
    ["swipe", ["list", "up", 0.7, 350], {
      action: "swipe",
      locator: { resourceId: "list" },
      direction: "up",
      distancePercent: 0.7,
      durationMs: 350
    }],
    ["scrollTo", ["list", "row", "down", 0.5, 400, 12], {
      action: "scrollTo",
      locator: { text: "Row" },
      container: { resourceId: "list" },
      direction: "down",
      distancePercent: 0.5,
      durationMs: 400,
      maxSwipes: 12
    }],
    ["inputText", ["hello"], {
      action: "inputText",
      text: "hello"
    }],
    ["back", [], { action: "back" }],
    ["wait", [], { action: "wait" }]
  ] as const)("builds a deterministic manual %s proposal", async (
    action,
    answers,
    expected
  ) => {
    const prompt = new InquirerGenerationPrompt(
      functions([...answers]),
      { write: vi.fn(), isTTY: true }
    );
    const proposal = await prompt.buildManualProposal(input(action));

    expect(proposal).toMatchObject({
      ...expected,
      binding,
      activity: { before },
      expect: input(action).expect
    });
    expect(proposal).not.toHaveProperty("fallback");
  });

  it("rejects selections not returned by deterministic target lists", async () => {
    const prompt = new InquirerGenerationPrompt(
      functions(["unknown"]),
      { write: vi.fn(), isTTY: true }
    );
    await expect(prompt.buildManualProposal(input("click")))
      .rejects.toThrow(/selection/i);
  });
});
