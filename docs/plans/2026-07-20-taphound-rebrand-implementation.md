# TapHound Rebrand and Dev Prerelease Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Completely rename the unreleased APR codebase to TapHound, deliver the approved HoundMark brand Icon, keep wire schemas at v1, prepare an Apache-2.0 npm package, connect the existing GitHub repository, and publish only `taphound@0.2.0-dev.1` under the `dev` dist-tag.

**Architecture:** Treat the rebrand as a breaking source and tooling migration with no compatibility aliases. Rename public TypeScript identifiers and every active CLI/config/artifact/demo contract while preserving the deterministic recorder/replay architecture and JSON schema versions; keep brand assets isolated under `assets/brand/` with automated structural checks and manual small-size review. Keep local code changes, GitHub mutation, and irreversible npm publication as separate verified phases with explicit approval gates.

**Tech Stack:** TypeScript 6, Node.js 22 ESM, Commander, Zod, Vitest, SVG, PNG, Sharp (development-only export tool), npm, Git, Android Gradle demo, Apache-2.0.

---

## Execution rules

- Start from clean `main` at or after commit `6d454f2` and use `superpowers:using-git-worktrees` to create a `codex/taphound-rebrand` worktree. Never implement directly in the primary checkout.
- Preserve the Journey/config/report JSON field shapes and their schema version `1`; this is a brand migration, not a protocol v2.
- Do not add an `apr` binary, `apr.config.json` fallback, `.apr` fallback, `APR_*` environment alias, or deprecated `Apr*` export.
- Keep `apr verify --json`'s existing behavioral contract under its new spelling, `taphound verify --json`: one JSON value on stdout, diagnostics on stderr, and exit codes 0–4.
- Use TDD for each code-facing task: red test, minimal rename, green test, focused commit.
- Do not publish to GitHub or npm from a feature worktree. Complete local review and integration first.
- Immediately before the first GitHub push and immediately before `npm publish`, pause for explicit user confirmation. These are two separate gates.
- Use `superpowers:verification-before-completion` before claiming the source migration is complete, and `superpowers:finishing-a-development-branch` before integrating it.
- Use `@imagegen` only for HoundMark concept exploration; the reviewed vector SVG remains the source of truth and all PNG files must be rendered from it.

### Task 1: Lock the npm and CLI brand contract

**Files:**
- Create: `test/package-metadata.test.ts`
- Modify: `test/cli/program.test.ts`
- Modify: `src/cli/program.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Write the failing package metadata test**

Create `test/package-metadata.test.ts`:

```ts
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageDocument {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  description?: string;
}

describe("TapHound package metadata", () => {
  it("publishes only the taphound executable", async () => {
    const document = JSON.parse(
      await readFile("package.json", "utf8")
    ) as PackageDocument;

    expect(document.name).toBe("taphound");
    expect(document.version).toBe("0.2.0-dev.1");
    expect(document.description)
      .toBe("Deterministic app journey recording and verification");
    expect(document.bin).toEqual({ taphound: "./dist/cli/main.js" });
    expect(document.bin).not.toHaveProperty("apr");
  });
});
```

Extend `test/cli/program.test.ts`:

```ts
it("uses the TapHound command identity", () => {
  const program = createProgram();

  expect(program.name()).toBe("taphound");
  expect(program.description()).toBe(
    "Deterministic app journey recording and verification"
  );
});
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm test -- test/package-metadata.test.ts test/cli/program.test.ts
```

Expected: FAIL showing `android-project-runtime`, version `0.2.0`, and command name `apr`.

**Step 3: Apply the minimal package and program rename**

Change `package.json` to include:

```json
{
  "name": "taphound",
  "version": "0.2.0-dev.1",
  "description": "Deterministic app journey recording and verification",
  "bin": {
    "taphound": "./dist/cli/main.js"
  }
}
```

Change `src/cli/program.ts`:

```ts
return new Command()
  .name("taphound")
  .description("Deterministic app journey recording and verification")
```

Regenerate only npm lock metadata:

```bash
npm install --package-lock-only --ignore-scripts
```

Check that both top-level lockfile package names are `taphound` and the only lockfile binary key is `taphound`.

**Step 4: Run focused verification**

Run:

```bash
npm test -- test/package-metadata.test.ts test/cli/program.test.ts
npm run typecheck
```

Expected: both test files PASS and typecheck exits 0.

**Step 5: Commit**

```bash
git add package.json package-lock.json src/cli/program.ts test/package-metadata.test.ts test/cli/program.test.ts
git commit -m "chore: rename package and CLI to TapHound"
```

### Task 2: Rename public TypeScript domain identifiers

**Files:**
- Modify: `src/domain/config.ts`
- Modify: `src/domain/report.ts`
- Modify: `src/domain/failure.ts`
- Modify: `src/application/recorder/recorder-service.ts`
- Modify: `src/application/report/report-writer.ts`
- Modify: `src/application/runtime/verify-runtime.ts`
- Modify: `src/cli/commands/record.ts`
- Modify: `src/cli/commands/verify.ts`
- Modify: `test/domain/config.test.ts`
- Modify: `test/domain/report.test.ts`
- Modify: `test/domain/failure.test.ts`
- Modify: `test/fixtures/report.ts`
- Modify: `test/fakes/runtime-fixture.ts`
- Modify: `test/docs/examples.test.ts`
- Modify: `test/acceptance/fixture-contract.test.ts`

**Step 1: Rename imports and expectations in the domain tests first**

Use only these new exported identifiers:

```ts
TapHoundConfigSchema
TapHoundConfig
TapHoundReportSchema
TapHoundReport
TapHoundExitCode
```

For example, `test/domain/config.test.ts` must import and describe:

```ts
import { TapHoundConfigSchema } from "../../src/domain/config.js";

