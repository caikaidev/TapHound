<p align="center">
  <img src="assets/brand/taphound-mark.svg" width="128" alt="TapHound HoundMark">
</p>

# TapHound

[English](./README.md) | 简体中文

> Follow every tap. Catch every regression.

TapHound 是一个用于 App Journey 录制、生成与确定性验证的 TypeScript/Node.js CLI。当前开发版本 TapHound for Android 支持录制原生 Android 工作流，也支持外部 Agent 基于 Project Context 和实时设备状态生成 Journey。

TapHound Journey 是本项目完全自研的 JSON 协议、Recorder、Generation、Replay 与断言模型，与 Android CLI 官方 Journey 概念不同且不兼容。TapHound Core 不调用模型：外部 Agent 可以分析源码并提出操作，但状态绑定、风险确认、设备执行、最终 Replay 与断言均由 TapHound 确定性完成。

TapHound 只负责验证。编译和安装 APK 是独立的前置步骤，由开发者或 AI Agent 在验证循环中完成：

```
修改代码 → 编译 APK → 安装到设备 → taphound verify → 循环直到符合预期
```

## 环境要求

- Node.js 22 或更高版本
- Android SDK、ADB 和一个在线设备或模拟器
- 目标 APK 已安装到设备（TapHound 不负责编译或安装）
- 可调用的 `android` CLI
- macOS 上授予 Android CLI 所需的辅助功能、屏幕录制等权限

先执行环境诊断：

```bash
taphound doctor --project /path/to/android-project
```

未指定 `--device` 时必须恰好有一个状态为 `device` 的设备；存在多个设备时用 `--device <serial>` 明确选择。

## 安装与本地开发

当前版本可从源码安装：

```bash
npm ci
npm run dev:setup
```

`dev:setup` 会依次运行测试、类型检查、Lint、构建、构建产物冒烟检查、
`npm link` 和最终的 `taphound --help` 检查。执行成功后即可直接调用
TapHound，例如：

```bash
taphound doctor --project /path/to/android-project
```

完整本地质量门：

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run brand:render
git diff --exit-code -- assets/brand/png
```

完整的源码、npm tarball 与 Android 设备验证步骤见[本地测试指南](docs/local-testing.md)。更换开发机器时按[换机后 TODO](TODO.md)继续跟踪剩余验收与 npm `dev` 预发布。

## CLI 命令

- `doctor`：检查 Node.js、ADB、Android CLI、应用安装、权限和设备。
- `record`：交互式执行操作并录制 Journey。
- `verify`：确定性重放 Journey 并发布报告。
- `project describe`：输出稳定的 Android 项目事实。
- `context validate` / `context status`：校验或检查 Project Context。
- `generation start` / `observe` / `step` / `confirm` / `manual` / `finalize`：管理确定性 Journey 生成会话。
- `init`：为 AI Agent 安装 TapHound AI Journey Skill。

## 配置

在 Android 项目中创建 `taphound.config.json`。`run.packageName` 必填，不会从 APK 文件名或 Activity 猜测；完整示例见 [`examples/taphound.config.json`](examples/taphound.config.json)。

```json
{
  "version": 1,
  "run": {
    "packageName": "com.example.app",
    "activity": ".MainActivity"
  },
  "idle": {
    "pollIntervalMs": 200,
    "stablePolls": 2,
    "timeoutMs": 5000
  },
  "artifactsDir": ".taphound/runs"
}
```

## 交互式录制

TapHound Recorder 展示当前 Layout，让用户选择 Action 和目标，然后由 TapHound 自己通过 ADB 执行操作。它不监听任意触摸。每个成功步骤自动记录 `activity.before` 与 `activity.after`；失败步骤不会加入 Journey；只有选择 Finish 后才原子写入完整文件。

```bash
taphound record \
  --project /path/to/android-project \
  --config taphound.config.json \
  --name "Search flow" \
  --output journeys/search.json
