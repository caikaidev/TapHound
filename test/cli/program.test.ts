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

  it("publishes the doctor, record, and verify commands", () => {
    const names = createProgram().commands.map((command) => command.name());

    expect(names).toEqual(["doctor", "record", "verify"]);
  });
});