describe("TapHoundConfigSchema", () => {
  it("parses a valid v1 configuration", () => {
    expect(TapHoundConfigSchema.parse(validConfig)).toEqual(validConfig);
  });
});
```

Do the equivalent for report and failure tests. Do not change JSON keys or schema version literals.

**Step 2: Run the domain tests to verify the new exports do not exist**

Run:

```bash
npm test -- test/domain/config.test.ts test/domain/report.test.ts test/domain/failure.test.ts
```

Expected: FAIL because the `TapHound*` exports have not been defined.

**Step 3: Rename the source exports and all internal consumers**

In `src/domain/config.ts`:

```ts
export const TapHoundConfigSchema = z.strictObject({
  // Keep the complete existing v1 shape unchanged.
});

export type TapHoundConfig = z.infer<typeof TapHoundConfigSchema>;
```

In `src/domain/report.ts`:

```ts
export const TapHoundReportSchema = z.strictObject({
  // Keep the complete existing v1 shape unchanged.
});

export type TapHoundReport = z.infer<typeof TapHoundReportSchema>;
```

In `src/domain/failure.ts`:

```ts
export type TapHoundExitCode = 1 | 2 | 3 | 4;

const EXIT_CODES = {
  // Keep every existing mapping unchanged.
} as const satisfies Record<FailureCode, TapHoundExitCode>;

export function exitCodeForFailure(
  failure: FailureCode
): TapHoundExitCode {
  return EXIT_CODES[failure];
}
```

Update every listed source, fixture, and test import/type reference. Do not export aliases with the old names.

**Step 4: Verify domain behavior and stale public identifiers**

Run:

```bash
npm test -- test/domain test/application/runtime/verify-runtime.test.ts test/application/report/report-writer.test.ts
npm run typecheck
rg -n '\bApr(Config|Report|ExitCode)' src test
```

Expected: tests PASS, typecheck exits 0, and `rg` returns no matches.

**Step 5: Commit**

```bash
git add src test
git commit -m "refactor: rename public domain types to TapHound"
```

### Task 3: Rename user-facing CLI defaults, diagnostics, and local paths

**Files:**
- Modify: `test/cli/commands.test.ts`
- Modify: `test/cli/main.test.ts`
- Modify: `test/cli/verify-json.test.ts`
- Modify: `test/adapters/prompt/inquirer-recorder-prompt.test.ts`
- Modify: `test/application/report/report-writer.test.ts`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `src/cli/commands/record.ts`
- Modify: `src/cli/commands/verify.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/adapters/prompt/inquirer-recorder-prompt.ts`
- Modify: `src/application/doctor/doctor-service.ts`
- Modify: `src/application/report/report-writer.ts`
- Modify: `src/cli/dependencies.ts`
- Modify: `test/fakes/artifact-store.ts`
- Modify: `test/fakes/runtime-fixture.ts`
- Modify: `.gitignore`

**Step 1: Change tests to express the new visible contract**

Update CLI argv values from `apr` to `taphound`, config paths to `taphound.config.json`, report paths to `taphound-*`, and diagnostics to `TapHound:`. Add these assertions to `test/cli/commands.test.ts`:

```ts
expect(recordCommand.options.find(
  (option) => option.long === "--config"
)?.defaultValue).toBe("taphound.config.json");

expect(verifyCommand.options.find(
  (option) => option.long === "--config"
)?.defaultValue).toBe("taphound.config.json");
```

Update `test/application/report/report-writer.test.ts` to expect:

```ts
await expect(readFile(summaryPath, "utf8"))
  .resolves.toContain("TapHound run run-123: PASSED");
```

Update the prompt test to expect `TapHound: tap failed\n`.

**Step 2: Run focused tests and verify the old strings fail**

Run:

```bash
npm test -- test/cli/commands.test.ts test/cli/main.test.ts test/cli/verify-json.test.ts test/adapters/prompt/inquirer-recorder-prompt.test.ts test/application/report/report-writer.test.ts
```

Expected: FAIL on old config defaults and `APR` diagnostics.

**Step 3: Rename all active user-facing source strings**

Apply these exact contracts:

```ts
// record.ts
.description("Interactively record a TapHound Journey")
.option("--config <path>", "TapHound config path", "taphound.config.json")

// verify.ts
.description("Deterministically verify a TapHound Journey")
.option("--config <path>", "TapHound config path", "taphound.config.json")
.requiredOption("--journey <path>", "TapHound Journey path")
writeLine(dependencies.stderr, `TapHound: verifying ${journey.name}`);

// doctor.ts
.description("Check TapHound tools, permissions, project, and device")

// main.ts
controller.abort(new Error("TapHound was interrupted"));
```

Use `TapHound environment preflight failed`, `TapHound requires Node.js 22 or newer`, `Choose the next TapHound Action`, and `TapHound run ...` in their current matching locations. Change `apr-doctor-` to `taphound-doctor-`, fake report directories to `/tmp/taphound-run` and `/reports/taphound-run`, fixture log text to `TapHound: ready`, and `.gitignore` from `.apr/` to `.taphound/`.

**Step 4: Run focused and source-staleness checks**

Run:

```bash
npm test -- test/cli test/adapters/prompt/inquirer-recorder-prompt.test.ts test/application/doctor/doctor-service.test.ts test/application/report/report-writer.test.ts
npm run typecheck
rg -n '\bAPR\b|\bapr\b|\.apr|apr\.config' src .gitignore test/cli test/application test/adapters test/fakes
```

Expected: tests PASS, typecheck exits 0, and the scoped `rg` command returns no product-name matches.

**Step 5: Commit**

```bash
git add .gitignore src test
git commit -m "refactor: rename TapHound CLI contracts"
```

### Task 4: Rename the real-process fixture and environment contract

**Files:**
- Rename: `test/fixtures/bin/fake-apr-tool.mjs` → `test/fixtures/bin/fake-taphound-tool.mjs`
- Modify: `test/fixtures/bin/fake-taphound-tool.mjs`
- Modify: `test/fixtures/bin/fake-command.mjs`
- Modify: `test/cli/verify-process.test.ts`
- Modify: `test/adapters/process/node-process-runner.test.ts`

**Step 1: Change the process tests before the fixture**

In `test/cli/verify-process.test.ts`, expect:

```ts
const fakeTool = join(
  repositoryRoot,
  "test",
  "fixtures",
  "bin",
  "fake-taphound-tool.mjs"
);

