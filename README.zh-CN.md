<p align="center">
  <img src="assets/brand/taphound-mark.svg" width="128" alt="TapHound - 基于 AI Agent 的 Android UI 测试与状态验证 CLI 工具">
</p>

# TapHound

[English](./README.md) | 简体中文

> Follow every tap. Catch every regression.

**一款基于 AI Agent 驱动的 Android 原生应用 UI 测试与状态验证 CLI 工具。**

TapHound 面向原生 Android 应用，提供 UI **Journey** 的录制、生成与确定性回放，当前开发版本为 TapHound for Android。它面向这样的团队：AI 编码 Agent（Droid、Claude Code、Codex、Cursor 等）写代码的速度已经快过人能审阅的速度。Agent 基于源码与实时设备状态提出测试步骤，TapHound 负责执行、验证与报告——全程确定性，回放链路中不含任何 AI 或视觉猜测——让"完成"意味着在真机上被证明过。

TapHound Journey 是本项目自研的 JSON 协议，拥有独立的 Recorder、Generation、Replay 与断言模型，与 Android CLI 官方 Journey 概念不同且不兼容。

## 工作原理

TapHound Core 不调用 AI 模型。外部 Agent 可以分析源码并提出操作，但状态绑定、风险确认、设备执行、最终 Replay 与断言均由 TapHound 确定性完成。

TapHound 只负责验证。编译和安装 APK 是开发者/Agent 循环中独立的前置步骤，内置 Skill 在两个深度上做检查：

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
- **Agent Skill** —— 五个可安装的 Skill（`taphound init`）：`taphound-flash`（编码过程中只依赖 adb 的独立冒烟检查）、`taphound-verify-change`（完成前的把关：验收新行为或证明行为保持不变）、`taphound-journey-brief-author` 与 `taphound-journey-generator`（把一个 Case 变成经过验证的 Journey）、`taphound-case-suite`（多个 Case 逐个推进）。

## 环境要求

- Node.js 22 或更高版本
- Android SDK、ADB，以及可调用的 `android` CLI
- 一个在线设备或模拟器，且目标 APK 已安装
- macOS 上需授予 Android CLI 辅助功能与屏幕录制权限

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

## 快速上手

在 Android 项目中创建 `.taphound/config.json`（完整字段参考 [config-schema](https://github.com/caikaidev/TapHound/blob/main/docs/config-schema.md)，完整示例见 [`examples/.taphound/config.json`](https://github.com/caikaidev/TapHound/blob/main/examples/.taphound/config.json)）：

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

面向 AI Agent：安装内置 Skill，由 Agent 驱动生成流程：

```bash
taphound init --agent claude,codex,cursor,droid
```

## 文档

- [Journey 协议](https://github.com/caikaidev/TapHound/blob/main/docs/journey-schema.md) · [配置参考](https://github.com/caikaidev/TapHound/blob/main/docs/config-schema.md) · [报告协议](https://github.com/caikaidev/TapHound/blob/main/docs/report-schema.md)
- [设计原则](https://github.com/caikaidev/TapHound/blob/main/docs/principles.md) · [Workflow Skill 与开发场景](https://github.com/caikaidev/TapHound/blob/main/docs/workflow-skills.md) · [Agent 集成](https://github.com/caikaidev/TapHound/blob/main/docs/agent-integration.md) · [Journey Generator 指南](https://github.com/caikaidev/TapHound/blob/main/docs/journey-generator-guide.md)
- [Acceptance Contract](https://github.com/caikaidev/TapHound/blob/main/docs/contract-schema.md) · [Baseline 与回归对比](https://github.com/caikaidev/TapHound/blob/main/docs/checkpoint-regression.md) · [失败分类](https://github.com/caikaidev/TapHound/blob/main/docs/failure-classification.md)
- [Semantic Anchor](https://github.com/caikaidev/TapHound/blob/main/docs/semantic-anchor.md) · [能力矩阵](https://github.com/caikaidev/TapHound/blob/main/docs/capability-matrix.md) · [`observe`](https://github.com/caikaidev/TapHound/blob/main/docs/observe.md)
- [运行时后端](https://github.com/caikaidev/TapHound/blob/main/docs/architecture/runtime-backend.md) · [本地开发与测试](https://github.com/caikaidev/TapHound/blob/main/docs/local-testing.md) · [发布](https://github.com/caikaidev/TapHound/blob/main/docs/releasing.md) · [诊断与反馈](https://github.com/caikaidev/TapHound/blob/main/docs/diagnostics.md)

## 当前限制

- 仅支持 Android，且同一时刻只操作一台明确选择的设备。
- TapHound 不负责编译或安装 APK，目标应用必须已安装到设备。
- Recorder 是 TapHound 介导的交互流程，不观察用户在设备上的任意触摸。
- 回放、设备操作与断言完全确定性，Core 中不包含 AI 或视觉推理。
