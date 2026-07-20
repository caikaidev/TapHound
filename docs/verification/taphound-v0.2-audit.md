# TapHound v0.2 完成审计

- 审计日期：2026-07-19
- 依据：[原始批准设计](../archive/%61pr-v0.2/2026-07-19-%61pr-v0.2-design.md) 与[原始实施计划](../archive/%61pr-v0.2/2026-07-19-%61pr-v0.2-implementation.md)
- 品牌说明：APR 是 TapHound 在未发布阶段使用的内部代号。
- 审计结论：九项 v0.2 完成标准均有实现和自动化证据；本机没有在线 Android 设备，因此真实设备端到端验收未运行，未将其声称为已通过。

## 完成标准证据

| # | 已批准完成标准 | 实现证据 | 验证证据 | 结论 |
|---|---|---|---|---|
| 1 | TapHound 交互式 Recorder 生成包含 Action、Locator 和 Activity Checkpoint 的 Journey | [`recorder-service.ts`](../../src/application/recorder/recorder-service.ts)、[`locator-selector.ts`](../../src/application/recorder/locator-selector.ts)、[`inquirer-recorder-prompt.ts`](../../src/adapters/prompt/inquirer-recorder-prompt.ts) | [`recorder-service.test.ts`](../../test/application/recorder/recorder-service.test.ts) 覆盖构建/启动、操作执行、前后 Activity、重复 Android CLI key 下选择正确目标、只保存成功步骤、Finish 原子写入、Cancel；[`locator-selector.test.ts`](../../test/application/recorder/locator-selector.test.ts) 覆盖 Locator 唯一性和优先级 | 已证明 |
| 2 | 显式补充并校验 Activity、Element、Logcat 断言 | [`journey.ts`](../../src/domain/journey.ts) 定义三种显式 Expect；[`expectation-evaluator.ts`](../../src/application/assertion/expectation-evaluator.ts) 执行确定性判定 | [`journey.test.ts`](../../test/domain/journey.test.ts) 覆盖三种 Schema 和非法正则；[`expectation-evaluator.test.ts`](../../test/application/assertion/expectation-evaluator.test.ts) 覆盖成功、超时、取消与 Logcat 窗口 | 已证明 |
| 3 | 自动执行 Gradle Build 与 Android CLI Run | [`verify-runtime.ts`](../../src/application/runtime/verify-runtime.ts)、[`gradle-adapter.ts`](../../src/adapters/gradle/gradle-adapter.ts)、[`android-cli-adapter.ts`](../../src/adapters/android-cli/android-cli-adapter.ts) | [`verify-runtime.test.ts`](../../test/application/runtime/verify-runtime.test.ts) 验证完整阶段顺序、元数据 Package 冲突和失败边界；[`gradle-adapter.test.ts`](../../test/adapters/gradle/gradle-adapter.test.ts) 与 [`android-cli-adapter.test.ts`](../../test/adapters/android-cli/android-cli-adapter.test.ts) 验证参数数组、APK、Activity 和设备序列号 | 已证明 |
| 4 | 通过 ADB 确定性执行全部首期 Action | [`action-executor.ts`](../../src/application/interaction/action-executor.ts)、[`adb-adapter.ts`](../../src/adapters/adb/adb-adapter.ts) 实现 click、longClick、inputText、swipe、back；wait 不发送 ADB 操作 | [`action-executor.test.ts`](../../test/application/interaction/action-executor.test.ts) 覆盖全部 Action；[`adb-adapter.test.ts`](../../test/adapters/adb/adb-adapter.test.ts) 验证 tap/swipe/keyevent/text 的精确参数和设备范围 | 已证明 |
| 5 | 基于 Layout Diff 稳定等待，不使用固定 sleep | [`idle-waiter.ts`](../../src/application/wait/idle-waiter.ts) 使用注入 Clock，连续空 Diff 才稳定并保留最后 Diff | [`idle-waiter.test.ts`](../../test/application/wait/idle-waiter.test.ts) 使用 Fake Clock 覆盖稳定、重置、超时、取消及设备传递，无真实等待 | 已证明 |
| 6 | 按步骤切片并匹配 Logcat | [`logcat-collector.ts`](../../src/application/collector/logcat-collector.ts) 等待流式进程启动稳定、记录单调接收时间并切片；[`step-runner.ts`](../../src/application/runtime/step-runner.ts) 写步骤日志；Expect evaluator 匹配 tag/level/pattern | [`logcat-collector.test.ts`](../../test/application/collector/logcat-collector.test.ts) 覆盖异步启动失败、含边界的 `[T0,T1]` 切片和 PID 范围；[`verify-runtime.test.ts`](../../test/application/runtime/verify-runtime.test.ts) 证明启动阶段退出在 Run 前成为主失败；StepRunner 与 Expect 测试覆盖步骤级消费 | 已证明 |
| 7 | 输出 Screenshot、原始日志、步骤日志与分层报告 | [`verify-runtime.ts`](../../src/application/runtime/verify-runtime.ts)、[`report-writer.ts`](../../src/application/report/report-writer.ts)、[`artifact-store.ts`](../../src/adapters/filesystem/artifact-store.ts) | [`verify-runtime.test.ts`](../../test/application/runtime/verify-runtime.test.ts) 覆盖最终采集、主/次失败和有意 SIGTERM 停止 Logcat；[`report-writer.test.ts`](../../test/application/report/report-writer.test.ts)、[`artifact-store.test.ts`](../../test/adapters/filesystem/artifact-store.test.ts) 覆盖报告树与原子发布；[`report.test.ts`](../../test/domain/report.test.ts) 校验分层 Schema 与 fallback 证据 | 已证明 |
| 8 | `taphound verify --json` 可被任意外部 Agent CLI 稳定调用 | [`verify.ts`](../../src/cli/commands/verify.ts) 与 [`output.ts`](../../src/cli/output.ts) 提供机器输出和固定退出码；[`agent-integration.md`](../agent-integration.md) 记录调用契约 | [`verify-json.test.ts`](../../test/cli/verify-json.test.ts) 验证依赖注入后的 JSON 契约；[`verify-process.test.ts`](../../test/cli/verify-process.test.ts) 启动构建后的真实 OS 子进程，验证退出码 0–4、stdout 单个 JSON 值、stderr 隔离及实际报告发布；[`commands.test.ts`](../../test/cli/commands.test.ts) 覆盖覆盖参数与映射 | 已证明 |
| 9 | 执行与判定不依赖 AI | Domain、Runtime、Adapters 均为显式状态机、Schema、Locator、ADB、Layout Diff 与字符串/正则判定；[`package.json`](../../package.json) 仅含 Commander、Inquirer 与 Zod 运行依赖 | `rg -ni "openai|anthropic|claude|\\bllm\\b|model inference|vision" src package.json package-lock.json` 无命中；Journey Schema 拒绝官方/自然语言格式的测试位于 [`journey.test.ts`](../../test/domain/journey.test.ts) | 已证明 |

