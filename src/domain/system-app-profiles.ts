const SYSTEM_SCENARIOS = ["photoCapture", "pickImage", "pickFile"] as const;
type SystemScenario = (typeof SYSTEM_SCENARIOS)[number];

export const SYSTEM_APP_PACKAGES: Record<SystemScenario, readonly string[]> = {
  photoCapture: [
    "com.android.camera",
    "com.android.camera2",
    "com.google.android.GoogleCamera",
    "com.sec.android.app.camera",
    "com.huawei.camera",
    "com.miui.camera",
    "com.oppo.camera",
    "com.vivo.camera",
    "com.oneplus.camera"
  ],
  pickImage: [
    "com.android.gallery",
    "com.android.gallery3d",
    "com.google.android.apps.photos",
    "com.google.android.apps.photos.go",
    "com.sec.android.gallery3d",
    "com.miui.gallery",
    "com.oppo.gallery",
    "com.vivo.gallery",
    "com.android.documentsui",
    "com.google.android.documentsui",
    "com.google.android.providers.media.module",
    "com.android.providers.media.module"
  ],
  pickFile: [
    "com.android.documentsui",
    "com.google.android.documentsui",
    "com.android.fileexplorer",
    "com.mi.android.globalFileexplorer",
    "com.sec.android.app.myfiles",
    "com.coloros.filemanager",
    "com.vivo.filemanager"
  ]
};

export function isKnownSystemPackage(
  scenario: SystemScenario,
  packageName: string
): boolean {
  return SYSTEM_APP_PACKAGES[scenario].includes(packageName);
}

export function isSystemScenario(
  scenario: string
): scenario is SystemScenario {
  return (SYSTEM_SCENARIOS as readonly string[]).includes(scenario);
}
