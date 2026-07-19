# Android Project Runtime (APR) v0.2

APR 是一个 TypeScript/Node.js Android 回归验证 CLI。它通过交互式录制生成确定性的 APR Journey，然后使用 Gradle、Android CLI 与 ADB 重放操作、等待 Layout 稳定并校验 Activity 或显式业务预期。

APR Journey 是本项目完全自研的 JSON 协议、Recorder、Replay 与断言模型，与 Android CLI 官方 Journey 概念不同且不兼容。APR 不调用模型、不做视觉猜测，适合在 Claude Code 或其他 Agent CLI 完成代码开发后进行低成本、可重复的验收。

## 环境要求

- Node.js 22 或更高版本
- Android SDK、ADB 和一个在线设备或模拟器
- 可执行的项目 Gradle Wrapper：`./gradlew`
- 可调用的 `android` CLI
- macOS 上授予 Android CLI 所需的辅助功能、屏幕录制等权限

先执行环境诊断：

```bash
apr doctor --project /path/to/android-project
```

未指定 `--device` 时必须恰好有一个状态为 `device` 的设备；存在多个设备时用 `--device <serial>` 明确选择。

## 安装与本地开发

当前版本可从源码安装：

```bash
npm ci
npm run build
npm link
apr --help
```

开发质量门：

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## 配置

在 Android 项目中创建 `apr.config.json`。`run.packageName` 必填，不会从 APK 文件名或 Activity 猜测；完整示例见 [`examples/apr.config.json`](examples/apr.config.json)。

```json
{
  "version": 1,
  "build": { "task": ":app:assembleDebug" },
  "artifact": { "target": "app", "variant": "debug" },
  "run": {
    "packageName": "com.example.app",
    "activity": ".MainActivity"
  },
  "idle": {
    "pollIntervalMs": 200,
    "stablePolls": 2,
    "timeoutMs": 5000
  },
  "artifactsDir": ".apr/runs"
}
```

## 交互式录制

APR Recorder 展示当前 Layout，让用户选择 Action 和目标，然后由 APR 自己通过 ADB 执行操作。它不监听任意触摸。每个成功步骤自动记录 `activity.before` 与 `activity.after`；失败步骤不会加入 Journey；只有选择 Finish 后才原子写入完整文件。

```bash
apr record \
  --project /path/to/android-project \
  --config apr.config.json \
  --name "Search flow" \
  --output journeys/search.json
```

Recorder 不自动生成业务 `expect`。Activity、Element 或 Logcat 断言应由开发者或外部 Agent 显式补充。协议细节见 [Journey Schema](docs/journey-schema.md)。

## 确定性验证

```bash
apr verify \
  --project /path/to/android-project \
  --config apr.config.json \
  --journey journeys/search.json
```

临时覆盖 Package、Activity、设备或报告路径：

```bash
apr verify \
  --project /path/to/android-project \
  --journey journeys/search.json \
  --device emulator-5554 \
  --package com.example.app \
  --activity .MainActivity \
  --reports /tmp/apr-runs
```

Agent 调用时使用：

```bash
apr verify --project . --journey journeys/search.json --json
```

`--json` 模式保证 stdout 只有一个最终 JSON 值，进度和诊断写入 stderr。详见 [Agent 集成](docs/agent-integration.md) 与 [报告协议](docs/report-schema.md)。

## 报告

每次验证写入独立目录，包含 `report.json`、`summary.txt`、最终截图、完整 Logcat 与步骤日志。原始验证失败保存在 `primaryFailure`；后续截图或日志采集问题进入 `secondaryErrors`，不会覆盖原始失败。

## v0.2 限制

- 只支持 Android 与单个明确选择的设备。
- Recorder 是 APR 介导的交互流程，不观察用户在设备上的任意触摸。
- Action 仅包括 click、longClick、inputText、swipe、back 和 wait。
- 标注截图回退只适用于 click 与 longClick，且必须显式保存 `#编号`。
- Replay 和断言完全确定性，不包含 AI 或视觉推理。
- Claude Code Skill 或 SubAgent 封装不在 v0.2；当前稳定集成面是 `apr verify --json`。
- 普通测试不要求真实设备；真机验收需要显式设置 `APR_ACCEPTANCE_DEVICE=1` 并满足外部 Android/Gradle 前提。
