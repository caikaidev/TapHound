<p align="center">
  <img src="assets/brand/taphound-mark.svg" width="128" alt="TapHound - 基于 AI Agent 的 Android UI 测试与状态验证 CLI 工具">
</p>

# TapHound

[English](./README.md) | 简体中文

> Follow every tap. Catch every regression.

**一款基于 AI Agent 驱动的 Android 原生应用 UI 测试与状态验证 CLI 工具。**

TapHound 是一款专为 **Android AI 测试**与**状态验证**打造的 TypeScript/Node.js CLI。无论是日常的 **Android UI 自动化测试**，还是 **AI Agent 驱动的测试路径生成**，TapHound 都能基于项目上下文（Project Context）与实时设备状态，提供确定性的录制与回放能力。当前开发版本 TapHound for Android 支持录制原生 Android 工作流，并由外部 Agent 基于 Project Context 和实时设备状态生成 Journey。

TapHound Journey 是本项目完全自研的 JSON 协议、Recorder、Generation、Replay 与断言模型，与 Android CLI 官方 Journey 概念不同且不兼容。TapHound Core 不调用模型：外部 Agent 可以分析源码并提出操作，但状态绑定、风险确认、设备执行、最终 Replay 与断言均由 TapHound 确定性完成。

TapHound 只负责验证。编译和安装 APK 是独立的前置步骤，由开发者或 AI Agent 在验证循环中完成：

```
修改代码 → 编译 APK → 安装到设备 → taphound verify → 循环直到符合预期
```

## 为什么选择 TapHound 进行 Android AI 测试？

- **确定性验证（Deterministic Verification）：** 告别脚本化 UI 自动化的脆弱性。TapHound 拥有自研的断言模型与回放机制，精准捕捉每一次回归。
- **AI 代理原生（AI-Agent Native）：** 内置 `taphound-journey-brief-author`、`taphound-journey-generator` 两个 Skill，适配 Droid、Claude Code、Codex、Cursor 等 AI Agent，自动生成 Project Context、每个 Case 的 Brief 与 Android 测试路径。
- **无需侵入式构建：** 专注测试与验证，独立于 APK 编译与安装流程，可直接对已安装的目标 APK 进行原生 Android UI 自动化测试。

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

- `doctor`：检查 Node.js、ADB、Android CLI、应用安装、权限和设备；显式使用 `ui.backend=appium-uiautomator2` 时还检查本地 Appium 与 UiAutomator2 driver。
- `record`：交互式执行操作并录制 Journey。
- `verify`：确定性重放 Journey 并发布报告。
- `observe`：捕获设备即时快照（前台组件、Activity、布局、可选 logcat），无 session、无副作用。
- `project describe`：输出稳定的 Android 项目事实。
- `context list` / `validate` / `status`：查看或校验 Project Context 索引及模块分片。
- `context refresh`：在不重新分析源码的前提下，重算 Context 证据哈希（含语义哈希）。
- `journey list-flows` / `journey resolve`：校验可复用 Flow，并将组合式 Journey
  Source 解析为扁平 Journey v1。`list-flows --include-external` 还会列出供
  `generation bridge --flow` 使用的 External Flow。
- `generation start` / `observe` / `step` / `confirm` / `manual` / `bridge` /
  `status` / `recover` / `archive` / `list` / `finalize`：管理确定性 Journey 生成会话。
  `bridge` 通过已绑定的 External Flow 记录跨应用流程（如相机、选择器、分享）。
- `init`：为 AI Agent 安装 TapHound 两个内置 Skill（`taphound-journey-brief-author`、`taphound-journey-generator`）。
- `align camera`：探测设备默认相机应用并写入确定性
  `flows/external/camera/photo-capture.json` External Flow。覆盖已存在的 flow 需要
  `--force`。
- `ui-cache status` / `ui-cache clear --yes`：查看或删除仅用于加速的
  `.taphound/build/cache/ui/` 索引；不会删除 Journey、报告或 Generation 证据。

## 配置

在 Android 项目中创建 `.taphound/config.json`。`run.packageName` 必填，不会从 APK 文件名或 Activity 猜测；完整示例见 [`examples/.taphound/config.json`](examples/.taphound/config.json)。

