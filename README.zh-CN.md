<p align="center">
  <img src="assets/brand/taphound-mark.svg" width="128" alt="TapHound - 基于 AI Agent 的 Android UI 测试与状态验证 CLI 工具">
</p>

# TapHound

[English](./README.md) | 简体中文

> Follow every tap. Catch every regression.

**以 Agent 为入口的 Android 改动验收与 Bug 修复工具，输出可复核证据，按需支持 Journey 确定性回放。**

当前 Android 开发版本称为 **TapHound for Android**。TapHound 默认使用 **tap-check** 验收开发改动、使用 **tap-fix** 先复现再修复 Bug；原有高级 Core 继续提供 UI **Journey** 的录制、生成与确定性回放。它面向这样的团队：AI 编码 Agent（Droid、Claude Code、Codex、Cursor 等）写代码的速度已经快过人能审阅的速度。Agent 基于源码与实时设备状态提出测试步骤，TapHound 负责执行、验证与报告——全程确定性，回放链路中不含任何 AI 或视觉猜测——让"完成"意味着在真机上被证明过。

TapHound Journey 是本项目自研的 JSON 协议，拥有独立的 Recorder、Generation、Replay 与断言模型，与 Android CLI 官方 Journey 概念不同且不兼容。

## 工作原理

默认验证不需要预先创建 Journey、Contract 或 Project Context，也不会逐项询问用户。Agent 结合需求和源码建立验证预期，在指定设备上执行目标验证、原有相关单测、影响范围回归，并归档证据。UI 后端优先级为 Mobile MCP → Appium → ADB。

```text
“验收这次修改” → tap-check → Target + Existing Tests + Regression
“修复这个 Bug” → tap-fix   → RED → 原断言 GREEN + 关联回归
                                      ↓
                                 feedback.zip
```

通过 `taphound init --agent codex` 安装，或直接复制 [field-skills/](./field-skills/README.md) 的三个目录。Journey/Contract Core 仍保留，按需用于长期回归、CI 与跨版本等价性验证。
TapHound Core 不调用 AI 模型。外部 Agent 可以分析源码并提出操作，但状态绑定、风险确认、设备执行、最终 Replay 与断言均由 TapHound 确定性完成。

高级 Journey/Contract Core 本身只负责验证；默认 Field Skills 可由编码 Agent 调用项目的构建和安装命令。以下是可选的**旧版**流程示意：

```
判断改动类型 → 修改代码 → 编译并安装 → taphound-flash（几秒，冒烟）→ 继续修改
                                      → taphound-verify-change（证明）→ 完成
```