```

Recorder 不自动生成业务 `expect`。Activity、Element 或 Logcat 断言应由开发者或外部 Agent 显式补充。协议细节见 [Journey Schema](docs/journey-schema.md)。

支持的 Action 包括 `click`、`longClick`、`inputText`、`swipe`、`scrollTo`、`back` 和 `wait`。`scrollTo` 在确定的 `container` 中最多滑动 `maxSwipes` 次，目标 `locator` 唯一解析成功后停止，不会继续点击目标。

## Agent 驱动的 Journey 生成

源码仓库提供 [`taphound-ai-journey` Skill](assets/skills/taphound-ai-journey/SKILL.md)，指导 Droid、Claude Code、Copilot、Cursor 等 Agent：

1. 使用 `project describe` 和 Android 项目源码生成带证据哈希的 Project Context。
2. 使用 `context validate` / `context status` 检查 Context 的有效性和时效性。
3. 启动 `generation` 会话，循环观察权威设备状态、提出严格步骤并交由 TapHound 执行。
4. 使用 `generation finalize` 从初始状态完整 Replay，并仅在验证通过后发布 Journey。

```bash
taphound generation start \
  --project /path/to/android-project \
  --context .taphound/context/project-context.json \
  --device emulator-5554 \
  --json
```

设备在 `generation start` 时绑定，后续 `observe`、`step`、`confirm` 和 `manual` 命令通过 session 使用该绑定。完整流程见 Skill 的 [`GUIDE.md`](assets/skills/taphound-ai-journey/GUIDE.md)。

### 为其他 AI Agent 安装 Skill

`taphound init` 将 TapHound AI Journey Skill 复制到各 Agent 的 Skill 目录。交互式多选至少选择一个 Agent：

```bash
taphound init
```

非交互模式：

```bash
taphound init --agent claude,codex,cursor,droid
```

全局安装（用户级目录）：

```bash
taphound init --agent claude --global
```

支持的 Agent 及路径：

| Agent | 项目级路径 | 用户级路径 |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex | `.agents/skills/` | `~/.agents/skills/` |
| Cursor | `.cursor/skills/` | `~/.cursor/skills/` |
| Droid | `.factory/skills/` | `~/.factory/skills/` |
| Other | `.agents/skills/` | `~/.agents/skills/` |

Skill 随 npm 包发布，`taphound init` 从包内复制到目标目录。重新运行 `init` 会覆盖已有 Skill 文件。

## 确定性验证

```bash
taphound verify \
  --project /path/to/android-project \
  --config taphound.config.json \
  --journey journeys/search.json
```

临时覆盖 Package、Activity、设备或报告路径：

```bash
taphound verify \
  --project /path/to/android-project \
  --journey journeys/search.json \
  --device emulator-5554 \
  --package com.example.app \
  --activity .MainActivity \
  --reports /tmp/taphound-runs
```

Agent 调用时使用：

```bash
taphound verify --project . --journey journeys/search.json --json
```

`--json` 模式保证 stdout 只有一个最终 JSON 值，进度和诊断写入 stderr。详见 [Agent 集成](docs/agent-integration.md) 与 [报告协议](docs/report-schema.md)。

## 报告

每次验证写入独立目录，固定包含 `report.json` 与 `summary.txt`，按实际执行结果提供步骤日志，并尽力采集最终截图和完整 Logcat。原始验证失败保存在 `primaryFailure`；截图或日志采集问题进入 `secondaryErrors`，不会覆盖原始失败，对应可选产物也可能缺失。

## 当前限制

- 只支持 Android 与单个明确选择的设备。
- TapHound 不负责编译或安装 APK，假设目标应用已安装到设备。编译和安装由开发者或 AI Agent 在验证循环中独立完成。
- Recorder 是 TapHound 介导的交互流程，不观察用户在设备上的任意触摸。
- Recorder 只为 Android CLI 返回了 bounds 的 scrollable 元素提供 swipe；Replay 不会为缺失 bounds 的元素猜测滑动区域。
- 标注截图回退只适用于 click 与 longClick，且必须显式保存 `#编号`。
- Replay、设备操作和断言完全确定性，不包含 AI 或视觉推理。
- 源码仓库提供 Agent Skill，也可通过 `taphound init` 为其他 Agent 安装，但尚无专用 SubAgent 封装。
- 普通测试不要求真实设备；Replay 与 Generation 真机验收需要显式设置 `TAPHOUND_ACCEPTANCE_DEVICE=1` 并满足外部 Android 前提。