```json
{
  "version": 1,
  "run": {
    "packageName": "com.example.app",
    "activity": ".MainActivity"
  },
  "idle": {
    "strategy": "hybrid",
    "pollIntervalMs": 200,
    "stablePolls": 2,
    "timeoutMs": 5000
  },
  "ui": {
    "backend": "auto",
    "snapshotTimeoutMs": 5000,
    "cacheEnabled": true
  },
  "artifactsDir": ".taphound/build/runs"
}
```

`artifactsDir` 可省略，默认为 `.taphound/build/runs`。
`ui` 可省略；运行时默认使用 `auto`。可显式选择
`system-uiautomator`、`android-cli` 或 `appium-uiautomator2`，其中 Appium
始终是显式选择，后端不可用会失败而不会切换。`cacheEnabled:false` 只关闭本次
运行的观察缓存，不会改变 Locator 或动作结果。持久缓存只保存 resourceId、页面
合约与哈希，绝不保存旧坐标、页面源码、截图或文本；命中后仍必须重新采集 live UI
并从当前元素计算坐标。
`idle.strategy` 默认为 `hybrid`：TapHound 先使用快速帧计数，再用 Core 自行采集的
UIAutomator 结构确认稳定。如果页面持续绘制，`hybrid` 会回退到结构稳定性判定，
不会仅因帧计数持续变化而超时。已知存在持续重绘的应用可使用 `layoutDiff` 完全跳过
帧计数；只有确实需要像素帧静止时才使用 `frameStats`。

Generation 会在 session 启动时绑定规范化后的完整配置。请在
`generation start` 前确定 idle 策略与超时时间；配置变更后必须创建新 session。

## 工作目录结构

TapHound 在 Android 项目中只留下一份可预测的目录结构：需要提交的输入与产物放在
`.taphound/` 顶层，所有临时数据都在 `.taphound/build/` 下，因此一条忽略规则即可
覆盖全部生成物。

```text
<project>/
  .taphound/
    config.json           # 需提交的 TapHound 配置
    .gitignore            # 首次生成，内容为 "build/"；不会被覆盖
    context/              # 需提交的 Project Context bundle
      project-context.json
      modules/*.json
    flows/                # 需提交的可复用导航前缀
    sources/              # 需提交的组合式叶子 Journey source
    journeys/             # 需提交的 Journey 及 <name>.meta.json 附属文件
    build/                # 临时数据，可安全删除，由 Git 忽略
      generations/<id>/   # 权威 generation bundle
      jobs/<id>/          # 分离式 finalize 的 stdout 与进度
      runs/<runId>/       # verify 报告、截图、Logcat
```

请把 `.taphound/build/` 加入 `.gitignore`，其余内容提交入库。在 record、verify
或 generation 工作前，TapHound 会写入内容为 `build/` 的 `.taphound/.gitignore`，
并且永远不会覆盖你自己维护的同名文件。`artifactsDir` 与 `verify --reports` 可以
指向 `.taphound` 外部，但位于 `.taphound` 内部时必须保持在 `.taphound/build/`
下面。旧结构使用 `.taphound/generations`、`.taphound/jobs` 与
`.taphound/runs`；一旦检测到这些目录，TapHound 会以 `CONFIG_INVALID` 停止并打印
需要执行的 `mv` 命令；根目录中散落的时间戳 Verify run 也会按相同方式检测。

## 交互式录制与 Android UI 自动化测试 (Interactive Recording)

TapHound Recorder 展示当前 Layout，让用户选择 Action 和目标，然后由 TapHound 自己通过 ADB 执行操作。它不监听任意触摸。每个成功步骤自动记录 `activity.before` 与 `activity.after`；失败步骤不会加入 Journey；只有选择 Finish 后才原子写入完整文件。

```bash
taphound record \
  --project /path/to/android-project \
  --config .taphound/config.json \
  --name "Search flow" \
  --output .taphound/journeys/search.json
```

Recorder 不自动生成业务 `expect`。Activity、Element 或 Logcat 断言应由开发者或外部 Agent 显式补充。协议细节见 [Journey Schema](docs/journey-schema.md)。

