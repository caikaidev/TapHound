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

- `doctor`：检查 Node.js、ADB、Android CLI、应用安装、权限和设备。`runtime.backend=auto` 使用 ADB Runtime；`ui.backend=auto` 优先使用健康的本地 Appium UiAutomator2 provider，再回退到系统 UIAutomator 和 Android CLI snapshot provider。
- `record`：交互式执行操作并录制 Journey。
- `verify`：确定性重放 Journey 并发布报告。使用 `--contract` 时验证 Acceptance Contract：哈希绑定 Journey、前置条件、旅程后断言、证据要求，并输出 `pass`/`fail`/`inconclusive`/`needsReview`/`invalid` Verdict。使用 `--diff <ref>` 时进入 diff 模式：重放 Git 变更影响的 Journeys 并返回单一 `overall` verdict（`taphound verify --diff main`，`verify-changes` 为其冗长别名，见 `docs/agent-integration.md`）。
- `contract validate`：在不触碰设备的情况下校验 Acceptance Contract JSON 及其 Journey 哈希绑定。
- `contract review`：将外部产生的评审发现合并进已存储的 `verdict.json`；`pass`/`inconclusive` 可升级为 `needsReview`，但确定性的 `fail`/`invalid` 永远不会被改写（见 `docs/source-of-truth.md`）。
- `playbook validate`：校验 Verification Playbook（schema、哈希绑定 Contract、Escalation Policy 规则），不触碰设备（见 `docs/playbook.md`）。
- `baseline capture` / `baseline compare`：从通过的报告捕获行为 Baseline，并确定性地将新报告与之对比；`compare` 发现任何 activity/element 漂移时退出码为 1（见 `docs/checkpoint-regression.md`）。
- `failure classify`：将失败的 Verification 报告分类为简洁的结构化失败契约（类型、可能阶段、expected/actual、证据引用），供 Coding Agent 或 Diagnosis Agent 使用——不倾倒日志、不调用模型（见 `docs/failure-classification.md`）。
- `local sync <id>`：把项目的受控资产目录（context/journeys/knowledge/contracts/playbooks）复制进已注册 local target 的 workspace，使 `--target` 命令能在那里加载它们（见 `docs/local-target.md`）。
- `observe`：捕获设备即时快照（前台组件、Activity、布局、可选 logcat），无 session、无副作用。
- `project describe`：输出稳定的 Android 项目事实。
- `context list` / `validate` / `status`：查看或校验 Project Context 索引及模块分片。
- `context generate`：从项目源码生成 Project Context 脚手架（`--force` 覆盖已有索引）。
- `context refresh`：在不重新分析源码的前提下，重算 Context 证据哈希（含语义哈希）。
- `context rehash`：重算 Project Context 分片与索引哈希，可用 `--module <id...>` 限定模块。
- `journey list-flows` / `journey resolve`：校验可复用 Flow，并将组合式 Journey
  Source 解析为扁平 Journey v2。`list-flows --include-external` 还会列出供
  `generation bridge --flow` 使用的 External Flow。
- `journey check`：将 `.taphound/journeys` 下的每个已提交 Journey 按其 meta
  边界（项目、配置、Context 模块选择）与当前项目比对，分类为 `fresh`、`stale`、
  `no-meta` 或 `invalid`，并报告每个 Journey 的生命周期状态（`verified`、
  `draft`、`stale`、`suspect`、`retired`；invalid Journey 没有生命周期状态）。
  `--strict` 在存在非 fresh Journey 时以非零码退出，可用于 CI 门禁。
- `generation start` / `observe` / `next` / `step` / `confirm` / `manual` /
  `bridge` / `status` / `recover` / `config idle` / `archive` / `list` /
  `finalize`：管理确定性 Journey 生成会话。
  `bridge` 通过已绑定的 External Flow 记录跨应用流程（如相机、选择器、分享）。
  `config idle` 无需重启会话即可热调整 idle 策略；`step --replace <index>`
  通过确定性重放已存储前缀并绑定全新 snapshot，回退活动会话。
- `init`：为 AI Agent 安装 TapHound 两个内置 Skill（`taphound-journey-brief-author`、`taphound-journey-generator`）。
- `align camera`：探测设备默认相机应用并写入确定性
  `flows/external/camera/photo-capture.json` External Flow。覆盖已存在的 flow 需要
  `--force`。
