# TapHound AI Journey 使用指南

本指南描述如何通过 AI agent（Droid、Claude Code、Cursor 等）驱动 TapHound
生成协议，在真实 Android 设备上完成端到端测试。

## 整体架构

```
用户提供 Goal（自然语言测试场景）
        │
        ▼
┌─────────────────────────┐
│  一次性设置（仅首次或变更时）  │
│  AI 分析源码 → Project Context │
│  taphound context validate    │
└─────────────┬───────────┘
              │ Context 复用
              ▼
┌─────────────────────────┐
│  每次测试（按 Goal 驱动）     │
│  generation start → observe   │
│  → AI 生成 step → 执行        │
│  → 重复 → finalize → verified │
└─────────────────────────┘
```

Project Context 生成一次后可复用。只有项目源码发生较大变更时才需要
重新生成（见第 5 节）。

---

## 1. 前置条件

### 1.1 环境要求

| 项目 | 要求 |
|------|------|
| Node.js | 22+（避免 23） |
| Android SDK | ADB + `uiautomator`（Android CLI） |
| 设备 | 一台在线 Android 设备（Emulator 或 USB 真机） |
| TapHound | 已 clone 仓库并 `npm ci` |

### 1.2 构建 TapHound

```bash
cd /path/to/TapHound
npm ci
npm run build
```

确认 `dist/cli/main.js` 存在：

```bash
node dist/cli/main.js --help
```

应输出 `Usage: taphound` 并列出 `doctor`、`record`、`verify`、`project`、
`context`、`generation` 命令。

### 1.3 确认设备在线

```bash
adb devices -l
```

应看到恰好一台设备处于 `device` 状态。多台设备时记下 serial
（如 `emulator-5554`），后续命令用 `--device <serial>` 指定。

### 1.4 环境诊断

```bash
node dist/cli/main.js doctor \
  --project /path/to/android-project \
  --json
```

确认 `"status": "passed"`。如果返回 exit 3 / `DEVICE_UNAVAILABLE`，
说明设备未连接或 ADB 未安装，先解决环境问题。

---

## 2. 一次性设置：生成 Project Context

> Project Context 描述了 Android 项目的 UI 结构、元素定位符和交互策略。
> 生成一次后持久化在项目目录中，后续每次测试复用。只有源码较大变更时
> 才需重新生成（见第 5 节）。

### 2.1 让 AI agent 读取指令

在你的 AI agent 工具中加载 `agent-instructions/taphound-ai-journey/` 目录。
具体方式取决于工具：

- **Droid**：将目录放入 `.factory/skills/`，或用 Skill 工具加载
- **Claude Code**：在 `CLAUDE.md` 中加
  `@agent-instructions/taphound-ai-journey/INSTRUCTIONS.md`
- **Cursor**：将目录作为 rules 导入
- **其他**：让 agent 直接读取 `INSTRUCTIONS.md`

### 2.2 让 AI 分析项目源码

告诉 AI agent：

```
请为项目 /path/to/android-project 生成 TapHound Project Context。
按照 prompts/analyze-project.md 的指导分析源码。
```

AI agent 会：

1. 读 `AndroidManifest.xml`，提取 `packageName` 和 `launchActivity`
2. 读 Kotlin/Java 源码，识别 Activity、点击处理器、Logcat 标签
3. 读布局 XML，提取 `android:id` 作为 locator 候选
4. 用 shell 计算每个文件的 SHA-256（不靠猜测）
5. 生成符合 `schemas/project-context.json` 的 JSON

### 2.3 写入并验证 Context

AI 生成的 Context 写入：

```
<project>/.taphound/context/project-context.json
```

然后验证：

```bash
node dist/cli/main.js context validate \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

**成功**：`"status": "valid"`，exit 0。Context 已就绪，进入第 3 节。

**失败**：根据错误信息修正。常见原因：

| 错误 | 原因 | 修正 |
|------|------|------|
| `CONTEXT_INVALID` | 包名/Activity 不匹配 | 对照 AndroidManifest.xml 检查 |
| `CONTEXT_INVALID` | SHA-256 不正确 | 重新用 shell 计算哈希 |
| `CONTEXT_INVALID` | 路径包含 `..` 或以 `/` 开头 | 使用项目相对路径 |
| `CONTEXT_STALE` | 文件内容与哈希不一致 | 源码已变更，重新计算哈希 |

### 2.4 检查 Context 状态（可选）

随时可以检查 Context 是否仍然有效：

```bash
node dist/cli/main.js context status \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

