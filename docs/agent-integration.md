# 从 Agent CLI 调用 APR

APR v0.2 的稳定 Agent 集成面是 `apr verify --json`。典型流程是：开发者使用 Claude Code 或其他 Agent CLI 实现需求，完成后让 Agent 调用 APR Journey 验证代码是否符合预期。

```bash
apr verify \
  --project /workspace/android-app \
  --config /workspace/android-app/apr.config.json \
  --journey /workspace/android-app/journeys/search.json \
  --device emulator-5554 \
  --json
```

## 机器契约

- stdout 恰好输出一个 JSON 值和结尾换行，不包含进度文本。
- stderr 接收预检、进度和诊断，可由 Agent 单独保存。
- 进程退出码与 JSON `exitCode` 一致。
- `0` 表示通过；`1` 是产品验证失败；`2` 是输入无效；`3` 是环境不可用；`4` 是 APR 内部错误。
- 有报告时读取 `reportPath`、`report.primaryFailure`、`report.secondaryErrors` 和分层结果。
- 没有报告时读取顶层 `failure.code` 与 `failure.message`。

不要只搜索 stdout 文本中的 “passed”；应先判断进程状态和 `exitCode`，再读取结构化字段。

## Node.js 调用示例

```js
import { spawn } from "node:child_process";

const child = spawn("apr", [
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
  if (code !== result.exitCode) throw new Error("APR exit contract mismatch");
  // 将 result.report.primaryFailure 反馈给开发 Agent。
});
```

调用方也必须使用参数数组并保持 `shell: false`，避免把项目路径或用户输入拼成 Shell 命令。

## 给 Claude Code 的最小指令

```text
实现完成后运行：
apr verify --project . --journey journeys/search.json --json
解析 JSON；exitCode=0 才算验收通过。
若失败，优先报告 report.primaryFailure，并附上 reportPath。
不要修改 Journey 来掩盖实现缺陷。
```

未来可以把上述约定封装成 Codex/Claude Code Skill，或者交给专门的 SubAgent 执行并摘要报告；Skill 与 SubAgent 集成本身不在 v0.2，本期不提供或暗示自动安装。

## 安全与确定性

APR Replay 不调用 AI。Agent 只能选择要运行的已有 Journey 和 CLI 覆盖项；Locator、Activity、Layout Diff 与 Expect 的最终判定均由确定性代码完成。Agent 不应在失败后自动放宽断言、替换 Package 或删除步骤。
