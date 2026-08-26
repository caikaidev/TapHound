import type { ForegroundComponent } from "../../domain/activity.js";
import type { LayoutElement } from "../../domain/layout.js";
import type { AdbPort, AppIdentity } from "../../ports/adb.js";
import type { AndroidCliPort, Point } from "../../ports/android-cli.js";
import type {
  CameraProbeInput,
  CameraProbePort,
  CameraProbeResult
} from "../../ports/camera-probe.js";
import { CameraProbeError } from "../../ports/camera-probe.js";

const SHUTTER_KEYWORDS = ["shutter", "快门", "capture", "拍照"];
const CONFIRM_KEYWORDS = [
  "done",
  "confirm",
  "accept",
  "ok",
  "save",
  "checkmark",
  "完成",
  "确认",
  "接受",
  "确定",
  "保存"
];
const CONFIRM_RESOURCE_ID_SUBSTRINGS = ["done", "confirm", "accept", "save", "ok"];
const SHUTTER_RESOURCE_ID_SUBSTRINGS = ["shutter"];
const IMAGE_CAPTURE_ACTION = "android.media.action.IMAGE_CAPTURE";
const CAMERA_FOREGROUND_TIMEOUT_MS = 8000;
const CAMERA_FOREGROUND_POLL_INTERVAL_MS = 500;
const LAYOUT_SETTLE_MS = 1500;
const RESOLVER_KEYWORDS = ["resolver", "chooser"];
const AOSP_CAMERA_PACKAGES = ["com.android.camera", "com.android.camera2"];