// fixture environment
TAPHOUND_FAKE_ROOT: test.root

describe("built taphound verify --json process contract", () => {
  // Existing exit 0–4 tests remain unchanged in behavior.
});
```

Rename all fake controls to `TAPHOUND_FAKE_ROOT`, `TAPHOUND_FAKE_GRADLE_EXIT`, and `TAPHOUND_FAKE_DEVICE`; rename generic test forwarding to `TAPHOUND_TEST_VALUE`. Change temporary prefixes to `taphound-process-test-` and the config filename to `taphound.config.json`.

**Step 2: Run tests to verify the fixture contract is red**

Run:

```bash
npm test -- test/cli/verify-process.test.ts test/adapters/process/node-process-runner.test.ts
```

Expected: FAIL because the renamed fixture and environment variables do not exist yet.

**Step 3: Rename and update the fixture**

Run:

```bash
git mv test/fixtures/bin/fake-apr-tool.mjs test/fixtures/bin/fake-taphound-tool.mjs
```

Update the fixture to read only the `TAPHOUND_*` variables and emit only TapHound diagnostics:

```js
const root = process.env.TAPHOUND_FAKE_ROOT;

if (root === undefined) {
  fail("TAPHOUND_FAKE_ROOT is required");
}
```

Keep the existing fake Android/ADB/Gradle behavior and exit mapping unchanged. Update `fake-command.mjs` to read `TAPHOUND_TEST_VALUE`.

**Step 4: Verify the built-process contract**

Run:

```bash
npm test -- test/cli/verify-process.test.ts test/adapters/process/node-process-runner.test.ts
rg -n 'APR_|fake-apr|apr-process|apr\.config' test/fixtures test/cli/verify-process.test.ts test/adapters/process/node-process-runner.test.ts
```

Expected: tests PASS and `rg` returns no matches.

**Step 5: Commit**

```bash
git add test/fixtures test/cli/verify-process.test.ts test/adapters/process/node-process-runner.test.ts
git commit -m "test: rename TapHound process fixtures"
```

### Task 5: Rename the Android acceptance app and standalone examples

**Files:**
- Rename: `examples/apr-demo/` → `examples/taphound-android-demo/`
- Rename: `examples/taphound-android-demo/apr.config.json` → `examples/taphound-android-demo/taphound.config.json`
- Rename: `examples/taphound-android-demo/app/src/main/java/dev/apr/demo/` → `examples/taphound-android-demo/app/src/main/java/dev/taphound/demo/`
- Rename: `examples/apr.config.json` → `examples/taphound.config.json`
- Modify: `examples/taphound-android-demo/app/build.gradle.kts`
- Modify: `examples/taphound-android-demo/app/src/main/AndroidManifest.xml`
- Modify: `examples/taphound-android-demo/app/src/main/java/dev/taphound/demo/MainActivity.kt`
- Modify: `examples/taphound-android-demo/app/src/main/java/dev/taphound/demo/SearchActivity.kt`
- Modify: `examples/taphound-android-demo/journeys/search.json`
- Modify: `examples/taphound-android-demo/settings.gradle.kts`
- Modify: `examples/taphound-android-demo/taphound.config.json`
- Modify: `examples/taphound.config.json`
- Modify: `scripts/acceptance-device.mjs`
- Modify: `test/acceptance/fixture-contract.test.ts`
- Modify: `test/docs/examples.test.ts`

**Step 1: Update acceptance expectations first**

Make `test/acceptance/fixture-contract.test.ts` use root `examples/taphound-android-demo`, config `taphound.config.json`, Java path `dev/taphound/demo`, and identity:

```ts
expect(config.run).toEqual({
  packageName: "dev.taphound.demo",
  activity: ".MainActivity"
});
expect(appBuild).toContain('namespace = "dev.taphound.demo"');
expect(appBuild).toContain('applicationId = "dev.taphound.demo"');
```

Expect `TAPHOUND_ACCEPTANCE_DEVICE` in the runner. Update `test/docs/examples.test.ts` to read `examples/taphound.config.json` and expect `.taphound/`.

**Step 2: Run contract tests to verify old paths fail**

Run:

```bash
npm test -- test/acceptance/fixture-contract.test.ts test/docs/examples.test.ts
```

Expected: FAIL on missing TapHound paths and old package identity.

**Step 3: Move the tracked example paths**

Run:

```bash
git mv examples/apr-demo examples/taphound-android-demo
git mv examples/taphound-android-demo/apr.config.json examples/taphound-android-demo/taphound.config.json
mkdir -p examples/taphound-android-demo/app/src/main/java/dev/taphound
git mv examples/taphound-android-demo/app/src/main/java/dev/apr/demo examples/taphound-android-demo/app/src/main/java/dev/taphound/demo
git mv examples/apr.config.json examples/taphound.config.json
```

Remove now-empty directories only after `find examples/taphound-android-demo/app/src/main/java -type f` confirms both Kotlin files exist at the new path.

**Step 4: Update demo and runner contents**

Use these identities everywhere in the moved Android app:

```text
rootProject.name = "TapHoundAndroidDemo"
namespace = "dev.taphound.demo"
applicationId = "dev.taphound.demo"
package dev.taphound.demo
android:label="TapHound Demo"
```

Update every Journey Activity checkpoint to `dev.taphound.demo.*`, name the Journey `TapHound demo search`, and set both example configs' `artifactsDir` to `.taphound/runs`.

In `scripts/acceptance-device.mjs`, use only:

```js
if (process.env.TAPHOUND_ACCEPTANCE_DEVICE !== "1") {
  process.stderr.write(
    "Skipping device acceptance. Set TAPHOUND_ACCEPTANCE_DEVICE=1 to opt in.\n"
  );
  process.exit(0);
}

