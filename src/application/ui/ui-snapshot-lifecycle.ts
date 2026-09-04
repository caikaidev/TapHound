import type { UiSnapshotProvider } from "../../ports/ui-snapshot.js";

export async function closeUiSnapshotProvider(
  provider: UiSnapshotProvider,
  onFailure?: (error: unknown) => void
): Promise<void> {
  try {
    await provider.close();
  } catch (error) {
    onFailure?.(error);
  }
}