export interface CameraProbeAdapterDeps {
  adb: AdbPort;
  androidCli: AndroidCliPort;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

interface ButtonMatch {
  resourceId: string;
  contentDescription?: string | undefined;
}

type FindButtonResult = ButtonMatch | "none" | "ambiguous" | "no_resource_id";

function flatten(elements: readonly LayoutElement[]): LayoutElement[] {
  const result: LayoutElement[] = [];
  const visit = (nodes: readonly LayoutElement[]): void => {
    for (const node of nodes) {
      result.push(node);
      visit(node.children);
    }
  };
  visit(elements);
  return result;
}

function matchesAnyKeyword(value: string, keywords: readonly string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function resourceEntryName(resourceId: string): string {
  const separator = resourceId.lastIndexOf(":id/");
  return (
    separator >= 0 ? resourceId.slice(separator + 4) : resourceId
  ).toLowerCase();
}

function matchesResourceId(
  resourceId: string,
  token: string
): boolean {
  const entryName = resourceEntryName(resourceId);
  const tokens = entryName.split(/[^a-z0-9]+/u);
  return tokens.includes(token.toLowerCase());
}

function selectByResourceIdPriority(
  candidates: readonly LayoutElement[],
  resourceIdTokens: readonly string[]
): LayoutElement[] {
  for (const token of resourceIdTokens) {
    const matches = candidates.filter(
      (node) => (
        node.resourceId !== undefined
        && matchesResourceId(node.resourceId, token)
      )
    );
    if (matches.length > 0) {
      return matches;
    }
  }
  return [];
}

function buttonMatch(node: LayoutElement): FindButtonResult {
  if (node.resourceId === undefined) {
    return "no_resource_id";
  }
  return {
    resourceId: node.resourceId,
    ...(node.contentDescription === undefined
      ? {}
      : { contentDescription: node.contentDescription })
  };
}

function findButton(
  layout: readonly LayoutElement[],
  keywords: readonly string[],
  resourceIdSubstrings: readonly string[]
): FindButtonResult {
  const eligible = flatten(layout).filter(
    (node) => node.enabled && node.clickable === true
  );
  const candidates = eligible.filter(
    (node) => (
      node.contentDescription !== undefined
      && matchesAnyKeyword(node.contentDescription, keywords)
    )
  );
  if (candidates.length === 0) {
    const byResourceId = selectByResourceIdPriority(
      eligible,
      resourceIdSubstrings
    );
    if (byResourceId.length === 0) {
      return "none";
    }
    if (byResourceId.length === 1) {
      const node = byResourceId[0];
      return node === undefined ? "none" : buttonMatch(node);
    }
    return "ambiguous";
  }
  if (candidates.length === 1) {
    const node = candidates[0];
    return node === undefined ? "none" : buttonMatch(node);
  }
  const byResourceId = selectByResourceIdPriority(
    candidates,
    resourceIdSubstrings
  );
  if (byResourceId.length === 1) {
    const node = byResourceId[0];
    return node === undefined ? "none" : buttonMatch(node);
  }
  return "ambiguous";
}

function centerOf(element: LayoutElement): Point {
  if (element.center !== undefined) {
    return element.center;
  }
  if (element.bounds !== undefined) {
    return {
      x: Math.round((element.bounds.left + element.bounds.right) / 2),
      y: Math.round((element.bounds.top + element.bounds.bottom) / 2)
    };
  }
  throw new CameraProbeError(
    "ALIGN_SHUTTER_NOT_FOUND",
    "Shutter element has no center or bounds"
  );
}

function isResolverOrChooser(packageName: string): boolean {
  const lower = packageName.toLowerCase();
  return RESOLVER_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function isAospCameraPackage(packageName: string): boolean {
  return AOSP_CAMERA_PACKAGES.includes(packageName);
}

function deviceIdentity(deviceSerial: string, signal?: AbortSignal): AppIdentity {
  return {
    packageName: "",
    deviceSerial,
    ...(signal === undefined ? {} : { signal })
  };
}

export class CameraProbeAdapter implements CameraProbePort {
  public constructor(private readonly deps: CameraProbeAdapterDeps) {}

  public async probe(input: CameraProbeInput): Promise<CameraProbeResult> {
    const { deviceSerial, signal } = input;
    let cameraPackage: string | undefined;

    try {
      let preForeground = await this.deps.adb.foregroundComponent(
        deviceIdentity(deviceSerial, signal)
      );
      if (isAospCameraPackage(preForeground.packageName)
        || isResolverOrChooser(preForeground.packageName)) {
        await this.deps.adb.forceStop({
          packageName: preForeground.packageName,
          deviceSerial,
          ...(signal === undefined ? {} : { signal })
        });
        preForeground = await this.deps.adb.foregroundComponent(
          deviceIdentity(deviceSerial, signal)
        );
      }

      const startResult = await this.deps.adb.startActivityByIntent({
        action: IMAGE_CAPTURE_ACTION,
        deviceSerial,
        ...(signal === undefined ? {} : { signal })
      });

      if (startResult.exitCode !== 0) {
        throw new CameraProbeError(
          "ALIGN_CAMERA_INTENT_FAILED",
          `am start exited with code ${String(startResult.exitCode)}: ${startResult.stderr || startResult.stdout}`
        );
      }

      const deadline = this.deps.now() + CAMERA_FOREGROUND_TIMEOUT_MS;
      let current: ForegroundComponent = preForeground;
      while (this.deps.now() < deadline) {
        current = await this.deps.adb.foregroundComponent(
          deviceIdentity(deviceSerial, signal)
        );
        if (isResolverOrChooser(current.packageName)) {
          throw new CameraProbeError(
            "ALIGN_CAMERA_INTENT_FAILED",
            `IMAGE_CAPTURE landed on system resolver/chooser (${current.packageName}); set a default camera app`
          );
        }
        if (current.packageName !== preForeground.packageName) {
          cameraPackage = current.packageName;
          break;
        }
        await this.deps.sleep(CAMERA_FOREGROUND_POLL_INTERVAL_MS);
      }
      if (cameraPackage === undefined) {
        throw new CameraProbeError(
          "ALIGN_CAMERA_NOT_LAUNCHED",
          "Camera package did not become foreground within 8s"
        );
      }

      await this.deps.androidCli.layout({
        deviceSerial,
        packageName: cameraPackage,
        ...(signal === undefined ? {} : { signal })
      });
      await this.deps.sleep(LAYOUT_SETTLE_MS);
      const initialLayout = await this.deps.androidCli.layout({
        deviceSerial,
        packageName: cameraPackage,
        ...(signal === undefined ? {} : { signal })
      });
      const preShutterForeground = await this.waitForStableForeground(
        deviceSerial,
        signal
      );
      if (preShutterForeground.packageName !== cameraPackage) {
        throw new CameraProbeError(
          "ALIGN_CAMERA_NOT_LAUNCHED",
          `Camera package left the foreground before shutter discovery: ${preShutterForeground.packageName}`
        );
      }

      const shutter = findButton(initialLayout, SHUTTER_KEYWORDS, SHUTTER_RESOURCE_ID_SUBSTRINGS);
      if (shutter === "none") {
        throw new CameraProbeError(
          "ALIGN_SHUTTER_NOT_FOUND",
          "No enabled clickable element matched shutter contentDescription or resourceId"
        );
      }
      if (shutter === "ambiguous") {
        throw new CameraProbeError(
          "ALIGN_SHUTTER_AMBIGUOUS",
          "Multiple shutter candidates could not be disambiguated by resourceId"
        );
      }
      if (shutter === "no_resource_id") {
        throw new CameraProbeError(
          "ALIGN_SHUTTER_NO_RESOURCE_ID",
          "Shutter candidate has no resourceId for deterministic replay"
        );
      }
      const shutterElement = flatten(initialLayout).find(
        (node) => node.resourceId === shutter.resourceId
      );
      if (shutterElement === undefined) {
        throw new CameraProbeError(
          "ALIGN_SHUTTER_NOT_FOUND",
          `Shutter resourceId ${shutter.resourceId} not present in layout`
        );
      }

      await this.deps.adb.tap(
        centerOf(shutterElement),
        deviceSerial,
        signal
      );

      await this.deps.androidCli.layout({
        deviceSerial,
        packageName: cameraPackage,
        ...(signal === undefined ? {} : { signal })
      });
      await this.deps.sleep(LAYOUT_SETTLE_MS);
      const postShutterLayout = await this.deps.androidCli.layout({
        deviceSerial,
        packageName: cameraPackage,
        ...(signal === undefined ? {} : { signal })
      });
      const postShutterForeground = await this.waitForStableForeground(
        deviceSerial,
        signal
      );

      const activityName = preShutterForeground.activity;

      if (postShutterForeground.packageName !== cameraPackage) {
        return {
          packageName: cameraPackage,
          activityName,
          shutterResourceId: shutter.resourceId,
          ...(shutter.contentDescription !== undefined
            ? { shutterContentDescription: shutter.contentDescription }
            : {})
        };
      }
      const confirm = findButton(
        postShutterLayout,
        CONFIRM_KEYWORDS,
        CONFIRM_RESOURCE_ID_SUBSTRINGS
      );
      if (confirm === "ambiguous") {
        throw new CameraProbeError(
          "ALIGN_CONFIRM_AMBIGUOUS",
          "Multiple confirm candidates could not be disambiguated by resourceId"
        );
      }
      if (confirm === "none") {
        throw new CameraProbeError(
          "ALIGN_CONFIRM_NOT_FOUND",
          "Camera remained foreground after capture, but no deterministic confirm button was found"
        );
      }
      if (confirm === "no_resource_id") {
        throw new CameraProbeError(
          "ALIGN_CONFIRM_NO_RESOURCE_ID",
          "Confirm candidate has no resourceId for deterministic replay"
        );
      }
      return {
        packageName: cameraPackage,
        activityName,
        shutterResourceId: shutter.resourceId,
        ...(shutter.contentDescription !== undefined
          ? { shutterContentDescription: shutter.contentDescription }
          : {}),
        confirmResourceId: confirm.resourceId,
        ...(confirm.contentDescription !== undefined
          ? { confirmContentDescription: confirm.contentDescription }
          : {}),
        confirmActivityName: postShutterForeground.activity
      };
    } finally {
      if (cameraPackage !== undefined) {
        try {
          await this.deps.adb.forceStop({
            packageName: cameraPackage,
            deviceSerial,
            ...(signal === undefined ? {} : { signal })
          });
        } catch {
          void null;
        }
      }
    }
  }

  private async waitForStableForeground(
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<ForegroundComponent> {
    const deadline = this.deps.now() + CAMERA_FOREGROUND_TIMEOUT_MS;
    let previous: ForegroundComponent | undefined;
    while (this.deps.now() < deadline) {
      const current = await this.deps.adb.foregroundComponent(
        deviceIdentity(deviceSerial, signal)
      );
      if (
        previous !== undefined
        && previous.packageName === current.packageName
        && previous.activity === current.activity
      ) {
        return current;
      }
      previous = current;
      await this.deps.sleep(
        Math.min(
          CAMERA_FOREGROUND_POLL_INTERVAL_MS,
          Math.max(0, deadline - this.deps.now())
        )
      );
    }
    throw new CameraProbeError(
      "ALIGN_CAMERA_NOT_LAUNCHED",
      "Foreground Activity did not stabilize within 8s"
    );
  }
}