支持的 Action 包括 `click`、`longClick`、`inputText`、`swipe`、`scrollTo`、`back` 和 `wait`。`scrollTo` 在确定的 `container` 中最多滑动 `maxSwipes` 次，目标 `locator` 唯一解析成功后停止，不会继续点击目标。

## AI 驱动的 Android 测试路径生成 (Agent-Driven Generation)

源码仓库提供两个 Skill：
[`taphound-journey-brief-author`](assets/skills/taphound-journey-brief-author/SKILL.md)
负责从源码证据生成与维护 Project Context Bundle，并为每个 Case 生成 Brief；
[`taphound-journey-generator`](assets/skills/taphound-journey-generator/SKILL.md) 负责单个
Journey 场景，从 Context 与实时设备状态一直执行到最终 Replay。

Requirement Analysis、Planning、Coding、Build/Install、多 Case 调度、完成 Gate
和 Diagnosis 属于外部 Workflow Skills。外部编排器可以针对每个独立 Case 调用
一次 TapHound，并把公开 CLI JSON、Report 和 Evidence 转换为自己的协议。
TapHound 不规定、也不打包完整开发 Workflow。

外部编排器可以把项目内的 `taphound-journey-brief.md` 通过
`journeyBrief: {path, sha256}` 绑定到一个 Case。Brief 提供前置条件、预期
Journey、断言、实现提示、约束和证据引用。它属于 Skill 层静态提示，不是 Core
CLI 输入；经过校验的 Project Context、实时 Snapshot 和最终 Replay 仍然权威。

Journey Skill 会指导 Droid、Claude Code、Codex、Cursor 等 Agent：

1. 运行 `taphound-journey-brief-author` Skill，生成精简的 Project Context 根索引以及每个 Gradle 模块独立的语义/证据分片（一次性，按需刷新）。
2. 使用 `context list` 选择 Goal 相关模块，并通过 `context validate` / `context status` 检查分片、证据与文件清单时效性。
3. 按确定性 Activity 契约选择可复用 Base Flow。解析后的首步必须从冷启动后可确定
   到达的稳定 Activity 开始，不能要求瞬态 Splash 保持前台。例如
   `core/launch-home` 应建模为 `wait: Home -> Home`，并断言 Home 页面唯一元素。
4. 使用 `--module` 启动 `generation` 会话。不带 `--base-flow` 时，Core 会先
   force-stop、启动配置的 Activity 并等待应用进程。`run.activity` 只表示冷启动入口；
   自动跳转后的稳定起点由首次观察已有的 idle/layout 检查确定。使用
   `observe --compact` 并读取权威
   `snapshotRef`；活动引用位于 Store 管理的 `.<generationId>.work` bundle，
   成功的 compact step 会返回 `nextBinding` 与 `nextSnapshotRef`。
5. 使用 `generation status` 检查持久化状态，包括待确认与已过期 challenge。确认默认
   使用本地 TTY；用户明确审阅具体 challenge 后，沙箱 Agent 可运行
   `generation confirm --decision approve|decline`。中断的 in-flight action
   可能已执行，只有显式运行 `generation recover --decision retry` 承认该风险后才会恢复。
6. 长耗时 Replay 使用 `generation finalize --detach`，随后轮询
   `generation status`（或使用 `--wait`）。只有精确验证通过后才发布 Journey。

```bash
taphound generation start \
  --project /path/to/android-project \
  --context .taphound/context/project-context.json \
  --module :feature:search \
  --device emulator-5554 \
  --json
```

设备在 `generation start` 时绑定，后续 `observe`、`step`、`confirm`、`manual`、
`bridge`、`status`、`recover` 和 `archive` 命令通过 session 使用该绑定。
`generation start --external-flow <name...>` 按内容哈希绑定具名 External Flow，
供后续 `generation bridge --flow <name>` 确定性解析。完整流程见 Skill 的
[`GUIDE.md`](assets/skills/taphound-journey-generator/GUIDE.md)。