改动类型决定证明方式：新行为（无论是否涉及 UI）必须通过 Acceptance Contract；重构（包括 XML → Compose 迁移）必须复现改动前采集的行为。详见 [Workflow Skills](https://github.com/caikaidev/TapHound/blob/main/docs/workflow-skills.md)。

## 核心能力

- **录制** —— 在真机上交互式录制 Journey（`taphound record`）。
- **验证** —— 确定性回放 Journey 并发布报告（`taphound verify`）；`verify --diff <ref>` 只回放某次 Git 变更影响的 Journey。
- **生成** —— AI Agent 驱动的 Journey 生成：步骤绑定证据、敏感操作需风险确认，发布前必须通过一次精确回放（`taphound generation ...`）。
- **信任链** —— Acceptance Contract、行为 Baseline 与 Failure Classification，把一次回放转化为可审计的判定结论。
- **知识体系** —— 语义化的 Anchor 与 Screen，让 Journey 在 UI 重构和 resource-id 改名后仍然可用。
- **旧版高级 Skill** —— 六个可选 Skill（`taphound init --profile legacy`）：`taphound-flash`（编码过程中只依赖 adb 的独立冒烟检查）、`taphound-verify-change`（完成前的把关：验收新行为或证明行为保持不变）、`taphound-journey-brief-author` 与 `taphound-journey-generator`（把一个 Case 变成经过验证的 Journey）、`taphound-case-suite`（多个 Case 逐个推进）、`taphound-bug-fix`（先复现用户报告的 bug 或 crash，再修复，并证明同一场景已通过）。

## 环境要求

- Node.js 22 或更高版本
- Android SDK、ADB 和目标项目的构建工具（高级 Journey/Contract 的部分后端还需要 `android` CLI）
- 一个在线设备或模拟器，且目标 APK 已安装
- macOS 只有选择使用 Android CLI 高级后端时，才需要授予辅助功能与屏幕录制权限

单独使用 `taphound-flash` 只需要 Node.js 18+ 与 ADB。

先执行环境诊断：

```bash
taphound doctor --project /path/to/android-project
```

## 安装

```bash
npm ci
npm run dev:setup   # 测试、类型检查、Lint、构建、npm link
```

tarball 与真机验证步骤见[本地测试指南](https://github.com/caikaidev/TapHound/blob/main/docs/local-testing.md)，版本发布流程见[发布](https://github.com/caikaidev/TapHound/blob/main/docs/releasing.md)。

## 快速上手：默认 Field Skills

```bash
taphound init --agent claude,codex,cursor,droid
# 或直接复制 field-skills/ 下的 tap-check、tap-fix、taphound-flash 三个目录。
```

然后告诉 Agent“验收这次修改”或者“复现并修复这个 Bug”。反馈位于 `.taphound/feedback/<case-id>/feedback.zip`。此默认流程无需 `.taphound/config.json`。

如果已经安装了旧版六个 Skill，请先备份并移出 Agent 的 Skills 目录。安装器会拒绝混合 Profile，不会静默覆盖不同版本，也不会删除自定义文件。

## 高级 Journey/Contract（按需）

```bash
taphound init --agent codex --profile legacy
```

需要持久化的确定性验证（非日常验收前置条件）时，可在 Android 项目中创建 `.taphound/config.json`（完整字段参考 [config-schema](https://github.com/caikaidev/TapHound/blob/main/docs/config-schema.md)，完整示例见 [`examples/.taphound/config.json`](https://github.com/caikaidev/TapHound/blob/main/examples/.taphound/config.json)）：

```json
{
  "version": 1,
  "run": { "packageName": "com.example.app", "activity": ".MainActivity" }
}
```

录制一条 Journey，然后回放验证：

```bash
taphound record --project . --name "Search flow" --output .taphound/journeys/search.json
taphound verify --project . --journey .taphound/journeys/search.json
```

安装**旧版高级** Journey/Contract 工作流：

```bash
taphound init --agent claude,codex,cursor,droid --profile legacy
```

## 文档

- [Journey 协议](https://github.com/caikaidev/TapHound/blob/main/docs/journey-schema.md) · [配置参考](https://github.com/caikaidev/TapHound/blob/main/docs/config-schema.md) · [报告协议](https://github.com/caikaidev/TapHound/blob/main/docs/report-schema.md)
- [设计原则](https://github.com/caikaidev/TapHound/blob/main/docs/principles.md) · [Workflow Skill 与开发场景](https://github.com/caikaidev/TapHound/blob/main/docs/workflow-skills.md) · [Agent 集成](https://github.com/caikaidev/TapHound/blob/main/docs/agent-integration.md) · [Journey Generator 指南](https://github.com/caikaidev/TapHound/blob/main/docs/journey-generator-guide.md)
- [Acceptance Contract](https://github.com/caikaidev/TapHound/blob/main/docs/contract-schema.md) · [Baseline 与回归对比](https://github.com/caikaidev/TapHound/blob/main/docs/checkpoint-regression.md) · [失败分类](https://github.com/caikaidev/TapHound/blob/main/docs/failure-classification.md)
- [Semantic Anchor](https://github.com/caikaidev/TapHound/blob/main/docs/semantic-anchor.md) · [能力矩阵](https://github.com/caikaidev/TapHound/blob/main/docs/capability-matrix.md) · [`observe`](https://github.com/caikaidev/TapHound/blob/main/docs/observe.md)
- [运行时后端](https://github.com/caikaidev/TapHound/blob/main/docs/architecture/runtime-backend.md) · [本地开发与测试](https://github.com/caikaidev/TapHound/blob/main/docs/local-testing.md) · [发布](https://github.com/caikaidev/TapHound/blob/main/docs/releasing.md) · [诊断与反馈](https://github.com/caikaidev/TapHound/blob/main/docs/diagnostics.md)

## 当前限制

- 仅支持 Android，且同一时刻只操作一台明确选择的设备。
- 高级 Journey/Contract Core 不构建或安装 APK；默认 Field Skills 可由编码 Agent 调用项目构建与安装。
- Recorder 是 TapHound 介导的交互流程，不观察用户在设备上的任意触摸。
- 回放、设备操作与断言完全确定性，Core 中不包含 AI 或视觉推理。