const projectRoot = resolve(
  repositoryRoot,
  "examples",
  "taphound-android-demo"
);
```

Use `taphound.config.json` and TapHound error messages throughout the runner.

**Step 5: Verify examples and Gradle fixture structure**

Run:

```bash
npm test -- test/acceptance/fixture-contract.test.ts test/docs/examples.test.ts
find examples/taphound-android-demo -type f | sort
rg -n '\bAPR\b|\bapr\b|APR_|dev\.apr|\.apr|apr\.config' examples scripts test/acceptance
```

Expected: tests PASS, both Kotlin files are under `dev/taphound/demo`, the wrapper remains executable, and `rg` returns no matches.

**Step 6: Commit**

```bash
git add examples scripts test/acceptance test/docs/examples.test.ts
git commit -m "test: rename Android demo to TapHound"
```

### Task 6: Rewrite active documentation and archive the APR source material

**Files:**
- Modify: `README.md`
- Modify: `docs/agent-integration.md`
- Modify: `docs/journey-schema.md`
- Modify: `docs/report-schema.md`
- Rename: `docs/verification/apr-v0.2-audit.md` → `docs/verification/taphound-v0.2-audit.md`
- Create by safe move: `docs/archive/apr-v0.2/APR-Design-v0.2.md`
- Rename: `docs/plans/2026-07-19-apr-v0.2-design.md` → `docs/archive/apr-v0.2/2026-07-19-apr-v0.2-design.md`
- Rename: `docs/plans/2026-07-19-apr-v0.2-implementation.md` → `docs/archive/apr-v0.2/2026-07-19-apr-v0.2-implementation.md`
- Modify: `test/docs/examples.test.ts`

**Step 1: Strengthen documentation tests before rewriting prose**

Update `test/docs/examples.test.ts` to require:

```ts
expect(readme).toContain("# TapHound");
expect(readme).toContain("TapHound for Android");
expect(readme).toContain("Follow every tap. Catch every regression.");
expect(readme).toContain("TapHound Journey");
expect(readme).toContain("Android CLI 官方 Journey");
expect(readme).not.toMatch(/\bAPR\b|\bapr\b/);

for (const command of commandNames) {
  expect(readme).toContain(`taphound ${command}`);
}

expect(agent).toContain("taphound verify");
expect(agent).not.toMatch(/\bAPR\b|\bapr\b/);
```

Also require `docs/journey-schema.md` and `docs/report-schema.md` to use the TapHound name and current command/config paths.

**Step 2: Run documentation tests to verify they fail**

Run:

```bash
npm test -- test/docs/examples.test.ts
```

Expected: FAIL on the old README title, CLI examples, and schema prose.

**Step 3: Safely archive the user-owned root specification**

Before touching the untracked root file, record its digest:

```bash
shasum -a 256 APR-Design-v0.2.md
mkdir -p docs/archive/apr-v0.2
git add APR-Design-v0.2.md
git mv APR-Design-v0.2.md docs/archive/apr-v0.2/APR-Design-v0.2.md
shasum -a 256 docs/archive/apr-v0.2/APR-Design-v0.2.md
```

Expected: the two SHA-256 values are identical. If they differ or the source file is absent, stop; do not synthesize or delete content.

Archive the historical tracked APR plans:

```bash
git mv docs/plans/2026-07-19-apr-v0.2-design.md docs/archive/apr-v0.2/2026-07-19-apr-v0.2-design.md
git mv docs/plans/2026-07-19-apr-v0.2-implementation.md docs/archive/apr-v0.2/2026-07-19-apr-v0.2-implementation.md
git mv docs/verification/apr-v0.2-audit.md docs/verification/taphound-v0.2-audit.md
```

Historical files under `docs/archive/apr-v0.2/` remain unchanged and are the only broad APR-name exemption.

**Step 4: Rewrite active docs around TapHound**

Use this brand block in `README.md`:

```md
# TapHound

> Follow every tap. Catch every regression.

