# UI Snapshot Provider physical-device acceptance

Date: 2026-09-03

Device: Seeker (`SM02G4061928151`), Android API 36, 1200x2670 portrait.
The demo APK was rebuilt with Gradle 9.1.0 / AGP 9.0.1, uninstalled, and
installed cleanly before acceptance.

## Functional coverage

The System UIAutomator provider captured and attributed the physical viewport
for all three demo surfaces. Coordinates were taken from each live snapshot and
injected through ADB:

| Surface | Required live nodes | Result |
|---|---|---|
| XML View | `open_search`, `open_compose`, `open_hybrid` | passed |
| Compose | `compose_action`, `compose_status`, `compose_list` and LazyColumn rows | passed; live tap changed status to `Compose clicked` |
| Hybrid | `hybrid_view_action`, `hybrid_compose_action`, `hybrid_status` | passed; both View and Compose live coordinates triggered the expected state |

The device uses the Android 16 `Viewport ... orientation=N` dumpsys format and
does not expose the legacy `SurfaceOrientation` line. Acceptance found and
validated the compatibility parser for this format.

## Bound-provider benchmark

The Hybrid page was held stable. Each backend was opened once, probed once,
then captured 20 consecutive times with `forceFresh`. No capture failed.

| Backend | P50 | P95 | min / max | Nodes per capture | Failures |
|---|---:|---:|---:|---:|---:|
| System UIAutomator | 2264.4 ms | 2286.2 ms | 2217.3 / 2289.2 ms | 13 | 0/20 |
| Android CLI layout | 4109.7 ms | 4486.6 ms | 3969.4 / 4630.8 ms | 5 | 0/20 |

System UIAutomator is therefore retained as the first `auto` candidate on this
device. Appium remains explicit and was not benchmarked because no locked local
Appium server/UiAutomator2 driver was running; its session and parser contracts
are covered by adapter tests, but this document does not claim device Appium
acceptance.
