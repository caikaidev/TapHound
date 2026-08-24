import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  InquirerAlignPrompt,
  type AlignDiagnosticStream,
  type AlignInputStream,
  type AlignPromptFunctions
} from "../../../src/adapters/prompt/inquirer-align-prompt.js";
import { AlignPromptCancelledError } from "../../../src/ports/align-prompt.js";
import type { CameraProbeResult } from "../../../src/ports/camera-probe.js";

const values: CameraProbeResult = {
  packageName: "com.android.camera",
  activityName: "com.android.camera.CameraActivity",
  shutterResourceId: "shutter_button",
  shutterContentDescription: "Shutter"
};

function streams(
  inputIsTTY = true,
  outputIsTTY = true
): {
  input: AlignInputStream;
  output: AlignDiagnosticStream;
} {
  const inputStream = new PassThrough() as AlignInputStream;
  const outputStream = new PassThrough() as AlignDiagnosticStream;
  inputStream.isTTY = inputIsTTY;
  outputStream.isTTY = outputIsTTY;
  return { input: inputStream, output: outputStream };
}

function promptFunctions(
  impl: () => Promise<unknown>
): AlignPromptFunctions {
  return { confirm: vi.fn(impl) };
}

describe("AlignPromptCancelledError", () => {
  it("is an Error subclass with the expected name", () => {
    const error = new AlignPromptCancelledError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AlignPromptCancelledError");
  });
});

describe("InquirerAlignPrompt.confirmWrite", () => {
  it("returns the boolean answer and routes the prompt through stderr", async () => {
    const io = streams();
    const prompts = promptFunctions(() => Promise.resolve(true));
    const prompt = new InquirerAlignPrompt(prompts, io.input, io.output);

    await expect(prompt.confirmWrite({
      values,
      targetPath: ".taphound/flows/external/camera.json"
    })).resolves.toBe(true);

    expect(prompts.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ default: true }),
      { input: io.input, output: io.output }
    );
    const message = vi.mocked(prompts.confirm).mock.calls[0]?.[0].message ?? "";
    expect(message).toContain(
      "Write flow to .taphound/flows/external/camera.json?"
    );
  });

  it("formats probe values including an optional confirm button", async () => {
    const io = streams();
    const prompts = promptFunctions(() => Promise.resolve(false));
    const prompt = new InquirerAlignPrompt(prompts, io.input, io.output);
    const withConfirm: CameraProbeResult = {
      ...values,
      confirmResourceId: "confirm_button",
      confirmContentDescription: "Confirm"
    };

    await prompt.confirmWrite({ values: withConfirm, targetPath: "camera.json" });

    const message = vi.mocked(prompts.confirm).mock.calls[0]?.[0].message ?? "";
    expect(message).toContain("com.android.camera");
    expect(message).toContain("com.android.camera.CameraActivity");
    expect(message).toContain("shutter_button");
    expect(message).toContain("(Shutter)");
    expect(message).toContain("confirm_button");
    expect(message).toContain("(Confirm)");
  });

  it("notes when no confirm button is present", async () => {
    const io = streams();
    const prompts = promptFunctions(() => Promise.resolve(true));
    const prompt = new InquirerAlignPrompt(prompts, io.input, io.output);

    await prompt.confirmWrite({ values, targetPath: "camera.json" });

    const message = vi.mocked(prompts.confirm).mock.calls[0]?.[0].message ?? "";
    expect(message).toContain("(none");
    expect(message).not.toContain("Confirm button:    confirm");
  });

  it.each([
    ["piped stdin", false, true],
    ["non-TTY diagnostics", true, false]
  ] as const)("rejects %s before invoking a prompt", async (
    _name,
    inputIsTTY,
    outputIsTTY
  ) => {
    const io = streams(inputIsTTY, outputIsTTY);
    const prompts = promptFunctions(() => Promise.resolve(true));
    const prompt = new InquirerAlignPrompt(prompts, io.input, io.output);

    await expect(prompt.confirmWrite({
      values,
      targetPath: "camera.json"
    })).rejects.toThrow(/TTY/i);
    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  it("throws AlignPromptCancelledError on AbortPromptError", async () => {
    const io = streams();
    const prompts = promptFunctions(() => Promise.reject(
      Object.assign(new Error("aborted"), { name: "AbortPromptError" })
    ));
    const prompt = new InquirerAlignPrompt(prompts, io.input, io.output);

    await expect(prompt.confirmWrite({
      values,
      targetPath: "camera.json"
    })).rejects.toBeInstanceOf(AlignPromptCancelledError);
  });

  it("throws AlignPromptCancelledError on ExitPromptError (Ctrl-C)", async () => {
    const io = streams();
    const prompts = promptFunctions(() => Promise.reject(
      Object.assign(new Error("exit"), { name: "ExitPromptError" })
    ));
    const prompt = new InquirerAlignPrompt(prompts, io.input, io.output);

    await expect(prompt.confirmWrite({
      values,
      targetPath: "camera.json"
    })).rejects.toBeInstanceOf(AlignPromptCancelledError);
  });

  it("rejects non-boolean prompt answers", async () => {
    const io = streams();
    const prompts = promptFunctions(() => Promise.resolve("yes"));
    const prompt = new InquirerAlignPrompt(prompts, io.input, io.output);

    await expect(prompt.confirmWrite({
      values,
      targetPath: "camera.json"
    })).rejects.toThrow(/invalid answer/i);
  });
});