## 关键约束审计

| 约束 | 证据 | 结论 |
|---|---|---|
| TapHound Journey 完全自研，不调用或兼容官方 Journey | 严格 [`JourneySchema`](../../src/domain/journey.ts) 及其拒绝额外/自然语言格式测试；文档在 [`journey-schema.md`](../journey-schema.md) 明确区分 | 已证明 |
| `run.packageName` 必填且 Activity 规范化不猜测 Package | [`config.ts`](../../src/domain/config.ts)、[`activity.ts`](../../src/domain/activity.ts) 与对应 [`config.test.ts`](../../test/domain/config.test.ts)、[`activity.test.ts`](../../test/domain/activity.test.ts) | 已证明 |
| 配置 Package 与 Android 项目元数据冲突时在 Run 前失败 | [`describe-parser.ts`](../../src/adapters/android-cli/describe-parser.ts) 按 target/variant 提取唯一 `applicationId`；[`verify-runtime.ts`](../../src/application/runtime/verify-runtime.ts) 在启动前比较；对应 Parser 与 Runtime 测试覆盖一致、缺失和冲突 | 已证明；审查修复 |
| Layout 解析与已安装 Android CLI 1.0 序列化协议一致 | [`layout-output.json`](../../test/fixtures/android-cli/layout-output.json) 保存扁平数组、重复 `key`、`interactions`、`center`、可选 `bounds`、`state` 和 off-screen 真实形态；Parser 使用 `key:path` 唯一内部 ID，测试覆盖真实协议、重复 key Recorder 选择和旧格式 | 已证明；审查修复 |
| click/longClick 仅在 Journey 显式记录 `annotatedLabel` 时回退 | [`journey.ts`](../../src/domain/journey.ts)、[`fallback-resolver.ts`](../../src/application/interaction/fallback-resolver.ts) 与 [`fallback-resolver.test.ts`](../../test/application/interaction/fallback-resolver.test.ts) | 已证明 |
| 每个步骤执行前后都验证 Activity，失败立即中止 | [`step-runner.ts`](../../src/application/runtime/step-runner.ts)、[`step-runner.test.ts`](../../test/application/runtime/step-runner.test.ts)、[`verify-runtime.test.ts`](../../test/application/runtime/verify-runtime.test.ts) | 已证明 |
| 所有设备相关 Android CLI 命令使用同一个显式 device serial | [`android-cli.ts`](../../src/ports/android-cli.ts)、Adapter、Recorder、Idle、Expect 与 Runtime 的契约测试 | 已证明；审计修复 |
| doctor 使用真实能力探测，不调用不存在的 `android doctor` | [`doctor-service.ts`](../../src/application/doctor/doctor-service.ts) 先选设备，再通过指定设备截图探测权限；[`doctor-service.test.ts`](../../test/application/doctor/doctor-service.test.ts) 覆盖无设备 `notRun` 和探测失败 | 已证明；审计修复 |
| 外部命令不经本地 Shell、支持有界超时与取消 | [`node-process-runner.ts`](../../src/adapters/process/node-process-runner.ts) 直接 `spawn` executable/args，为非流式命令提供有限默认超时，并暴露流式启动稳定结果；CLI 将 SIGINT/SIGTERM 转换为 AbortSignal；Layout/ADB 轮询传递剩余期限 | Process runner、Logcat、Idle、Expect、Runtime 与 CLI 测试覆盖参数保真、默认/显式超时、流式启动早退、AbortSignal 和信号传播 | 已证明；审查修复 |
| ADB 文本输入按远端 Shell 单引号规则转义 | [`adb-adapter.ts`](../../src/adapters/adb/adb-adapter.ts) 对空格、元字符、单引号和 `%s` 分段处理；Adapter 测试覆盖恶意 Shell 字符和 Unicode 参数 | 已证明；审查修复 |
| 原始失败不被辅助采集错误覆盖 | [`verify-runtime.ts`](../../src/application/runtime/verify-runtime.ts) 区分 primary failure 与 secondary errors；Runtime 测试覆盖截图/Logcat 最佳努力及 SIGTERM 正常停止 | 已证明；审计修复 |
| Journey 与报告原子发布 | [`journey-writer.ts`](../../src/adapters/filesystem/journey-writer.ts)、Artifact store 及各自测试 | 已证明 |
| 本期不实现 Skill/SubAgent 集成 | 仅提供 [`agent-integration.md`](../agent-integration.md) 所述稳定 CLI 契约，源码无 Skill/SubAgent 运行入口 | 符合范围 |

