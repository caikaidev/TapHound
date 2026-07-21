# TapHound Report Schema v1

TapHound Report 默认写入 `.taphound/runs/<runId>/`，或写入配置的 `<artifactsDir>/<runId>/`：

```text
report.json
summary.txt
screenshot.png
logcat.txt
steps/001-logcat.txt
steps/001-layout-diff.json
steps/001-fallback-annotated.png
```

只有实际产生的可选证据才出现在 `artifacts` 中。报告目录先写入临时位置，完成后通过原子 rename 发布。

## 顶层字段

- `schemaVersion`：当前为 `1`。
- `runId`、`startedAt`、`finishedAt`、`durationMs`。
- `status`：`passed`、`failed` 或 `error`。
- `project`：项目根目录、Package 和启动 Activity。
- `journey`：名称及规范化内容的 SHA-256。
- `environment`：设备序列号和 Node、ADB、Android CLI 版本。
- `layers`：`build`、`run`、`structural`、`activityCheckpoint`、`explicitExpect`、`collection`。
- `steps`：逐步 Action、Locator、Idle、Activity、Expect 与日志切片结果。
- `artifacts`：报告、摘要、截图、完整日志及步骤日志路径。
- `fallbackUsed`：任一步是否使用显式标注回退。
- `primaryFailure`：首个主失败。
- `secondaryErrors`：主失败后发生的采集或内部次要错误。

后处理失败不得覆盖 `primaryFailure`。例如 Locator 失败后截图也失败时，Locator 仍是主失败，截图问题进入 `secondaryErrors`。

## 固定失败代码

- `CONFIG_INVALID`
- `ENVIRONMENT_MISSING_TOOL`
- `DEVICE_UNAVAILABLE`
- `BUILD_FAILED`
- `APP_LAUNCH_FAILED`
- `APP_CRASHED`
- `LOCATOR_NOT_FOUND`
- `LOCATOR_AMBIGUOUS`
- `SCROLL_TARGET_NOT_FOUND`
- `ACTION_FAILED`
- `IDLE_TIMEOUT`
- `ACTIVITY_BEFORE_MISMATCH`
- `ACTIVITY_AFTER_MISMATCH`
- `EXPECT_ACTIVITY_FAILED`
- `EXPECT_ELEMENT_FAILED`
- `EXPECT_LOGCAT_FAILED`
- `COLLECTION_FAILED`
- `INTERNAL_ERROR`

## 进程退出码

- `0`：验证通过，或 Recorder 被用户安全取消。
- `1`：被验证项目未满足要求，例如 Build、Replay、Activity 或 Expect 失败。
- `2`：配置、Journey 或 CLI 参数无效。
- `3`：工具、权限、Gradle Wrapper 或设备环境不可用。
- `4`：TapHound 内部错误或不可分类的取消。

`taphound verify --json` 的 JSON `exitCode` 与进程退出码一致。成功或正常验证失败会包含 `report`、`reportPath` 与 `summaryPath`；报告生成前的配置、环境或内部错误使用 `failure.code` 与 `failure.message`。

## 步骤失败证据

每个步骤记录单调时间、持续时间和步骤 Logcat 路径。Locator 报告包含匹配字段和回退证据；Idle 超时时保存最后一个 Layout Diff；Activity 与 Expect 分别记录期望、实际结果和固定失败码。`scrollTo` 步骤记录 `scroll: { swipesUsed, maxSwipes }` 摘要且不填充 `locator`；仅当滚动期间 Idle 超时时才填充 `idle`（并写入对应的 `steps/NNN-layout-diff.json`），其余滚动失败（如 `SCROLL_TARGET_NOT_FOUND`、`LOCATOR_AMBIGUOUS`、容器缺失）不填充 `idle`。
