import { spawnSync } from "node:child_process";
import process from "node:process";

export function requireInstalledApp(packageName) {
  const device = process.env.TAPHOUND_DEVICE;
  const result = spawnSync("adb", [
    ...(device === undefined ? [] : ["-s", device]),
    "shell",
    "pm",
    "path",
    packageName
  ], { encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (!/^package:/m.test(result.stdout)) {
    throw new Error(
      `${packageName} is not installed on the acceptance device.\n`
        + "TapHound does not build or install. Do it first:\n"
        + "  cd examples/taphound-android-demo\n"
        + "  ./gradlew :app:assembleDebug\n"
        + "  adb install -r app/build/outputs/apk/debug/app-debug.apk\n"
    );
  }
}
