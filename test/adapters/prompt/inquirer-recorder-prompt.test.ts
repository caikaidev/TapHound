import { describe, expect, it, vi } from "vitest";

import {
  InquirerRecorderPrompt,
  type PromptFunctions
} from "../../../src/adapters/prompt/inquirer-recorder-prompt.js";

function prompts(answers: unknown[]): PromptFunctions {
  const next = (): Promise<unknown> => Promise.resolve(answers.shift());
  return {
    select: vi.fn(next),
    input: vi.fn(next),
    confirm: vi.fn(next),
    number: vi.fn(next)
  };
}

describe("InquirerRecorderPrompt", () => {
  it("maps menu answers to the Recorder prompt contract", async () => {
    const functions = prompts(["click", "search", "up", 800, 0.7, 350]);
    const prompt = new InquirerRecorderPrompt(functions, { write: vi.fn() });

    await expect(prompt.selectAction()).resolves.toBe("click");
    await expect(prompt.selectTarget([{ id: "search", label: "Search" }]))
      .resolves.toBe("search");
    await expect(prompt.selectSwipeDirection()).resolves.toBe("up");
    await expect(prompt.longClickDuration()).resolves.toBe(800);
    await expect(prompt.swipeOptions()).resolves.toEqual({
      distancePercent: 0.7,
      durationMs: 350
    });
  });

  it("only returns a validated explicitly confirmed fallback label", async () => {
    const enabled = new InquirerRecorderPrompt(
      prompts([true, "#7"]),
      { write: vi.fn() }
    );
    const disabled = new InquirerRecorderPrompt(
      prompts([false]),
      { write: vi.fn() }
    );

    await expect(enabled.selectFallbackLabel("/tmp/screen.png"))
      .resolves.toBe("#7");
    await expect(disabled.selectFallbackLabel("/tmp/screen.png"))
      .resolves.toBeUndefined();
  });

  it("writes failures to the injected diagnostic stream", async () => {
    const output = { write: vi.fn(() => true) };
    const prompt = new InquirerRecorderPrompt(prompts([]), output);

    await prompt.notifyFailure("tap failed");

    expect(output.write).toHaveBeenCalledWith("TapHound: tap failed\n");
  });
});
