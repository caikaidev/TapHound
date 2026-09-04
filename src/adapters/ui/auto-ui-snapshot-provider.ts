import type {
  OpenUiSnapshotProviderOptions,
  UiSnapshotProvider,
  UiSnapshotProviderFactory
} from "../../ports/ui-snapshot.js";
import { UiSnapshotError } from "./ui-snapshot-error.js";

export class AutoUiSnapshotProviderFactory implements UiSnapshotProviderFactory {
  public constructor(
    private readonly system: UiSnapshotProviderFactory,
    private readonly androidCli: UiSnapshotProviderFactory,
    private readonly appium?: UiSnapshotProviderFactory | undefined
  ) {}

  public async open(
    options: OpenUiSnapshotProviderOptions
  ): Promise<UiSnapshotProvider> {
    if (options.backend === "system-uiautomator") {
      return this.system.open(options);
    }
    if (options.backend === "android-cli") {
      return this.androidCli.open(options);
    }
    if (options.backend === "appium-uiautomator2") {
      if (this.appium !== undefined) return this.appium.open(options);
      throw new UiSnapshotError(
        "UI_BACKEND_UNAVAILABLE",
        "appium-uiautomator2",
        "Appium UiAutomator2 provider is not installed"
      );
    }
    try {
      return await this.system.open(options);
    } catch (error) {
      if (
        !(error instanceof UiSnapshotError)
        || (
          error.code !== "UI_BACKEND_UNAVAILABLE"
          && error.code !== "UI_SNAPSHOT_INVALID"
        )
      ) {
        throw error;
      }
    }
    return this.androidCli.open(options);
  }
}