TapHound is a TypeScript/Node.js CLI for deterministic app journey
recording and verification. The first release, TapHound for Android,
records and replays native Android workflows.
```

Translate the remaining active documentation consistently:

- CLI: `taphound doctor|record|verify`
- config: `taphound.config.json`
- artifacts: `.taphound/runs`
- protocol names: TapHound Journey and TapHound Report
- first platform: native Android; future platform support is directional, not promised functionality
- deterministic positioning: self-built Journey semantics, incompatible with the Android CLI official Journey concept
- future Skill/SubAgent integration remains out of v0.2

Update links in `docs/verification/taphound-v0.2-audit.md` to the archived v0.2 documents and describe APR only once as the former internal codename. Do not alter wire-schema examples except for names and paths.

**Step 5: Verify docs and stale-name whitelist**

Run:

```bash
npm test -- test/docs/examples.test.ts
rg -n '\bAPR\b|\bapr\b|Apr[A-Z]|APR_|android-project-runtime|\.apr|apr\.config|examples/apr-demo|dev\.apr' README.md src test examples scripts docs/agent-integration.md docs/journey-schema.md docs/report-schema.md docs/verification package.json package-lock.json .gitignore
```

Expected: documentation test PASS. The stale-name audit returns at most the single explicit former-codename sentence in `docs/verification/taphound-v0.2-audit.md`; it must return no executable, config, path, identifier, package, or environment compatibility surface.

Review the intentional migration vocabulary separately:

```bash
rg -n '\bAPR\b|\bapr\b' docs/plans/2026-07-20-taphound-rebrand-design.md docs/plans/2026-07-20-taphound-rebrand-implementation.md docs/archive/apr-v0.2
```

Expected: matches are documentation-only migration/history references.

**Step 6: Commit**

```bash
git add README.md docs test/docs/examples.test.ts
git commit -m "docs: migrate active documentation to TapHound"
```

Verify `git status --short` before committing: the archived source must be staged under `docs/archive/apr-v0.2/`, and the old root path must no longer exist.

### Task 7: Add Apache-2.0 and release-safe npm metadata

**Files:**
- Create: `LICENSE`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/package-metadata.test.ts`

**Step 1: Extend the package test with release metadata requirements**

Extend the `PackageDocument` interface and test:

```ts
expect(document).toMatchObject({
  license: "Apache-2.0",
  repository: {
    type: "git",
    url: "git+https://github.com/caikaidev/TapHound.git"
  },
  bugs: {
    url: "https://github.com/caikaidev/TapHound/issues"
  },
  homepage: "https://github.com/caikaidev/TapHound#readme",
  publishConfig: {
    access: "public",
    tag: "dev"
  }
});
expect(document.files).toEqual(expect.arrayContaining(["dist"]));
expect(document.scripts?.prepublishOnly)
  .toBe("npm test && npm run typecheck && npm run lint && npm run build");
```

Read `LICENSE` and assert that it contains `Apache License`, `Version 2.0`, and the official Apache URL.

**Step 2: Run the package test to verify it fails**

Run:

```bash
npm test -- test/package-metadata.test.ts
```

Expected: FAIL because license/repository/publish metadata and `LICENSE` are absent.

**Step 3: Add the official Apache-2.0 text and package metadata**

Create `LICENSE` using the unmodified Apache License 2.0 text from `https://www.apache.org/licenses/LICENSE-2.0.txt`.

Add to `package.json`:

```json
{
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/caikaidev/TapHound.git"
  },
  "bugs": {
    "url": "https://github.com/caikaidev/TapHound/issues"
  },
  "homepage": "https://github.com/caikaidev/TapHound#readme",
  "keywords": [
    "android",
    "testing",
    "regression-testing",
    "journey",
    "cli",
    "ai-agent"
  ],
  "publishConfig": {
    "access": "public",
    "tag": "dev"
  },
  "scripts": {
    "prepublishOnly": "npm test && npm run typecheck && npm run lint && npm run build"
  }
}
```

Retain all existing scripts/dependencies and regenerate the lockfile metadata:

```bash
npm install --package-lock-only --ignore-scripts
```

**Step 4: Verify package metadata and licensing**

Run:

```bash
npm test -- test/package-metadata.test.ts
npm pkg get name version license repository publishConfig bin
npm pack --dry-run --json
```

Expected: test PASS; metadata names TapHound; dry-run reports `taphound@0.2.0-dev.1`, includes `dist`, `README.md`, `LICENSE`, and excludes `src`, `test`, `.env`, `.taphound`, and archived design sources.

**Step 5: Commit**

```bash
git add LICENSE package.json package-lock.json test/package-metadata.test.ts
git commit -m "chore: prepare Apache licensed dev package"
```

### Task 8: Create and validate the HoundMark brand Icon

**Files:**
- Create: `assets/brand/README.md`
- Create: `assets/brand/taphound-icon.svg`
- Create: `assets/brand/taphound-icon-dark.svg`
- Create: `assets/brand/taphound-mark.svg`
- Create: `assets/brand/taphound-mark-mono-dark.svg`
- Create: `assets/brand/taphound-mark-mono-light.svg`
- Create: `assets/brand/png/taphound-icon-1024.png`
- Create: `assets/brand/png/taphound-icon-512.png`
- Create: `assets/brand/png/taphound-icon-256.png`
- Create: `assets/brand/png/taphound-icon-128.png`
- Create: `assets/brand/png/taphound-icon-64.png`
- Create: `assets/brand/png/taphound-icon-32.png`
- Create: `scripts/render-brand-assets.mjs`
- Create: `test/brand/assets.test.ts`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Write the failing brand asset contract test**

