import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  InquirerGenerationPrompt,
  type GenerationInputStream,
  type GenerationDiagnosticStream,
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

function streams(
  inputIsTTY = true,
  outputIsTTY = true
): {
  input: GenerationInputStream;
  output: GenerationDiagnosticStream;
} {
  const inputStream = new PassThrough() as GenerationInputStream;
  const outputStream = new PassThrough() as GenerationDiagnosticStream;
  inputStream.isTTY = inputIsTTY;
  outputStream.isTTY = outputIsTTY;
  return { input: inputStream, output: outputStream };
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
    const io = streams();
    const write = vi.spyOn(io.output, "write");
    const stdoutWrite = vi.spyOn(process.stdout, "write");
    const injected = functions([true]);
    const prompt = new InquirerGenerationPrompt(
      injected,
      io.input,
      io.output
    );
    const challenge: PendingConfirmation = {
      challengeId: "challenge-1",
      stepIndex: 0,
      proposalHash: "b".repeat(64),
      snapshotHash: "a".repeat(64),
      evidenceHash: "e".repeat(64),
      actionSummary: "Back from com.example.app.MainActivity",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "pending"
    };

    await expect(prompt.confirm(challenge)).resolves.toBe(true);
    const stdoutCalls = stdoutWrite.mock.calls.length;
    stdoutWrite.mockRestore();
    expect(stdoutCalls).toBe(0);
    expect(write).toHaveBeenCalledWith(
      "TapHound confirmation: Back from com.example.app.MainActivity\n"
    );
    expect(injected.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ default: false }),
      { input: io.input, output: io.output }
    );
  });

  it("propagates active confirmation abort through the prompt context", async () => {
    const io = streams();
    const controller = new AbortController();
    const injected = functions([]);
    vi.mocked(injected.confirm).mockImplementation((
      _config,
      context
    ): Promise<unknown> => {
      if (context.signal === undefined) {
        return Promise.reject(new Error("Missing abort signal"));
      }
      return new Promise((_resolve, reject) => {
      context.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("Prompt aborted"), {
          name: "AbortPromptError"
        }));
      }, { once: true });
      });
    });
    const prompt = new InquirerGenerationPrompt(
      injected,
      io.input,
      io.output
    );
    const confirmation = prompt.confirm({
      challengeId: "challenge-1",
      stepIndex: 0,
      proposalHash: "b".repeat(64),
      snapshotHash: "a".repeat(64),
      evidenceHash: "e".repeat(64),
      actionSummary: "Wait",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "pending"
    }, controller.signal);
    await vi.waitFor(() => {
      expect(injected.confirm).toHaveBeenCalledTimes(1);
    });

    controller.abort();

    await expect(confirmation).rejects.toThrow(/cancelled/i);
    expect(vi.mocked(injected.confirm).mock.calls[0]?.[1]).toMatchObject({
      input: io.input,
      output: io.output,
      signal: controller.signal
    });
  });

  it("propagates active manual abort and does not continue prompting", async () => {
    const io = streams();
    const controller = new AbortController();
    const injected = functions([]);
    vi.mocked(injected.select).mockImplementation((
      _config,
      context
    ): Promise<unknown> => {
      if (context.signal === undefined) {
        return Promise.reject(new Error("Missing abort signal"));
      }
      return new Promise((_resolve, reject) => {
      context.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("Prompt aborted"), {
          name: "AbortPromptError"
        }));
      }, { once: true });
      });
    });
    const prompt = new InquirerGenerationPrompt(
      injected,
      io.input,
      io.output
    );
    const manual = prompt.buildManualProposal(
      input("click"),
      controller.signal
    );
    await vi.waitFor(() => {
      expect(injected.select).toHaveBeenCalledTimes(1);
    });

    controller.abort();

    await expect(manual).rejects.toThrow(/cancelled/i);
    expect(injected.input).not.toHaveBeenCalled();
    expect(injected.number).not.toHaveBeenCalled();
  });

  it("rejects already-aborted prompts before invoking Inquirer", async () => {
    const io = streams();
    const injected = functions([true]);
    const prompt = new InquirerGenerationPrompt(
      injected,
      io.input,
      io.output
    );
    const signal = AbortSignal.abort();

    await expect(prompt.confirm({
      challengeId: "challenge-1",
      stepIndex: 0,
      proposalHash: "b".repeat(64),
      snapshotHash: "a".repeat(64),
      evidenceHash: "e".repeat(64),
      actionSummary: "Wait",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "pending"
    }, signal)).rejects.toThrow(/cancelled/i);
    await expect(prompt.buildManualProposal(input("click"), signal))
      .rejects.toThrow(/cancelled/i);
    expect(injected.confirm).not.toHaveBeenCalled();
    expect(injected.select).not.toHaveBeenCalled();
  });

  it.each([
    ["piped stdin", false, true],
    ["non-TTY diagnostics", true, false]
  ])("rejects confirmation with %s before invoking a prompt", async (
    _name,
    inputIsTTY,
    outputIsTTY
  ) => {
    const io = streams(inputIsTTY, outputIsTTY);
    const injected = functions([true]);
    const prompt = new InquirerGenerationPrompt(
      injected,
      io.input,
      io.output
    );
    await expect(prompt.confirm({
      challengeId: "challenge-1",
      stepIndex: 0,
      proposalHash: "b".repeat(64),
      snapshotHash: "a".repeat(64),
      evidenceHash: "e".repeat(64),
      actionSummary: "Wait",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "pending"
    })).rejects.toThrow(/TTY/i);
    expect(injected.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["piped stdin", false, true],
    ["non-TTY diagnostics", true, false]
  ])("rejects manual takeover with %s before invoking a prompt", async (
    _name,
    inputIsTTY,
    outputIsTTY
  ) => {
    const io = streams(inputIsTTY, outputIsTTY);
    const injected = functions(["button"]);
    const prompt = new InquirerGenerationPrompt(
      injected,
      io.input,
      io.output
    );

    await expect(prompt.buildManualProposal(input("click")))
      .rejects.toThrow(/TTY/i);
    expect(injected.select).not.toHaveBeenCalled();
    expect(injected.input).not.toHaveBeenCalled();
    expect(injected.number).not.toHaveBeenCalled();
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
    const io = streams();
    const injected = functions([...answers]);
    const stdoutWrite = vi.spyOn(process.stdout, "write");
    const prompt = new InquirerGenerationPrompt(
      injected,
      io.input,
      io.output
    );
    const proposal = await prompt.buildManualProposal(input(action));
    const stdoutCalls = stdoutWrite.mock.calls.length;
    stdoutWrite.mockRestore();

    expect(stdoutCalls).toBe(0);
    expect(proposal).toMatchObject({
      ...expected,
      binding,
      activity: { before },
      expect: input(action).expect
    });
    expect(proposal).not.toHaveProperty("fallback");
    for (const operation of [
      injected.select,
      injected.input,
      injected.number
    ]) {
      for (const call of vi.mocked(operation).mock.calls) {
        expect(call[1]).toEqual({
          input: io.input,
          output: io.output
        });
      }
    }
  });

  it("rejects selections not returned by deterministic target lists", async () => {
    const io = streams();
    const prompt = new InquirerGenerationPrompt(
      functions(["unknown"]),
      io.input,
      io.output
    );
    await expect(prompt.buildManualProposal(input("click")))
      .rejects.toThrow(/selection/i);
  });
});