Base Flow 重放失败时，`generation start --json` 会返回
`FLOW_REPLAY_FAILED`，并附带 Flow 名称、Verify 报告路径、主失败、
失败步骤的 Activity/locator/expectation 摘要与恢复建议。TapHound 不会静默跳过
该 Flow，也不会把“当前恰好在 Home”当作精确重放。应修复或重录 Flow；只有用户
显式决定绕过复用时，才可省略 `--base-flow` 重新开始。

`generation manual` 会交互式构建、执行并记录一个确定性 Journey step。Generation
step JSON 会分别报告 freshness、证据准备、观察、action、idle 等待、expect、Logcat
收集及可选后续观察的耗时。

### 为外部 AI Agent 安装 TapHound 测试技能 (Installing the Skills)

`taphound init` 将 TapHound 两个内置 Skill 复制到各 Agent 的 Skill 目录。交互式多选至少选择一个 Agent：

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

这些 Skill 随 npm 包发布，`taphound init` 从包内复制到目标目录。重新运行 `init`
会覆盖 payload 中存在的同名文件，但不会删除目标目录中上一次安装遗留的陈旧文件。

## 确定性状态验证 (Deterministic Verification)

```bash
taphound verify \
  --project /path/to/android-project \
  --config .taphound/config.json \
  --journey .taphound/journeys/search.json
```

临时覆盖 Package、Activity、设备或报告路径：

```bash
taphound verify \
  --project /path/to/android-project \
  --journey .taphound/journeys/search.json \
  --device emulator-5554 \
  --package com.example.app \
  --activity .MainActivity \
  --reports /tmp/taphound-runs
```

Agent 调用时使用：

```bash
taphound verify --project . --journey .taphound/journeys/search.json --json
```

`--json` 模式保证 stdout 只有一个最终 JSON 值，进度和诊断写入 stderr。详见 [Agent 集成](docs/agent-integration.md) 与 [报告协议](docs/report-schema.md)。

## 报告

每次验证写入独立目录，固定包含 `report.json` 与 `summary.txt`，按实际执行结果提供步骤日志，并尽力采集最终截图和完整 Logcat。原始验证失败保存在 `primaryFailure`；截图或日志采集问题进入 `secondaryErrors`，不会覆盖已存在的原始失败。当验证本身通过但采集失败时，首个采集错误会成为 `primaryFailure`（错误码 `COLLECTION_FAILED`），其余进入 `secondaryErrors`；对应可选产物也可能缺失。

## 常见问题（FAQ）

**Q：TapHound 如何结合大模型进行 Android AI 验证？**
A：TapHound Core 本身不调用 AI 模型。外部 AI Agent 通过分析源码提出测试动作，而 TapHound 负责状态绑定、风险确认、设备执行、最终 Replay 与断言，完成确定性的 Android 状态验证。

**Q：TapHound 支持非 Android 平台吗？**
A：当前开发版本专属优化于 Android 原生工作流，仅支持 Android SDK、ADB 及在线模拟器/真机。

**Q：TapHound 会不会编译或安装 APK？**
A：不会。编译与安装是独立的前置步骤，由开发者或 AI Agent 在验证循环中完成；TapHound 假设目标 APK 已安装到设备。

**Q：Replay 过程会用到 AI 或视觉推断吗？**
A：不会。Replay、设备操作和断言完全确定性，不包含 AI 或视觉推理。

## 当前限制

- 只支持 Android 与单个明确选择的设备。
- TapHound 不负责编译或安装 APK，假设目标应用已安装到设备。编译和安装由开发者或 AI Agent 在验证循环中独立完成。
- Recorder 是 TapHound 介导的交互流程，不观察用户在设备上的任意触摸。
- Recorder 只为 Android CLI 返回了 bounds 的 scrollable 元素提供 swipe；Replay 不会为缺失 bounds 的元素猜测滑动区域。
- 标注截图回退只适用于 click 与 longClick，且必须显式保存 `#编号`。
- Replay、设备操作和断言完全确定性，不包含 AI 或视觉推理。
- 源码仓库提供两个 Agent Skill，可通过 `taphound init` 为其他 Agent 安装，但尚无专用 SubAgent 封装。
- 普通测试不要求真实设备；Replay 与 Generation 真机验收需要显式设置 `TAPHOUND_ACCEPTANCE_DEVICE=1` 并满足外部 Android 前提。
