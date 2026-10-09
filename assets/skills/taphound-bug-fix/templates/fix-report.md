# Fix report: <caseId>

- Outcome: <FIXED | NOT_REPRODUCED | FAILED | PAUSED>
- Bug record: .taphound/build/workflows/<caseId>/bug-record.md

## Reproduction (red)

- Scenario: <one line>; Brief: .taphound/briefs/<caseId>/taphound-journey-brief.md
- Evidence: <generation session id and failing step output path, or failing
  unit test output>
- Failure: <APP_CRASHED + crash match "matched" | EXPECT_* message | unit test failure>
- Attempts: <n>, variations tried: <list>

## Root cause

<Why it happened, pointing at file:line.>

## Change

- Files: <paths>
- Build / install: <command>, APK <path>

## Verification (green)

- Regression Journey: .taphound/journeys/bugs/<caseId>.json
- Contract: .taphound/contracts/bugs/<caseId>.json, Verdict <pass>, report <path>
- verify-change manifest: .taphound/build/workflows/<caseId>/manifest.json
- Affected Journeys (`verify --diff`): <overall result, any regressions>

## Not reproduced / paused (when applicable)

<What was tried, what happened, and what information or tool is needed.>
