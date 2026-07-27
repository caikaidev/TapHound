# TapHound Brand Migration and Prerelease Registration Design

**Date:** 2026-07-20
**Status:** Approved
**Brand:** TapHound
**First-release positioning:** TapHound for Android

## 1. Background and Goals

The project currently uses Android Project Runtime (APR) as its development-period name. The first version only supports native Android, but the product will eventually expand to iOS, Web, or other clients, so the master brand cannot be tied to Android.

TapHound is the cross-platform master brand; Android is only the first Adapter and the release subtitle. The brand personality leans toward lighthearted and developer-friendly while retaining the credibility expected of a deterministic verification tool.

Goals of this migration:

- Unify the current code tree, CLI, protocol names, reports, config, examples, tests, and active documentation under TapHound.
- Establish a core TapHound brand Icon suitable for GitHub, README, and release showcases.
- Reserve the GitHub repository and npm package name before the official open-source release.
- Do not change the v0.2 functionality or deterministic semantics.
- Do not retain a compatibility layer for the APR name, which has not yet been publicly released.

## 2. Brand System

- Master brand: `TapHound`
- First-release name: `TapHound for Android`
- npm package: `taphound`
- CLI: `taphound`
- GitHub repository: `caikaidev/TapHound`
- Product description: `Deterministic app journey recording and verification`
- Tagline: `Follow every tap. Catch every regression.`
- GitHub Topics: `android`, `testing`, `cli`, `record-replay`, `regression-testing`, `ai-agents`
- Brand Icon: `HoundMark`, an abstract hound side profile tracking a tap target, electric orange + deep charcoal

Future platform expansions use the same Journey and report brand and are differentiated by platform Adapters, e.g. TapHound for Android, TapHound for iOS. No multi-package repository or platform-abstraction placeholder code is created in this phase.

The Icon's composition, colors, deliverable files, and acceptance criteria are defined in [TapHound Brand Icon Design](2026-07-20-taphound-brand-icon-design.md). This phase only delivers the core Icon suite; it does not extend to a wordmark, banner, or a complete visual system.

## 3. Migration Strategy

A one-time, atomic, no-compatibility-layer migration is used. After migration:

| Old name | New name |
|---|---|
| Android Project Runtime / APR | TapHound |
| `android-project-runtime` | `taphound` |
| `apr` CLI | `taphound` |
| `apr.config.json` | `taphound.config.json` |
| `.apr/runs` | `.taphound/runs` |
| `APR_*` | `TAPHOUND_*` |
| APR Journey | TapHound Journey |
| APR Report | TapHound Report |
| `AprConfig*` | `TapHoundConfig*` |
| `AprReport*` | `TapHoundReport*` |
| `examples/apr-demo` | `examples/taphound-android-demo` |
| `dev.apr.demo` | `dev.taphound.demo` |

Migration covers:

- `package.json`, lockfile, bin, program name, and help text.
- Default config, artifact directory, temp directory prefix, and environment variables.
- Domain export types, test descriptions, fixtures, and fake tool filenames.
- Recorder, Verifier, Doctor, report summaries, stderr diagnostics, and error messages.
- Example project directory, Android namespace/applicationId, Manifest label, Journey, and acceptance scripts.
- README, Agent integration, Journey/Report Schema, design, implementation, and audit documents.

Git history is not rewritten. Historical commits may retain APR; in the current releasable tree, "APR was an internal codename" may only appear in an explicit migration note or archive context. The parent directory name of the local checkout is not a release artifact and is not changed in this migration, to avoid breaking the running workspace.

The existing untracked root file `APR-Design-v0.2.md` is user-owned source material. During implementation, first migrate the content into a trackable TapHound design/archive path and verify it, then remove the old path; never delete without a recoverable copy.

## 4. Config and Protocol Boundaries

This is a pre-release breaking rename and does not accept any of the following old entry points:

- `apr` command.
- `apr.config.json` default filename.
- `.apr` default directory.
- `APR_*` environment variables.

The Journey and Report JSON schema versions remain `1`, and the field structure is unchanged. The brand name is not written into the existing machine protocol's decision fields, so the schema version is not meaninglessly bumped for a rename. Human-visible names, document titles, and TypeScript export types are changed to TapHound.

## 5. GitHub Registration

The user has created the GitHub repository:

```text
git@github.com:caikaidev/TapHound.git
```

Implementation phases:

1. Confirm the repository has no incorrect existing `origin`.
2. Add and verify `origin`.
3. Confirm the remote default branch and content state before pushing, to avoid overwriting the remote's initialization commit.
4. Only perform the first push after the local rename, tests, and release audit all pass.
5. Keep the repository private initially; perform secrets/history, license, community files, and GitHub Actions audits before the official open-source release.

The first push is an external state change; the target owner/repository/branch must be explicitly confirmed when executed. Do not force-push.

## 6. npm Prerelease Registration

npm has no separate "reserve package name" operation. Use a real, runnable prerelease version to claim the name:

- package: `taphound`
- version: `0.2.0-dev.1`
- dist-tag: `dev`
- access: `public`
- stable `latest`: not created

The final form of the publish command:

```text
npm publish --tag dev --access public
```

Before publishing, you must:

- Verify `npm whoami` and registry.
- Reconfirm that `taphound` is not already taken.
- Run `npm pack --dry-run` and audit the tarball contents.
- Install from the tarball and run `taphound --help`, `doctor --json`, and the machine-output contract tests.
- Confirm no secrets, local paths, test fixtures, source maps, or unrelated files are leaked.
- Handle npm 2FA/OTP; never write tokens or OTP into the repository, logs, or command-history documents.
- After publishing, verify `taphound@dev` is installable and that no `latest` tag exists.

Although this is not a stable release, it is still a public npm publication. Subsequent stable open-source releases use a new semver and publish to `latest`; published version numbers are not reused.

## 7. License and Release Metadata

The license is Apache License 2.0. Add a root `LICENSE` and set the following in `package.json`:

- `license: "Apache-2.0"`
- `repository` pointing to `caikaidev/TapHound`
- `homepage` pointing to the GitHub README
- `bugs` pointing to GitHub Issues
- reasonable `keywords`
- explicit `files` and publish lifecycle scripts

Before the GitHub repository is officially made public, also add `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, Issue/PR templates, and stable-release automation; these do not block the dev package-name reservation.

## 8. Error Handling and Rollback

- The migration is completed in an isolated branch/worktree to avoid polluting the verified `main`.
- Express the new-name contract with tests first, then modify the implementation.
- On any phase failure, do not retain "half APR, half TapHound" commits; each commit covers only one verifiable migration layer.
- If the GitHub remote already has content, stop and audit; do not automatically merge or overwrite.
- If npm dry-run or tarball smoke test fails, publishing is prohibited.
- After a successful npm publish, the version number cannot be rolled back; fixes must use a new prerelease version, e.g. `0.2.0-dev.2`.

## 9. Verification Strategy

Automated verification includes:

- Black-box tests for the new CLI name, help output, stdout/stderr, and exit codes.
- Tests for the default `taphound.config.json`, `.taphound/runs`, and `TAPHOUND_*`.
- Tests for Domain types, report summaries, Recorder prompts, and Doctor error wording.
- Contract tests for the example Android Package, Activity, directory, and acceptance runner.
- Documentation example tests that only accept `taphound`.
- A full-repo stale-name audit; only migration-note/archive whitelist entries may contain APR.
- `npm ci`, unit/integration tests, typecheck, lint, build.
- `npm pack --dry-run`, tarball file list, and installation smoke test.
- Brand Icon SVG structure, PNG dimensions, approved color values, circular crop, and 16–32 px legibility checks.
- Git remote, branch, and first-push target audit.

## 10. Completion Criteria

- Users can run `taphound doctor|record|verify`; no `apr` compatibility entry point exists.
- All default files and environment variables use the TapHound name.
- The active source, tests, examples, and documentation of the current release tree have no non-whitelisted APR residue.
- All existing functional tests continue to pass, and machine-protocol behavior is unchanged.
- Apache-2.0 and npm/GitHub metadata are complete.
- The HoundMark core SVG, light/dark/monochrome variants, and 32–1024 px PNGs are delivered and have passed review.
- `origin` correctly points to `git@github.com:caikaidev/TapHound.git`.
- The npm tarball can be independently installed and run.
- `taphound@0.2.0-dev.1` is published only under the `dev` tag; there is no `latest`.
- The GitHub repository has been safely pushed and retains the user-specified visibility.