返回 `"valid"`（仍有效）、`"stale"`（文件已变更需更新）或
`"invalid"`（结构错误）。

### 2.5 Context 持久化

生成的 `project-context.json` 保存在项目的 `.taphound/context/` 目录中。
这个文件可以：

- **提交到 Git**：如果项目源码稳定，Context 可作为项目产物纳入版本控制
- **加入 .gitignore**：如果项目频繁变更，每次运行前动态生成

建议：首次生成后提交到 Git，源码变更时按第 5 节更新。

---

## 3. 每次测试：生成 Journey

> 每个 Goal 是一次独立的测试场景。同一 Project Context 可以驱动
> 多个不同的 Goal。

### 3.1 提供测试 Goal

用自然语言描述你要测试的场景，例如：

```
测试搜索功能：点击搜索按钮打开搜索页，在搜索框输入 hello world，
点击提交，验证日志中出现 submitted query=hello world。
```

### 3.2 Step 1 — 启动 generation session

```bash
node dist/cli/main.js generation start \
  --project /path/to/android-project \
  --config taphound.config.json \
  --context .taphound/context/project-context.json \
  --device emulator-5554 \
  --json
```

**输出**（`--json` 模式只输出一个 JSON 对象到 stdout）：

```json
{
  "status": "started",
  "exitCode": 0,
  "generationId": "a1b2c3d4-...",
  "revision": 0,
  "bindings": { "projectHash": "...", "configHash": "...", "contextHash": "...", "snapshotHash": null },
  "variables": { "runId": "...", "timestamp": "...", "randomHex": "..." },
  "target": { "packageName": "...", "deviceSerial": "...", "resetStrategy": "processOnly", "interactionPolicy": {...} }
}
```

**记下 `generationId`**，后续所有命令都用它。

**失败排查**：

| exit code | 含义 | 处理 |
|-----------|------|------|
| 2 | `CONFIG_INVALID` / `CONTEXT_INVALID` | 检查配置和 Context 文件 |
| 1 | `CONTEXT_STALE` | 源码已变更，按第 5 节更新 Context |
| 3 | 环境问题 | 先跑 `doctor` |
| 4 | 内部错误 | 查看 stderr 输出 |

### 3.3 Step 2 — 观察设备当前状态

```bash
node dist/cli/main.js generation observe \
  --project /path/to/android-project \
  --session <generationId> \
  --device emulator-5554 \
  --json
```

**输出**：

```json
{
  "status": "observed",
  "exitCode": 0,
  "generationId": "a1b2c3d4-...",
  "baseRevision": 1,
  "snapshotHash": "e5f6...",
  "snapshot": {
    "version": 1,
    "generationId": "a1b2c3d4-...",
    "baseRevision": 1,
    "deviceSerial": "emulator-5554",
    "expectedPackageName": "dev.taphound.demo",
    "foregroundPackageName": "dev.taphound.demo",
    "activity": "dev.taphound.demo.MainActivity",
    "pid": 12345,
    "capturedAt": "2026-07-24T...",
    "layout": [
      { "id": "...", "resourceId": "open_search", "text": "Open search", "clickable": true, "enabled": true, "children": [] }
    ]
  }
}
```

**记下**三个 binding 字段：`generationId`、`baseRevision`、`snapshotHash`，
以及完整的 `snapshot` 对象（包含 `layout` 数组，描述当前屏幕上所有 UI
元素）。

> 确保设备上 app 已启动并停留在预期初始界面。如果前台不是目标 app，
> observe 会返回 `SNAPSHOT_STALE` 错误。

### 3.4 Step 3 — AI 生成下一步 proposed step

让 AI agent 读取 `prompts/generate-step.md`，提供以下信息：

- **Goal**：用户的测试场景描述
- **Project Context**：第 2 节生成的 JSON
- **Snapshot**：Step 2 的 observe 输出（含 layout）
- **已完成步骤**：本次 session 中已成功的步骤列表

AI agent 分析当前屏幕上的元素，结合 Goal 决定下一步操作，输出一个
proposed step JSON（不含 `binding`，由调用方填充）。

例如，如果当前在 MainActivity，Goal 是测试搜索，AI 可能生成：