Create `test/brand/assets.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const brandRoot = join(root, "assets", "brand");
const svgFiles = [
  "taphound-icon.svg",
  "taphound-icon-dark.svg",
  "taphound-mark.svg",
  "taphound-mark-mono-dark.svg",
  "taphound-mark-mono-light.svg"
] as const;
const pngSizes = [1024, 512, 256, 128, 64, 32] as const;

function pngDimensions(content: Buffer): {
  width: number;
  height: number;
} {
  expect(content.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  );
  return {
    width: content.readUInt32BE(16),
    height: content.readUInt32BE(20)
  };
}

describe("TapHound brand assets", () => {
  it("keeps every SVG standalone and safe", async () => {
    for (const filename of svgFiles) {
      const svg = await readFile(join(brandRoot, filename), "utf8");

      expect(svg).toContain('viewBox="0 0 1024 1024"');
      expect(svg).toMatch(/<title(?:\s[^>]*)?>TapHound/);
      expect(svg).not.toMatch(
        /<(?:script|image|filter|text)\b|\bhref=|\burl\(/i
      );
    }
  });

  it("uses only the approved primary palette", async () => {
    const svg = await readFile(
      join(brandRoot, "taphound-icon.svg"),
      "utf8"
    );
    const colors = [...new Set(
      [...svg.matchAll(/#[\dA-F]{6}/g)].map(([color]) => color)
    )].sort();

    expect(colors).toEqual(["#1B1D21", "#FF5A1F", "#FFF8F2"].sort());
  });

  it.each(pngSizes)("exports a %d px square PNG", async (size) => {
    const png = await readFile(join(
      brandRoot,
      "png",
      `taphound-icon-${String(size)}.png`
    ));

    expect(pngDimensions(png)).toEqual({ width: size, height: size });
  });

  it("wires the mark into README and npm files", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const packageDocument = JSON.parse(
      await readFile(join(root, "package.json"), "utf8")
    ) as { files?: string[] };

    expect(readme).toContain("assets/brand/taphound-mark.svg");
    expect(packageDocument.files).toContain(
      "assets/brand/taphound-mark.svg"
    );
  });
});
```

**Step 2: Run the test to verify the assets are missing**

Run:

```bash
npm test -- test/brand/assets.test.ts
```

Expected: FAIL with `ENOENT` for `assets/brand/taphound-icon.svg`.

**Step 3: Generate a HoundMark concept reference**

Use `@imagegen` with this prompt; do not commit the generated raster as a source asset:

```text
Create a clean vector-logo concept sheet for “HoundMark”, the icon for
TapHound, a deterministic app journey recording and verification CLI.
Show three closely related refinements of one concept: an abstract hound
side profile moving right, its nose precisely aligned with a tap target
made from a solid dot and one broken ripple. Use bold filled geometric
shapes, strong negative space, minimal rounded corners, no thin strokes.
Palette only: charcoal #1B1D21, electric orange #FF5A1F, warm white
#FFF8F2. No words, letters, paw prints, gradients, shadows, devices,
Android robots, mascots, photorealism, or mockup backgrounds. The icon
must remain legible at 16–32 px and survive circular avatar cropping.
```

Inspect the three refinements and choose the one with the clearest hound muzzle/target separation at thumbnail size. Use it as a proportion reference, not as an auto-traced final file.

**Step 4: Draw the standalone SVG sources**

Create the five SVG files according to `docs/plans/2026-07-20-taphound-brand-icon-design.md`. Every file must start with this structure and use only filled vector geometry:

```svg
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 1024 1024"
     role="img"
     aria-labelledby="title">
  <title id="title">TapHound HoundMark</title>
  <!-- self-contained rect/path/circle geometry only -->
</svg>
```

Implementation requirements:

- Place all important geometry inside the central `768 × 768` safe area.
- Use one continuous filled charcoal hound silhouette facing right.
- Build the orange target from a filled center dot plus one broken filled ring; do not use a fragile thin stroke.
- Keep visible warm-white negative space between nose and target.
- Copy the reviewed geometry into each standalone variant; do not use external `<use>` links.
- Default square: warm-white background, charcoal hound, orange target.
- Dark square: charcoal background, warm-white hound, orange target.
- Transparent mark: charcoal hound and orange target.
- Monochrome marks: a single charcoal or warm-white fill while preserving target separation through negative space.
- Optimize path precision to at most two decimal places after visual approval.

Create `assets/brand/README.md` with the three exact colors, `128 px` safe area, minimum recommended size `32 px`, fixed right-facing orientation, default/dark/monochrome usage, and explicit prohibitions on stretching, recoloring, rotating, mirroring, shadows, and gradients.

**Step 5: Add deterministic PNG rendering**

Install Sharp as a development-only dependency:

```bash
npm install --save-dev sharp
```

Add these package entries while preserving existing fields:

```json
{
  "files": [
    "dist",
    "assets/brand/taphound-mark.svg"
  ],
  "scripts": {
    "brand:render": "node scripts/render-brand-assets.mjs"
  }
}
```

Create `scripts/render-brand-assets.mjs`:

```js
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import sharp from "sharp";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(
  repositoryRoot,
  "assets",
  "brand",
  "taphound-icon.svg"
);
const outputDirectory = resolve(
  repositoryRoot,
  "assets",
  "brand",
  "png"
);
const sizes = [1024, 512, 256, 128, 64, 32];

await mkdir(outputDirectory, { recursive: true });
const source = await readFile(sourcePath);
await Promise.all(sizes.map(async (size) => {
  await sharp(source, { density: 384 })
    .resize(size, size, { fit: "fill" })
    .png({ compressionLevel: 9, palette: false })
    .toFile(resolve(
      outputDirectory,
      `taphound-icon-${String(size)}.png`
    ));
}));
```

**Step 6: Render assets and make the automated contract green**

Run:

```bash
npm run brand:render
npm test -- test/brand/assets.test.ts test/package-metadata.test.ts test/docs/examples.test.ts
npm run typecheck
npm run lint
```

Expected: six PNGs are generated; all focused tests PASS; typecheck and lint exit 0.

**Step 7: Perform the visual acceptance review**

Use `view_image` to inspect, at original detail:

- `assets/brand/taphound-icon.svg`
- `assets/brand/taphound-icon-dark.svg`
- `assets/brand/taphound-mark-mono-dark.svg`
- `assets/brand/png/taphound-icon-512.png`
- `assets/brand/png/taphound-icon-32.png`

Review against the approved design:

- right-facing hound and tap target are both identifiable
- nose/target negative space remains open at 32 px
- ear, muzzle, target ripple stay inside circular avatar crop
- dark and monochrome forms preserve the same silhouette
- no fox/wolf, pet-store, play-button, Android-only, or generic-arrow reading dominates

If any criterion fails, revise only the master geometry, propagate it to all SVG variants, rerun `npm run brand:render`, and repeat both automated and visual review. Do not hand-edit individual PNG sizes.

**Step 8: Add the mark to README and verify the npm file list**

Place this immediately above the README title:

```html
<p align="center">
  <img src="assets/brand/taphound-mark.svg" width="128" alt="TapHound HoundMark">
</p>
```

Run:

```bash
npm pack --dry-run --json
git status --short
```

Expected: the package contains `dist`, standard npm metadata files, and only `assets/brand/taphound-mark.svg` from the brand directory. It excludes concept rasters, PNG exports, tests, and the other SVG variants.

**Step 9: Commit**

```bash
git add assets/brand scripts/render-brand-assets.mjs test/brand/assets.test.ts README.md package.json package-lock.json
git commit -m "feat: add TapHound HoundMark assets"
```

### Task 9: Prove the packaged binary and complete the local migration gate

**Files:**
- Modify only if verification exposes a defect: the smallest relevant source/test file
- Create after all checks: `docs/verification/taphound-v0.2-dev.1-audit.md`

