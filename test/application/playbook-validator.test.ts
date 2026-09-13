import { describe, expect, it, vi } from "vitest";

import { PlaybookValidator } from "../../src/application/playbook/playbook-validator.js";
import { hashContractText } from "../../src/application/contract/contract-loader.js";
import { hashJourney } from "../../src/domain/report.js";
import { JourneySchema } from "../../src/domain/journey.js";
import { PlaybookDefinitionSchema, type PlaybookDefinition } from "../../src/domain/playbook.js";

function parsePlaybook(text: string): PlaybookDefinition {
  return PlaybookDefinitionSchema.parse(JSON.parse(text));
}

const journeyFixture = {
  version: 2 as const,
  name: "Search",
  devices: [{ role: "default" }],
  steps: [{
    action: "click" as const,
    locator: { resourceId: "search" },
    activity: {
      before: "com.example.app.MainActivity",
      after: "com.example.app.SearchActivity"
    }
  }]
};

const contractText = JSON.stringify({
  version: 1,
  id: "search-opens",
  goal: "Tapping search opens the search screen",
  journey: {
    path: ".taphound/journeys/search.json",
    sha256: hashJourney(JourneySchema.parse(journeyFixture))
  },
  preconditions: [{ kind: "installed" }],
  assertions: [{
    type: "element",
    locator: { resourceId: "search" },
    visibility: "visible",
    timeoutMs: 2000
  }],
  evidenceRequirements: [{ kind: "screenshot", scope: "final" }]
});

function playbookText(contractSha: string): string {
  return JSON.stringify({
    version: 1,
    id: "search-fd",
    kind: "behavior-regression",
    goal: "Search results survive a detail round trip",
    phases: ["contract-verify", "baseline-capture", "change-apply", "replay-journey", "baseline-compare", "evidence-collect", "verdict-apply"],
    contract: {
      path: ".taphound/contracts/search.json",
      sha256: contractSha
    },
    evidenceRequirements: [{ kind: "screenshot", scope: "final" }],
    passCondition: "baseline-compare reports no regression",
    failCondition: "baseline-compare reports a regression",
    inconclusiveCondition: "baseline evidence is unavailable",
    escalation: {
      version: 1,
      rules: [{
        id: "deterministic-fail",
        when: { verdicts: ["fail"] },
        then: { action: "verdict", result: "fail" }
      }]
    }
  });
}

function files(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "/project/.taphound/contracts/search.json": contractText,
    "/project/.taphound/journeys/search.json": JSON.stringify(journeyFixture),
    "/project/.taphound/playbooks/search-fd.json": playbookText(
      hashContractText(contractText)
    ),
    ...extra
  };
}

function validatorWith(store: Record<string, string>): PlaybookValidator {
  return new PlaybookValidator({
    readText: vi.fn((path: string): Promise<string> => {
      const content = store[path];
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve(content);
    })
  });
}

describe("PlaybookValidator", () => {
  it("accepts a playbook whose Contract hash binding is fresh", async () => {
    const validator = validatorWith(files());
    const output = await validator.validate({
      projectRoot: "/project",
      playbookPaths: ["/project/.taphound/playbooks/search-fd.json"]
    });
    expect(output.status).toBe("valid");
    expect(output.playbooks[0]?.ok).toBe(true);
  });

  it("reports a drifted Contract binding", async () => {
    const validator = validatorWith(files({
      "/project/.taphound/playbooks/search-fd.json": playbookText(
        "f".repeat(64)
      )
    }));
    const output = await validator.validate({
      projectRoot: "/project",
      playbookPaths: ["/project/.taphound/playbooks/search-fd.json"]
    });
    expect(output.status).toBe("invalid");
    expect(output.playbooks[0]?.issues[0]).toContain("drifted");
  });

  it("reports a missing bound Contract", async () => {
    const validator = validatorWith(files({
      "/project/.taphound/playbooks/search-fd.json": playbookText(
        hashContractText(contractText)
      )
    }));
    const output = await validator.validate({
      projectRoot: "/project",
      playbookPaths: ["/project/.taphound/playbooks/search-fd.json"]
    });
    // contract exists; instead point playbook at a missing contract
    const missing = parsePlaybook(playbookText(hashContractText(contractText)));
    missing.contract.path = ".taphound/contracts/missing.json";
    const validator2 = validatorWith(files({
      "/project/.taphound/playbooks/search-fd.json": JSON.stringify(missing)
    }));
    const output2 = await validator2.validate({
      projectRoot: "/project",
      playbookPaths: ["/project/.taphound/playbooks/search-fd.json"]
    });
    expect(output.status).toBe("valid");
    expect(output2.status).toBe("invalid");
    expect(output2.playbooks[0]?.issues[0]).toContain("cannot be loaded");
  });

  it("rejects a malformed playbook JSON", async () => {
    const store = files({
      "/project/.taphound/playbooks/broken.json": "{not json"
    });
    const validator = validatorWith(store);
    const output = await validator.validate({
      projectRoot: "/project",
      playbookPaths: ["/project/.taphound/playbooks/broken.json"]
    });
    expect(output.status).toBe("invalid");
    expect(output.playbooks[0]?.id).toBe("/project/.taphound/playbooks/broken.json");
  });

  it("warns when a rule escalates a deterministic pass to semantic", async () => {
    const playbook = parsePlaybook(playbookText(hashContractText(contractText)));
    playbook.escalation.rules.push({
      id: "pass-to-semantic",
      when: { verdicts: ["pass"] },
      then: { action: "escalate", target: "semantic" }
    });
    const validator = validatorWith(files({
      "/project/.taphound/playbooks/search-fd.json": JSON.stringify(playbook)
    }));
    const output = await validator.validate({
      projectRoot: "/project",
      playbookPaths: ["/project/.taphound/playbooks/search-fd.json"]
    });
    expect(output.status).toBe("invalid");
    expect(output.playbooks[0]?.issues.some((issue) => (
      issue.includes("pass-to-semantic")
    ))).toBe(true);
  });
});