```json
{
  "action": "click",
  "locator": { "resourceId": "open_search" },
  "activity": { "before": "dev.taphound.demo.MainActivity" },
  "expect": {
    "type": "element",
    "locator": { "resourceId": "search_input" },
    "timeoutMs": 3000
  }
}
```

### 3.5 Step 4 — 构造 envelope 并执行

将 AI 生成的 proposed step 与 binding 和 snapshot 拼成完整 envelope：

```json
{
  "version": 1,
  "proposal": {
    "action": "click",
    "locator": { "resourceId": "open_search" },
    "activity": { "before": "dev.taphound.demo.MainActivity" },
    "expect": {
      "type": "element",
      "locator": { "resourceId": "search_input" },
      "timeoutMs": 3000
    },
    "binding": {
      "generationId": "<observe 返回的 generationId>",
      "baseRevision": "<observe 返回的 baseRevision>",
      "snapshotHash": "<observe 返回的 snapshotHash>"
    }
  },
  "snapshot": { "...完整 observe 返回的 snapshot..." }
}
```

写入临时文件，然后执行：

```bash
node dist/cli/main.js generation step \
  --project /path/to/android-project \
  --session <generationId> \
  --input /tmp/taphound-step.json \
  --json
```

**成功**：

```json
{
  "status": "succeeded",
  "exitCode": 0,
  "generationId": "a1b2c3d4-...",
  "revision": 3,
  "stepIndex": 0,
  "step": { "action": "click", "locator": {...}, "activity": {...} },
  "source": "planner"
}
```

**需要确认**（如果该 action 在 `confirmationRequiredActions` 中）：

```json
{
  "status": "confirmationRequired",
  "exitCode": 0,
  "challenge": {
    "challengeId": "xYz123...",
    "stepIndex": 0,
    "proposalHash": "...",
    "snapshotHash": "...",
    "actionSummary": "click submit_search on dev.taphound.demo.SearchActivity",
    "expiresAt": "2026-07-24T...",
    "status": "pending"
  }
}
```

此时需要人工确认。在 TTY 终端运行：

```bash
node dist/cli/main.js generation confirm \
  --project /path/to/android-project \
  --session <generationId> \
  --challenge <challengeId> \
  --json
```

> **重要**：AI agent 不会自动确认。必须由用户在 TTY 终端手动批准。

**失败**（locator 不存在、activity 不匹配等）：

```json
{
  "status": "error",
  "exitCode": 1,
  "failure": {
    "code": "LOCATOR_NOT_FOUND",
    "message": "No element matched resourceId=search_button"
  }
}
```

失败后 AI agent 应读取错误信息，重新 observe（Step 2），重新生成 step
（Step 3），用修正后的 locator 重试。最多重试 3 次。

### 3.6 Step 5 — 重复直到 Goal 完成

每执行成功一步后，回到 Step 2（observe）获取新的设备状态，然后 Step 3
（AI 生成下一步）→ Step 4（执行）。

AI agent 在每一步前检查 Goal 是否已完成（读 `prompts/check-completion.md`）。
如果完成则跳出循环。

**循环上限**：默认最多 30 步。超过则停止并报告未完成。

### 3.7 Step 6 — Finalize 验证

所有步骤完成后，执行 finalize：

```bash
node dist/cli/main.js generation finalize \
  --project /path/to/android-project \
  --session <generationId> \
  --context .taphound/context/project-context.json \
  --output journeys/generated-search.json \
  --device emulator-5554 \
  --json
```

**成功**：

```json
{
  "status": "verified",
  "exitCode": 0,
  "generationId": "a1b2c3d4-...",
  "bundlePath": "/path/to/project/.taphound/generations/a1b2c3d4-...",
  "journeyPath": "/path/to/project/journeys/generated-search.json",
  "metaPath": "/path/to/project/journeys/generated-search.meta.json",
  "replayed": true
}
```

Finalize 会：
1. `forceStop` app
2. 重新构建、启动、一次性完整回放所有 candidate steps
3. 检查无 fallback、无 crash、所有断言通过
4. 原子发布权威 bundle 到 `.taphound/generations/<id>/`
5. 导出 Journey v1 和 sidecar meta 到 `--output` 指定路径

**失败**：根据 `failure.code` 排查。常见：

| code | 含义 |
|------|------|
| `EXPECT_*_FAILED` | 回放时断言未通过 |
| `APP_CRASHED` | 回放时 app 崩溃 |
| `ACTIVITY_*_MISMATCH` | Activity 不匹配 |
| `EXPORT_FAILED` | 导出文件失败（可重试 finalize 不回放） |