## 本地质量门禁

在隔离工作树、Node.js 24.3.0 上执行：

| 命令 | 结果 |
|---|---|
| `npm ci` | 通过；按 `package-lock.json` 安装 206 个 package |
| `npm test` | 通过；35 个测试文件、211 个测试 |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm run build` | 通过；生成 `dist/cli/main.js` |
| `node dist/cli/main.js --help` | 通过；列出 `doctor`、`record`、`verify` |

示例工程包含可执行的 Gradle 8.9 Wrapper。Fixture 合约测试同时验证 Wrapper JAR SHA-256 为 `498495120a03b9a6ab5d155f5de3c8f0d986a449153702fb80fc80e134484f17`，distribution SHA-256 为 `d725d707bfabd4dfdc958c624003b3c80accc03f7037b5122c4b1d0ef15cecab`。

## 环境与真实设备验收

执行：

```text
node dist/cli/main.js doctor --project examples/taphound-android-demo --json
```

实际结果：

```json
{"status":"failed","checks":[{"name":"node","status":"passed","version":"24.3.0"},{"name":"adb","status":"passed","version":"Android Debug Bridge version 1.0.41"},{"name":"android","status":"passed","version":"1.0.15857036"},{"name":"gradle","status":"passed"},{"name":"permissions","status":"notRun","message":"Permission probe requires an online selected device"},{"name":"device","status":"failed","message":"Expected exactly one online device, found 0"}],"failureCode":"DEVICE_UNAVAILABLE"}
```

因此：

- Node、ADB、Android CLI 和示例 Gradle Wrapper 探测通过。
- 在线设备数量为 0；设备权限探测按契约标为 `notRun`。
- 未设置 `TAPHOUND_ACCEPTANCE_DEVICE=1`，也未运行 `npm run acceptance:device`；没有真实设备报告路径可附。
- [`fixture-contract.test.ts`](../../test/acceptance/fixture-contract.test.ts) 已证明示例 Package、Activity、Locator、Logcat、Wrapper 与验收脚本静态一致，但它不替代真实设备端到端结果。

真实设备验收是设计 12.5 中“Android CLI 与设备可用时”才执行的环境门禁。本次缺失的唯一外部前置条件是一个在线 Emulator 或 USB Device。代码、fixture 与显式 opt-in runner 已就绪，审计不把该外部结果误报为通过。
