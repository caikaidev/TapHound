# 从 Agent CLI 调用 TapHound

TapHound 提供两类 Agent 集成面：

- 使用 `taphound verify --json` 确定性验收已有 Journey。
- 使用 Project Context 与 `taphound generation ... --json` 生成新 Journey，再由 TapHound 从初始状态完整 Replay 并验证后发布。

外部 Agent 可以分析源码、判断目标是否完成并提出下一步操作，但 TapHound Core 不调用模型。Project Context 校验、设备状态绑定、提案验证、风险确认、ADB 执行、最终 Replay 与断言均由确定性代码负责。

## 验证已有 Journey

典型流程是：开发者使用 Claude Code 或其他 Agent CLI 实现需求，完成后让 Agent 调用 TapHound Journey 验证代码是否符合预期。

```bash
taphound verify \
  --project /workspace/android-app \
  --config /workspace/android-app/taphound.config.json \
  --journey /workspace/android-app/journeys/search.json \
  --device emulator-5554 \
  --json
```

## 机器契约

- `verify --json` 的 stdout 恰好输出一个 JSON 值和结尾换行，不包含进度文本。
- stderr 接收预检、进度和诊断，可由 Agent 单独保存。
- 进程退出码与 JSON `exitCode` 一致。
- `0` 表示通过；`1` 是产品验证失败；`2` 是输入无效；`3` 是环境不可用；`4` 是 TapHound 内部错误。
- 有报告时读取 `reportPath`、`report.primaryFailure`、`report.secondaryErrors` 和分层结果。
- 没有报告时读取顶层 `failure.code` 与 `failure.message`。

不要只搜索 stdout 文本中的 “passed”；应先判断进程状态和 `exitCode`，再读取结构化字段。

## Node.js 调用示例

```js
import { spawn } from "node:child_process";

const child = spawn("taphound", [
  "verify",
  "--project", projectRoot,
  "--journey", journeyPath,
  "--json"
], { shell: false });

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });

child.on("close", code => {
  const result = JSON.parse(stdout);
  if (code !== result.exitCode) throw new Error("TapHound exit contract mismatch");
  // 将 result.report.primaryFailure 反馈给开发 Agent。
});
```

调用方也必须使用参数数组并保持 `shell: false`，避免把项目路径或用户输入拼成 Shell 命令。

## 生成新 Journey

生成流程使用仓库内的 [`taphound-ai-journey` Skill](../.factory/skills/taphound-ai-journey/SKILL.md)：

1. `project describe --json` 输出稳定的 Package、Activity、Variant 与 APK 信息。
2. Agent 分析 Android 项目源码，生成带文件哈希证据的 Project Context。
3. `context validate` / `context status` 检查 Context 的结构、身份和时效性。
4. `generation start` 绑定项目、配置、Context 和设备。
5. Agent 循环调用 `generation observe` 获取权威 snapshot，再通过 `generation step` 提交与 snapshot 严格绑定的提案；需要人工批准时使用 `generation confirm`，本地 TTY 覆盖使用 `generation manual`。
6. `generation finalize` 从初始状态完整 Replay；只有精确验证通过后才发布 Journey 和不可变证据。

```bash
taphound project describe --project /workspace/android-app --json
taphound context validate \
  --project /workspace/android-app \
  --context .taphound/context/project-context.json \
  --json
taphound generation start \
  --project /workspace/android-app \
  --context .taphound/context/project-context.json \
  --device emulator-5554 \
  --json
```

设备在 `generation start` 时绑定。`generation observe`、`step`、`confirm` 和 `manual` 通过 `--session` 使用该绑定，不接受 `--device`；`generation finalize` 可以显式提供 `--device`，但不得改变会话身份绑定。

Generation 的 `--json` 命令同样只向 stdout 写入一个机器可读 JSON 值，并用 `exitCode` 表示结果。Agent 必须保留 `generationId`、`baseRevision`、`snapshotHash` 和完整 snapshot，不能自行伪造或重用过期绑定。完整协议、重试规则与 Context 更新策略见 Skill 的 [`GUIDE.md`](../.factory/skills/taphound-ai-journey/GUIDE.md)。

Skill 当前位于源码仓库的 `.factory/skills/taphound-ai-journey/`。当前 `package.json` 的 npm 文件清单不包含 `.factory/skills/`，因此 npm tarball 不会自动安装该 Skill；其他 Agent 可按 Skill 中的说明复制、链接或直接加载该目录。

## 给 Claude Code 的最小指令

```text
实现完成后运行：
taphound verify --project . --journey journeys/search.json --json
解析 JSON；exitCode=0 才算验收通过。
若失败，优先报告 report.primaryFailure，并附上 reportPath。
不要修改 Journey 来掩盖实现缺陷。
```

## 安全与确定性

TapHound Replay 不调用 AI。Agent 可以选择已有 Journey，也可以在 generation 会话中提出新步骤，但 Locator、Activity、Layout Diff、风险策略与 Expect 的最终判定均由确定性代码完成。Agent 不应在失败后自动放宽断言、替换 Package、删除步骤或绕过确认。