### 3.8 验证产物

```bash
# 导出的 Journey（标准 Journey v1，可用普通 verify 重放）
cat /path/to/project/journeys/generated-search.json

# Sidecar meta（含验证状态、绑定哈希、manual override 记录）
cat /path/to/project/journeys/generated-search.meta.json

# 权威 bundle（含完整证据：每步 proposal/snapshot/logcat/result）
ls /path/to/project/.taphound/generations/<id>/
```

权威 bundle 目录结构：

```
.taphound/generations/<id>/
├── manifest.json                    # 内容文件清单 + 哈希
├── meta.json                        # 生成 meta（status: verified）
├── candidate/journey.json           # 候选 Journey
├── verified/journey.json            # 验证后的 Journey
├── generation-report.json           # 生成报告（每步 provenance）
├── verification/
│   ├── report.json                  # Verify 报告
│   └── receipt.json                 # 验证回执
└── evidence/
    ├── observations/<rev>/<attempt>/
    │   ├── snapshot.json
    │   └── screen.png
    ├── confirmations/<challengeId>/
    │   └── envelope.json
    └── steps/<index>-<attemptId>/
        ├── proposal.json
        ├── snapshot.json
        ├── logcat.txt
        └── result.json
```

### 3.9 用普通 verify 重新验证（可选）

生成的 Journey 是标准 Journey v1，可以用普通 verify 独立重放：

```bash
node dist/cli/main.js verify \
  --project /path/to/android-project \
  --journey journeys/generated-search.json \
  --device emulator-5554 \
  --json
```

这证明 AI 生成的 Journey 与手动录制的 Journey 行为完全一致。

---

## 4. 完整示例：测试 Demo 搜索功能

以 `examples/taphound-android-demo` 为例，Goal 为"测试搜索功能"。

### 4.1 生成 Context（一次性）

```bash
# 在 AI agent 中：
# "请为 examples/taphound-android-demo 生成 Project Context"
# AI 分析源码后生成：
# examples/taphound-android-demo/.taphound/context/project-context.json

# 验证
node dist/cli/main.js context validate \
  --project examples/taphound-android-demo \
  --context examples/taphound-android-demo/.taphound/context/project-context.json \
  --json
```

### 4.2 启动 session

```bash
node dist/cli/main.js generation start \
  --project examples/taphound-android-demo \
  --config taphound.config.json \
  --context .taphound/context/project-context.json \
  --device emulator-5554 \
  --json
# 记下 generationId
```

### 4.3 逐步生成（4 步）

| 步 | observe 后 AI 决策 | action | locator | expect |
|----|---------------------|--------|---------|--------|
| 1 | 主页有 open_search 按钮 | click | resourceId:open_search | element search_input 出现 |
| 2 | 搜索页有 search_input 输入框 | click | resourceId:search_input | — |
| 3 | 输入框已聚焦 | inputText "hello world" | — | — |
| 4 | 搜索页有 submit_search 按钮 | click | resourceId:submit_search | logcat SearchViewModel "submitted query=hello world" |

每步：observe → AI 生成 → 拼装 envelope → `generation step --input` → 确认 succeeded。

### 4.4 Finalize

```bash
node dist/cli/main.js generation finalize \
  --project examples/taphound-android-demo \
  --session <generationId> \
  --context .taphound/context/project-context.json \
  --output journeys/generated-search.json \
  --device emulator-5554 \
  --json
```

期望 `status: "verified"`。

### 4.5 快捷方式

也可以用自动化脚本一键完成 4.2-4.4（不经过 AI，用硬编码步骤）：

```bash
TAPHOUND_ACCEPTANCE_DEVICE=1 npm run acceptance:generation
```

> 这个脚本不使用 AI，用于验证 Core 协议本身在设备上可跑通。真实 AI
> 驱动流程按 4.1-4.4 手动逐步执行。

---

## 5. 更新 Project Context

当 Android 项目源码发生较大变更（新增/删除/修改 UI 元素、Activity、
包名等）时，需要重新生成 Project Context。

### 5.1 检查是否需要更新