- `ui-cache status` / `ui-cache clear --yes`：查看或删除仅用于加速的
  `.taphound/build/cache/ui/` 索引；不会删除 Journey、报告或 Generation 证据。
- `knowledge status` / `bootstrap` / `goal` / `plan` / `receipts` / `promote` /
  `evolve` / `feature-map`：管理已提交的 Anchor、Screen 与 Transition 知识。运行时只写不可变收据；
  只有显式 bootstrap、promote 或按收据折叠的 evolve 才会更新权威知识。`goal`
  为已知目标 Screen 起草严格 Goal Spec，`evolve` 把绑定到当前 Registry hash 的
  收据折叠进 Transition 观察计数，并把 `inferred` 文档升级为 `observed`；
  `feature-map` 派生确定性的、低 token 的 Agent 友好投影（见
  [Feature Map](docs/feature-map.md)）。
- `local add` / `list` / `inspect` / `remove`：将某个不相关的 Android 仓库注册为
  Local Target，并查看其解析路径、Git 元数据、Context 状态与 Journey 数量。
  Local Target 验证属于 dogfooding，绝不发布。`--target <id>` 使 `doctor`、
  `context generate/status/validate`、`verify`、`impact` 与 `verify-changes`
  针对已注册目标运行；详见 [Local Target](docs/local-target.md)。
- `generation start --goal <goal.json>` / `generation next`：绑定 Knowledge
  与严格 Goal，并通过现有 proposal、风险、证据和 Replay 控制执行一个已知
  Transition。
- `benchmark validate` / `list` / `run` / `compare`：以 `legacy`、`baseFlow`
  或 `knowledge` 引擎对照 Ground Truth 回放 Benchmark Case，并比较成功率、
  路由准确率、耗时与 LLM 指标。
- `journey promote --journey <path> --reason <text>`：把已验证回放通过的
  Journey 提升为持久资产。提升前会重新校验 generation bundle 内的验证报告哈希与
  已验证 Journey 证据，校验通过后才把 meta 附属文件改为 `promoted`；与证据发生
  漂移的 Journey 会失败关闭。
