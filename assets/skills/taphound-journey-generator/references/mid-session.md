# Correcting and Adjusting a Generation Session

**Rewind a wrong committed step** with `step --replace` instead of restarting
the session or building workarounds on top of a mistake:

```bash
taphound generation step \
  --project <project> --session <generationId> \
  --replace <index> \
  --compact --json
```

Core replays the stored candidate prefix `[0, index)` through the same
cold-launch replay engine as finalize (honoring the session's current idle
policy), truncates the candidate to that prefix, and binds a fresh
post-replay snapshot. The response matches `observe` plus `status:
"replaced"`, `stepIndex`, `remainingStepCount`, and `truncatedStepCount`;
the next proposal must bind the returned revision and snapshot; save the
output and pass it to `envelope.mjs bind --from` directly, with no extra
`observe`. The index
must be an integer in `[0, candidateStepCount]` (`0` cold-resets without
replay); an index inside the bound Base Flow prefix fails with
`FLOW_INVALID`; `--input` and `--replace` are mutually exclusive. Replace is
rejected with `CONFIG_INVALID` unless the session is `active` with no
in-flight step, no pending confirmation, and verification and publication
both `notRun`. A prefix replay failure returns `VERIFICATION_FAILED` and
leaves the session untouched; superseded step evidence stays in the bundle
as an audit trail.

**Hot-adjust the idle policy** when `IDLE_TIMEOUT` recurs or the screen
needs a different stability strategy:

```bash
taphound generation config idle \
  --project <project> --session <generationId> \
  --strategy layoutDiff --timeout-ms 20000 \
  --json
```

At least one of `--strategy`, `--poll-interval-ms`, `--stable-polls`,
`--timeout-ms` is required; the patch merges onto the session's current
policy and advances the session revision, so the next proposal must bind
the new revision. Rejected with `CONFIG_INVALID` unless the session is
`active` with no in-flight step, no pending confirmation, and verification
and publication both `notRun`. Subsequent observe, step, and finalize replay
honor the stored policy; `generation status` reports it as `idlePolicy`.