```bash
node dist/cli/main.js context status \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

- `"valid"`：Context 仍然有效，无需更新
- `"stale"`：manifest 中列出的文件已变更（哈希不一致），需要更新
- `"invalid"`：Context 结构错误或项目结构已大幅变化，需要重新生成

### 5.2 更新流程

更新就是重新执行第 2 节的完整流程：

1. 让 AI agent 重新分析源码（读取 `prompts/analyze-project.md`）
2. 重新计算所有 manifest 文件的 SHA-256
3. 如果有新增/删除的 UI 元素，更新 `interactionPolicy`
4. 覆盖写入 `project-context.json`
5. 用 `context validate` 验证

```bash
# 在 AI agent 中：
# "请为项目 /path/to/android-project 重新生成 Project Context，
#  源码已更新，需要刷新哈希和 UI 元素。"

# 验证新 Context
node dist/cli/main.js context validate \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

### 5.3 何时需要更新

| 变更类型 | 需要更新 Context？ |
|----------|-------------------|
| 修改 UI 元素的 `android:id` | 是（locator 候选变化） |
| 新增/删除 Activity | 是（导航逻辑变化） |
| 修改包名 | 是（packageName 变化） |
| 修改 Logcat tag/pattern | 是（expect 候选变化） |
| 修改业务逻辑但 UI 不变 | 否（Context 描述 UI 结构，不涉及逻辑） |
| 修改主题/样式 | 否（不影响 UI 结构） |
| 修改 Gradle 配置 | 否（除非包名变了） |

---

## 6. 多场景测试

同一个 Project Context 可以驱动多个不同的 Goal，无需重复生成 Context。

```bash
# 场景 1：搜索功能
# → generation start → observe → step×4 → finalize
# → journeys/generated-search.json

# 场景 2：导航返回测试
# → generation start（新 session）→ observe → step×N → finalize
# → journeys/generated-back-test.json

# 场景 3：输入边界测试
# → generation start（新 session）→ observe → step×N → finalize
# → journeys/generated-input-edge.json
```

每个 Goal 是一个独立的 generation session，互不影响。

---

## 7. 失败排查

### 7.1 generation step 失败

| failure.code | 含义 | AI agent 应对 |
|--------------|------|--------------|
| `LOCATOR_NOT_FOUND` | locator 在当前 layout 中找不到 | 重新 observe，尝试不同 locator |
| `LOCATOR_AMBIGUOUS` | locator 匹配多个元素 | 用更具体的 locator |
| `ACTION_UNSUPPORTED` | 元素不支持该 action | 检查元素 clickable/scrollable 属性 |
| `SNAPSHOT_STALE` | 设备状态已变化 | 重新 observe |
| `PACKAGE_ESCAPE` | 前台切换到了其他 app | 确保 app 在前台，重新 observe |
| `APP_CRASHED` | app 进程崩溃 | 检查 Logcat，重启 app |
| `RISK_CONFIRMATION_REQUIRED` | action 需要用户确认 | 等待用户确认 |
| `ACTION_FORBIDDEN` | action 被策略禁止 | 换一个 action 或调整策略 |
| `RECOVERY_REQUIRED` | session 进入恢复状态 | 停止，报告 session ID |

### 7.2 generation finalize 失败

| failure.code | 含义 | 处理 |
|--------------|------|------|
| `EXPECT_*_FAILED` | 回放时断言未通过 | 检查 verification/report.json |
| `APP_CRASHED` | 回放时崩溃 | 检查 app 稳定性 |
| `ACTIVITY_*_MISMATCH` | Activity 不匹配 | 检查 step 的 activity.before |
| `EXPORT_FAILED` | 导出失败 | 可直接重试 finalize（不会重新回放） |

### 7.3 查看会话状态

```bash
# 活跃会话目录（.前缀表示进行中）
ls /path/to/project/.taphound/generations/

# 已发布的权威 bundle（无 .前缀）
ls /path/to/project/.taphound/generations/<id>/
```

### 7.4 清理重跑

```bash
# 删除上次会话产物
rm -rf /path/to/project/.taphound/generations/
rm -f /path/to/project/journeys/generated-*.json
rm -f /path/to/project/journeys/generated-*.meta.json
```

---

## 8. 安全约束

- AI agent **不会自动确认** `confirmationRequired` 步骤，必须人工批准
- AI agent **不绕过** Core 安全边界（package guard、risk policy、locator 唯一性）
- SHA-256 **始终用 shell 计算**，AI 不猜测哈希值
- 生成的 Journey 是标准 Journey v1，**可用普通 `verify` 独立重放**
- 真实设备 acceptance 与普通测试套件完全分离，**不会在 `npm test` 中运行**
