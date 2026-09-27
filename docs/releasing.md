# Releasing TapHound

Releases are published by `.github/workflows/release.yml` when a `v*` tag is
pushed. The tag must equal `package.json`'s version (`v0.2.0-dev.11` for
`0.2.0-dev.11`).

## One-time setup (maintainer)

1. Enable npm Trusted Publishing: on npmjs.com, open the `taphound`
   package settings and add a Trusted Publisher for GitHub Actions,
   repository `caikaidev/TapHound`, workflow `release.yml`. No npm token is
   stored in the repository; the workflow authenticates through GitHub's
   OIDC token and publishes with provenance.
2. Decide what `latest` points to. A prerelease (`X.Y.Z-name.N`) is
   published under the `name` dist-tag (`dev` for `-dev.N`) and never moves
   `latest`; only a stable `X.Y.Z` release does. Move an existing `latest`
   by hand with `npm dist-tag add taphound@<version> latest`.

## Cutting a release

1. Rename `## Unreleased` in `CHANGELOG.md` to `## <version> — <date>` and
   bump `package.json`/`package-lock.json` with
   `npm version <version> --no-git-tag-version`. `npm test` fails when the
   package version has no CHANGELOG section.
2. Run the local quality gate and the opt-in real-device acceptance
   (`docs/local-testing.md`); GitHub runners have no device.
3. Merge to `main`, then tag and push:

   ```bash
   git tag v<version>
   git push origin v<version>
   ```

The workflow checks the tag against `package.json`, reruns the quality gate,
publishes to npm under the derived dist-tag, and creates the GitHub Release
(marked prerelease for prerelease versions) from that version's CHANGELOG
section. If only the GitHub Release step fails, rerun that job; the npm
publish is not repeated.

`scripts/release-notes.mjs` derives both values:

```bash
node scripts/release-notes.mjs notes <version>     # CHANGELOG section
node scripts/release-notes.mjs dist-tag <version>  # npm dist-tag
```

Stable versions also need `test/package-metadata.test.ts` to accept a
version without a `-dev.N` suffix.
