import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";

describe("createProgram", () => {
  it("uses the TapHound command identity", () => {
    const program = createProgram();

    expect(program.name()).toBe("taphound");
    expect(program.description()).toBe(
      "Deterministic app journey recording and verification"
    );
  });

  it("publishes commands in stable order, including Journey composition", () => {
    const names = createProgram().commands.map((command) => command.name());

    expect(names).toEqual([
      "doctor",
      "record",
      "verify",
      "project",
      "context",
      "journey",
      "generation",
      "init"
    ]);
    expect(
      createProgram().commands.find((command) => command.name() === "project")
        ?.commands.map((command) => command.name())
    ).toEqual(["describe"]);
    expect(
      createProgram().commands.find((command) => command.name() === "context")
        ?.commands.map((command) => command.name())
    ).toEqual(["validate", "status", "list", "refresh"]);
    expect(
      createProgram().commands.find((command) => command.name() === "journey")
        ?.commands.map((command) => command.name())
    ).toEqual(["resolve", "list-flows"]);
    expect(
      createProgram().commands.find((command) => command.name() === "generation")
        ?.commands.map((command) => command.name())
    ).toEqual([
      "start",
      "observe",
      "step",
      "confirm",
      "manual",
      "status",
      "recover",
      "finalize"
    ]);
  });
});