**Step 1: Run the complete source quality gate**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run brand:render
git diff --exit-code -- assets/brand/png
```

Expected: all 35+ test files and 211+ tests PASS, typecheck/lint/build exit 0, and rerendering the PNG set produces no diff. Record exact counts in the audit; do not copy the old counts if they changed.

**Step 2: Verify the built CLI identity**

Run:

```bash
node dist/cli/main.js --help
node dist/cli/main.js doctor --project examples/taphound-android-demo --json
```

Expected: help starts with `Usage: taphound`; no `apr` command is advertised. Doctor validates Node/ADB/Android CLI/Gradle and may return exit 3 only when no device is online; record the real result without claiming real-device coverage.

**Step 3: Build and inspect the exact tarball**

Run:

```bash
mkdir -p /private/tmp/taphound-pack-smoke
npm pack --pack-destination /private/tmp/taphound-pack-smoke
npm init --yes --prefix /private/tmp/taphound-install-smoke
npm install --prefix /private/tmp/taphound-install-smoke /private/tmp/taphound-pack-smoke/taphound-0.2.0-dev.1.tgz
/private/tmp/taphound-install-smoke/node_modules/.bin/taphound --help
test ! -e /private/tmp/taphound-install-smoke/node_modules/.bin/apr
```

Expected: installation succeeds, `taphound --help` works, and no `apr` executable exists. Do not publish a tarball different from this verified file unless the full pack smoke test is repeated.

**Step 4: Run the final stale-name and secret audit**

Run:

```bash
rg -n --hidden -g '!.git/**' -g '!node_modules/**' -g '!dist/**' -g '!docs/archive/**' -g '!docs/plans/2026-07-20-taphound-rebrand-*.md' '\bAPR\b|\bapr\b|Apr[A-Z]|APR_|android-project-runtime|\.apr|apr\.config|examples/apr-demo|dev\.apr' .
git grep -nE '(npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)' -- ':!docs/archive/**'
git status --short
```

Expected: stale-name scan has no active-tree matches; secret scan has no matches; worktree has no unexpected files. Tarballs must remain outside the repository.

**Step 5: Write the local verification audit**

Create `docs/verification/taphound-v0.2-dev.1-audit.md` with:

- commit SHA and branch reviewed
- exact test/typecheck/lint/build results
- built CLI help result
- doctor result and whether a real device was present
- exact tarball filename, size, integrity/shasum from `npm pack --json`
- installed-tarball smoke result and proof that no `apr` bin exists
- brand SVG/PNG contract result and manual 32 px/circular-crop review result
- stale-name and secret-scan results
- GitHub push status: pending explicit gate
- npm publish status: pending explicit gate

**Step 6: Review, verify, and commit the local audit**

Use `superpowers:requesting-code-review` for the complete branch diff. Fix every Critical/Important finding with a failing regression test and focused commit. Then rerun Step 1 and Step 4.

Commit the audit only after results are current:

```bash
git add docs/verification/taphound-v0.2-dev.1-audit.md
git commit -m "test: audit TapHound dev package readiness"
```

### Task 10: Integrate locally and connect the existing GitHub repository

**Files:**
- No product file changes expected
- Modify after successful push: `docs/verification/taphound-v0.2-dev.1-audit.md`

**Step 1: Finish the implementation branch locally**

Use `superpowers:finishing-a-development-branch`. Re-run the full gate on the final branch, inspect `git diff main...HEAD`, then choose local integration. Fast-forward or merge into local `main` without rewriting history. Do not push yet.

Expected: local `main` contains all reviewed TapHound commits and is clean.

**Step 2: Resolve the exact remote without mutating it**

Run from local `main`:

```bash
git remote -v
git ls-remote git@github.com:caikaidev/TapHound.git
```

Decision:

- If `origin` is absent, run `git remote add origin git@github.com:caikaidev/TapHound.git`.
- If `origin` already has exactly that URL, keep it.
- If `origin` points elsewhere, stop and ask the user; do not rewrite it.
- If `git ls-remote` shows no refs, treat the GitHub repository as empty.
- If it shows refs, fetch them and inspect the histories; do not force-push or overwrite a remote README/license.

When GitHub CLI authentication is available, also run:

```bash
gh repo view caikaidev/TapHound --json nameWithOwner,url,visibility,defaultBranchRef
```

Expected before the public open-source release: repository is owned by `caikaidev`, URL is exact, and visibility remains private unless the user explicitly changes it.

**Step 3: Pause for the GitHub push gate**

Show the user:

- local `main` SHA
- exact origin URL
- whether the remote is empty or has existing commits
- intended refspec (`main:main`)
- repository visibility if known

Ask for explicit confirmation to perform the first push. Approval to publish npm does not imply approval to push GitHub, and vice versa.

**Step 4: Push without force only after approval**

For an empty remote:

```bash
git push -u origin main
```

For a non-empty remote, first reconcile its default branch in a reviewable local merge; never use `--force` or `--force-with-lease` for this first publication.

Verify:

```bash
git ls-remote --heads origin main
git status --short --branch
```

Expected: remote `main` SHA equals local `main`, upstream is configured, and the tree is clean.

**Step 5: Record the push evidence**

Update the audit with remote URL, pushed SHA, default branch, visibility observation, and verification timestamp. Commit and push this audit-only update normally:

```bash
git add docs/verification/taphound-v0.2-dev.1-audit.md
git commit -m "docs: record TapHound GitHub publication"
git push origin main
```

### Task 11: Publish only the npm dev prerelease

**Files:**
- No source changes before publication
- Modify after successful publication: `docs/verification/taphound-v0.2-dev.1-audit.md`

**Step 1: Recheck registry state and authentication**

Run:

```bash
npm whoami
npm view taphound name version dist-tags --json
npm profile get two-factor-auth
```

Expected before first publication: authenticated intended npm owner; `taphound` still returns not-found; account satisfies npm publication 2FA/token requirements. Never print an auth token or store OTP/token values in the repository or audit.

If the package name is now owned by someone else, stop and report the collision. Do not silently choose a new package name. If `taphound@0.2.0-dev.1` already exists under the intended owner, verify it rather than attempting to reuse the immutable version.

**Step 2: Reverify the exact tarball immediately before publish**

Run:

```bash
npm pack --dry-run --json
shasum -a 256 /private/tmp/taphound-pack-smoke/taphound-0.2.0-dev.1.tgz
/private/tmp/taphound-install-smoke/node_modules/.bin/taphound --help
git status --short --branch
```

Expected: metadata and file list match Task 9, tarball digest matches the audit, installed binary works, and local `main` is clean and pushed.

**Step 3: Pause for the irreversible npm gate**

Show the user:

- npm account from `npm whoami`
- package/version: `taphound@0.2.0-dev.1`
- access: public
- dist-tag: `dev`
- tarball digest and file summary
- explicit statement that this does not update `latest`
- explicit warning that published version numbers cannot be reused

Ask for confirmation immediately before running the publish command.

**Step 4: Publish the tested tarball only after approval**

Run:

```bash
npm publish /private/tmp/taphound-pack-smoke/taphound-0.2.0-dev.1.tgz --access public --tag dev
```

Allow npm to request OTP interactively if required. Do not place OTP on a command line recorded in docs or Git history.

**Step 5: Verify registry state and dist-tags**

Run:

```bash
npm view taphound@0.2.0-dev.1 name version license repository dist.tarball dist.integrity --json
npm dist-tag ls taphound
npm view taphound@dev version
npm view taphound@latest version
```

Expected:

- exact package/version resolves
- license is `Apache-2.0`
- repository points to `caikaidev/TapHound`
- `dev` points to `0.2.0-dev.1`
- `latest` is absent; if it unexpectedly exists, stop and report before changing tags

Also install from the registry in a fresh temporary project and run:

```bash
npm init --yes --prefix /private/tmp/taphound-registry-smoke
npm install --prefix /private/tmp/taphound-registry-smoke taphound@dev
/private/tmp/taphound-registry-smoke/node_modules/.bin/taphound --help
test ! -e /private/tmp/taphound-registry-smoke/node_modules/.bin/apr
```

Expected: registry installation succeeds with only the `taphound` binary.

**Step 6: Record publication evidence and finish**

Update `docs/verification/taphound-v0.2-dev.1-audit.md` with the npm package page, published version, `dev` tag, integrity, registry smoke result, and confirmation that `latest` was not set. Do not record credentials or OTP.

```bash
git add docs/verification/taphound-v0.2-dev.1-audit.md
git commit -m "docs: record TapHound npm prerelease"
git push origin main
```

Run the final verification:

```bash
npm test
npm run typecheck
npm run lint
npm run build
git status --short --branch
```

Expected: all gates PASS, local `main` is clean and synchronized, GitHub contains the audited source, and npm exposes only `taphound@dev` for this prerelease.

## Done criteria

- `taphound doctor`, `taphound record`, and `taphound verify` are the only CLI spellings.
- Default config is `taphound.config.json`; default example artifacts use `.taphound/runs`.
- All active source/test/example identifiers use `TapHound*` or `TAPHOUND_*`; no compatibility aliases remain.
- TapHound Journey and Report retain schema version `1` and unchanged machine semantics.
- Android demo uses `examples/taphound-android-demo` and package `dev.taphound.demo`.
- Original APR material is recoverably tracked under `docs/archive/apr-v0.2/` with matching source digest.
- HoundMark SVG variants and 32–1024 px PNG exports pass automated checks and manual small-size/circular-crop review.
- Package metadata identifies `taphound@0.2.0-dev.1`, Apache-2.0, and `caikaidev/TapHound`.
- The exact npm tarball passes local install and CLI smoke tests.
- GitHub first push occurs only after its explicit gate and never uses force.
- npm publication occurs only after its separate explicit gate; `dev` points to `0.2.0-dev.1` and `latest` is absent.
- Final audit records evidence without credentials and all local quality gates pass.