- `journey retire --journey <path> --reason <text>`：在 meta 附属文件中记录
  retired 生命周期状态；`journey check` 随后将其报告为 `retired`。
  `check`、`retire` 与 `promote` 均支持 `--target <id>` 针对已注册的本地目标运行。

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
是 `auto` 的第一选择，然后依次回退到系统 UIAutomator 和 Android CLI；显式选择
不可用时会失败而不会切换。`cacheEnabled:false` 只关闭本次
运行的观察缓存，不会改变 Locator 或动作结果。持久缓存只保存 resourceId、页面
合约与哈希，绝不保存旧坐标、页面源码、截图或文本；命中后仍必须重新采集 live UI
并从当前元素计算坐标。
`idle.strategy` 默认为 `hybrid`：TapHound 先使用快速帧计数，再用 Core 自行采集的
UIAutomator 结构确认稳定。如果页面持续绘制，`hybrid` 会回退到结构稳定性判定，
不会仅因帧计数持续变化而超时。已知存在持续重绘的应用可使用 `layoutDiff` 完全跳过
帧计数；只有确实需要像素帧静止时才使用 `frameStats`。
`runtime.backend` 选择设备运行时后端：默认 `auto` 与 `adb` 使用完整的
ADB + Android CLI Runtime；`mobile-mcp` 显式选择
[Mobile MCP](https://www.npmjs.com/package/@mobilenext/mobile-mcp) server。设备操作统一走 Runtime Backend
SPI：`observe`、`verify`、`record` 与 `generation` 每次运行通过
`RuntimeSessionOpener` 借用 session，`align` 仍经 bridge 路由，`doctor` 已完全
后端感知。当所选项后端缺少能力时（`mobile-mcp` 下：进程发现、前台 Activity、
logcat 导出），命令会以 `RUNTIME_CAPABILITY_MISSING`（exit code 3）失败关闭。能力矩阵与采用等级见
Runtime Backend SPI（`docs/architecture/runtime-backend.md`）。

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

支持的 Action 包括 `click`、`longClick`、`inputText`、`swipe`、`scrollTo`、`back` 和 `wait`。`click`、`longClick`、`swipe`、`scrollTo` 与 `inputText` 可同时使用 Knowledge `anchor` 作为目标（或替代运行时 `locator`）。`scrollTo` 在确定的 `container` 中最多滑动 `maxSwipes` 次，目标 `anchor` 或 `locator` 唯一解析成功后停止，不会继续点击目标。

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

Generation 也可选择绑定严格 Goal Spec 与已提交的 Knowledge hash。受限重规划
只发生在 Generation，并且只能走已知 Transition；Finalize 仍从初始状态精确
重放完整候选 Journey。详见
[Knowledge and Route Planning](docs/knowledge-planning.md)。

Base Flow 重放失败时，`generation start --json` 会返回
`FLOW_REPLAY_FAILED`，并附带 Flow 名称、Verify 报告路径、主失败、
失败步骤的 Activity/locator/expectation 摘要与恢复建议。TapHound 不会静默跳过
该 Flow，也不会把“当前恰好在 Home”当作精确重放。应修复或重录 Flow；只有用户
显式决定绕过复用时，才可省略 `--base-flow` 重新开始。

`generation manual` 会交互式构建、执行并记录一个确定性 Journey step。Generation
step JSON 会分别报告 freshness、证据准备、观察、action、idle 等待、expect、Logcat
收集及可选后续观察的耗时。当某个 locator 或 step 需要修正时，
`generation step --replace <index>` 会重放已存储的候选前缀 `[0, index)`，将会话
截断到该前缀并绑定全新 snapshot，使重新提案从已存储前缀继续而无需重启会话；
落在绑定的 Base Flow 前缀内的索引会被拒绝。

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

### 单次重放之外：确定性验证链

单次重放回答"这条 Journey 还能过吗？"，信任模型回答"任务真的完成了吗？"，由一串
确定性工件组成：

```text
Knowledge Registry → Feature Map（Agent 定位，docs/feature-map.md）
        ↓
Acceptance Contract（哈希绑定 Journey + 断言，docs/contract-schema.md）
        ↓
Verification Playbook（阶段 + Escalation Policy，docs/playbook.md）
        ↓
Journey 重放 → Evidence（report.json、截图、Logcat）
        ↓
Verdict（pass / fail / inconclusive / needsReview / invalid）
        ↓
Failure Classification（修复 Agent 的结构化失败契约，
                        docs/failure-classification.md）
        ↓
Baseline + Regression Comparator（与已知良好运行的行为漂移，
                                   docs/checkpoint-regression.md）
```

- **Semantic Anchors**（`docs/semantic-anchor.md`）：Anchor 是带有序候选链的
  语义引用；报告记录解析方式（`resolvedBy {kind, confidence}`），使 Journey
  在 XML→Compose 迁移与 resource-id 改名后仍然可用。`visualMatch` 永不由
  Core 执行。
- **Source of Truth**（`docs/source-of-truth.md`）：低信任层（语义/多模态
  Reviewer）可把确定性的 `pass` 或 `inconclusive` 升级为 `needsReview`，但
  永远不能把确定性的 `fail` 或 `invalid` 改写为成功。升级由 Playbook 中显式、
  有序的规则驱动——**AI 何时被调用本身是确定性的**。
- **Agent diff 模式**：`verify --diff <ref>` 通过 ImpactSet（P0/P1/P2）选出
  Git 变更影响的极小 Journey 集合，返回单一 `overall` verdict。

## Local Target（真实应用验证）

Local Target 是指通过 `taphound local add <id> --path <path> [--package <name>]`
注册的一个不相关 Android 仓库，使你可以针对自己的应用运行 TapHound，而无需把任何
TapHound 文件复制进该仓库。目标注册信息以 JSON 存放在 `benchmarks/` 下，每个目标
在 `.taphound/local/<id>/` 维护一个被 Git 忽略的工作目录。`doctor`、`context`、
`verify`、`impact` 与 `verify-changes` 都支持 `--target <id>` 以针对已注册目标运行。
这属于 dogfooding：生成的 Context、Journey 与报告只是给开发者循环使用的工作证据，
**绝不发布**；`generation --target` 暂缓。详见 [docs/local-target.md](docs/local-target.md)。

```bash
taphound local add my-app --path /path/to/app --package com.example.myapp
taphound doctor --target my-app
taphound verify --target my-app --journey search
taphound verify-changes --target my-app --base origin/main --head WORKTREE
```

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
