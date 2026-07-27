# TapHound Post-Machine-Switch TODO

This checklist is for cross-machine validation and the subsequent pre-release after the current development phase ends. Once GitHub push evidence is complete, use remote `main` and [`docs/verification/taphound-v0.2-dev.1-audit.md`](docs/verification/taphound-v0.2-dev.1-audit.md) as the baseline.

## Current Handoff Baseline

- [x] TapHound rename, HoundMark, release metadata, and local tarball smoke have been committed.
- [x] The first source code push has been pushed normally to `origin/main`, with SHA `473f27cf6993ce0cd2ed80d3180715e734dba4c7`, no force-push.
- [x] The remote default branch is `main`; the repository page is currently publicly visible, and visibility was not changed this time.
- [x] The exact local tarball SHA-256 is `0545c4f2324080b2c3cee99d27351887c868fe9f8bdf4ff37cc0275413d8e47f`.
- [ ] The npm package has not been published yet; the independent publish gate remains closed.

## Recovery After Machine Switch

- [ ] Clone or pull `main` from `git@github.com:caikaidev/TapHound.git`.
- [ ] Record `git rev-parse HEAD` and confirm it is no earlier than this GitHub release evidence commit.
- [ ] Use Node.js 22 or newer to run `npm ci`.
- [ ] Run the full source quality gate per [`docs/local-testing.md`](docs/local-testing.md).

## Cross-Machine Validation

- [ ] Regenerate `taphound-0.2.0-dev.1.tgz` and verify the size, SHA-256, npm shasum, integrity, and file listing.
- [ ] Install from the exact tarball and verify `taphound --help`, confirming there is no legacy binary entry.
- [ ] Run doctor and the Demo Journey on an Emulator or USB Device.
- [ ] Inspect the reports, screenshots, and logs in `.taphound/runs/`; record the device, tool versions, and failure reproduction steps.
- [ ] If issues are found, create a separate fix branch from remote `main`; do not rewrite already-pushed history.

## npm `dev` Pre-release

- [ ] Complete cross-machine validation and resolve all blocking issues.
- [ ] Check the npm login identity, 2FA requirements, and `taphound` package name status; do not record tokens or OTPs.
- [ ] Re-run the full quality gate and the exact-tarball install smoke.
- [ ] Show the user the account, version, public access, `dev` tag, tarball digest, and file listing, and obtain an independent explicit confirmation.
- [ ] Publish only `taphound@0.2.0-dev.1` to `dev`; do not create or move `latest`, and do not publish a different tarball.
- [ ] Freshly install `taphound@dev` from the registry and run the CLI smoke.
- [ ] Write the registry evidence back into the release audit, commit, and push normally; never force-push.

Do not run any `npm publish` command before the independent npm confirmation gate.
