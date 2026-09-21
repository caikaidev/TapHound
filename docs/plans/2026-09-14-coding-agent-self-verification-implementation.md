# 自验证工作流实施计划（Coding Agent Self-Verification）

> 设计来源：[Coding Agent 的 Android 自验证工作流](../coding-agent-self-verification-workflows.md)
> 基线提交：`94167aa`。本计划只描述实施步骤，不包含代码实现。

**目标**：让 Coding Agent 在 Android 变更后获得两个可信完成条件——Accept 得到
Acceptance Contract Verdict `pass`，Preserve 得到 Regression Comparator `equivalent: true`——
并消除当前实现中可能产生假成功、假失败和不可复现结论的路径。

**架构约束**：延续 ports and adapters。协议变化落在 `src/domain/`，用例落在 `src/application/`，
CLI 只做参数解析、单值 JSON 输出和退出码映射。设备工作继续走 Runtime Backend SPI。

---

## 全局约束（每个任务都适用）

- ESM + NodeNext，源码 import 带 `.js` 后缀；TypeScript strict、exactOptionalPropertyTypes、
  noUncheckedIndexedAccess；ESLint 需要显式返回类型。
- 协议 schema 用 `z.strictObject`；新增字段一律 optional 或带 default，避免破坏已发布资产。
- 每次协议变化必须同批更新：schema、推断类型、运行时行为、`docs/`、`examples/`、
  `test/fixtures/`、单测。
- 机器可读命令 stdout 恰好一个 JSON 值，诊断走 stderr，JSON `exitCode` 必须等于进程退出码。
- 不新增 Contract Verdict 枚举值，不新增 Replay run status，不新增 Core 退出码语义。
- 代码内不加解释性注释（仓库规则）。
- 每个任务完成后跑本地质量门：

  ```bash
  npm test
  npm run typecheck
  npm run lint
  npm run build
  ```

- 涉及设备行为的任务，额外记录真机验收命令与结果，不得用普通测试冒充设备验收：

  ```bash
  TAPHOUND_ACCEPTANCE_DEVICE=1 npm run acceptance:device
  TAPHOUND_ACCEPTANCE_DEVICE=1 npm run acceptance:generation
  ```

---

## 阶段与优先级

| 阶段 | 任务 | 设备成本 | 阻塞关系 |
|---|---|---|---|
| P0 | 任务 1：Baseline compare 基础一致性门禁 | 无（离线） | 无 |
| P0 | 任务 2：Baseline 证据能力声明与 Screen 事实可比较性 | 无（离线） | 任务 1 |
| P1 | 任务 3：Regression Comparator 事实语义修正 | 无（离线） | 任务 1 |
| P1 | 任务 4：Replay 策略持久化与可复现的验证身份 | 有 | 无 |
| P2 | 任务 5：Checkpoint 接入执行与报告 | 有 | 任务 3、4 |
| P2 | 任务 6：Checkpoint 进入 Contract 与 Baseline | 有 | 任务 5 |
| P3 | 任务 7：Logcat 解析可靠性加固 | 有 | 无 |
| P3 | 任务 8：`logcatEvent` expect 类型 | 有 | 任务 7 |
| P3 | 任务 9：Checkpoint `allOf` 与跨 step 观察窗口 | 有 | 任务 5、8 |
| P4 | 任务 10：Capture 与运行时 Binding | 有 | 任务 8 |
| P4 | 任务 11：请求失败归因（errorClass） | 有 | 任务 8 |
| P4 | 任务 12：`accept` / `preserve` Workflow Skill 与 manifest | 有 | 任务 1-4 |

P0 全部离线、可单测、直接消除假成功；P1 是让结论可信的最小集合；
P2 之后才引入新协议表面。任务 10-12 建议在 P0-P2 验收并在真实项目上跑通一轮后再启动。

---

## 任务 1：Baseline compare 基础一致性门禁（P0）

**问题**：`BaselineService.compare` 计算
`requested = input.journeySha256 ?? baseline.journeySha256` 后再与 `baseline.journeySha256` 比较
（`src/application/checkpoint/baseline-service.ts:60-79`），不传参时是恒真判断；
从不读取 `report.journey.sha256`、`report.status`、`report.project.packageName`。
`BaselineSchema` 的三个事实数组都没有 `min(1)`，空 Baseline 恒返回 `equivalent: true`。

**改动位置**

- `src/domain/checkpoint.ts`：
  - `RegressionCompareResultSchema` 新增 `coverage: { activities, elements, screens }`（数量）；
  - 新增 `RegressionGateFailure`（或复用 failure code）表达“不可比较”；
  - `BaselineSchema` 增加 superRefine：三类事实不得同时为空。
- `src/domain/failure.ts` + `src/domain/failure-classification.ts`：
  新增 `BASELINE_INCOMPARABLE`（退出码 2）与 `BASELINE_EMPTY`（退出码 2），补 `FAILURE_CODE_TYPES` 映射。
- `src/application/checkpoint/baseline-service.ts`：compare 前置门禁读报告本身，不读调用方参数。
- `src/application/checkpoint/baseline-capturer.ts`：capture 时事实集为空即失败关闭。
- `src/cli/commands/baseline.ts`：新增 `--contract-sha256`（compare 侧）与
  可选 `--verdict <path>`（从 `verdict.json` 取 Contract 身份）；门禁失败按 code 映射退出码 2。

**门禁清单（全部 fail-closed）**

1. `report.journey.sha256 === baseline.journeySha256`；
2. `report.project.packageName === baseline.packageName`；
3. `report.status === "passed"`；
4. 报告可被 `TapHoundReportV4Schema` 解析；
5. `baseline.contractSha256` 存在时，必须提供并匹配同一 Contract 身份
   （报告不含 Contract 身份，需 `--contract-sha256` 或 `--verdict`）；
6. Baseline 事实集非空。

**验收标准**

- 报告与 Baseline 的 Journey 哈希不同 → 退出码 2、`BASELINE_INCOMPARABLE`，不输出 `equivalent`。
- `failed` 报告进 compare → 退出码 2，不输出 `equivalent: true`。
- 空事实 Baseline 无法被 capture 产出；历史空 Baseline 进 compare → 退出码 2。
- 通过门禁的等价比较仍返回 `equivalent: true` 且带非零 `coverage`。

**测试**

- `test/application/checkpoint/baseline-service.test.ts`：六条门禁各一条失败用例 + 一条全通过用例。
- `test/domain/checkpoint.test.ts`：空 Baseline 被 schema 拒绝、`coverage` 字段解析。
- `test/cli/baseline.test.ts`：CLI 单值 JSON、退出码与 `failure.code` 一致。
- `docs/checkpoint-regression.md` 同步门禁与 `coverage` 说明。

---

## 任务 2：Baseline 证据能力声明与 Screen 事实可比较性（P0）

**问题**：`report.screens` 只由 Contract hook 产生
（`src/application/runtime/verify-runtime.ts:875-884`），`verify --journey` 报告恒为空。
因此“从 `verify --contract` 报告 capture、用 `verify --journey` 报告 compare”必然产生假 `CHANGED`。

**改动位置**

- `src/domain/checkpoint.ts`：`BaselineSchema` 新增
  `requiredEvidence: { screens: boolean }`（可扩展 anchor / uiBackend），默认由 capture 推导。
- `src/application/checkpoint/baseline-capturer.ts`：
  - 采集到 Screen 事实时置 `requiredEvidence.screens = true`；
  - 支持显式排除 Screen 事实的入参。
- `src/application/checkpoint/baseline-service.ts`：
  `requiredEvidence.screens === true` 且当前报告无 Screen 证据 → `BASELINE_INCOMPARABLE`，
  不产生 `screen: missing` 的 RegressionDiff。
- `src/cli/commands/baseline.ts`：`capture` 新增 `--no-screen-facts`。

**验收标准**

- Contract 报告 capture + 普通 verify 报告 compare → 退出码 2（不可比较），而不是 `equivalent: false`。
- `--no-screen-facts` 产出的 Baseline 可与普通 verify 报告正常比较。
- 两侧都是 Contract 报告时行为不变。

**测试**：`test/application/checkpoint/baseline-service.test.ts` 增能力不匹配用例；
`docs/checkpoint-regression.md` 把现有 caveat 从“说明”升级为“门禁”。

---

## 任务 3：Regression Comparator 事实语义修正（P1）

**问题**（`src/application/checkpoint/regression-comparator.ts`、`baseline-capturer.ts`）

- Screen 事实只比 id，不比 `status`（comparator `140-149`）；且 `report.screens[].status` 是
  `z.literal("matched")`（`src/domain/report.ts:169-172`），Baseline 的 `ambiguous` / `unresolved` 写不进去；
- `matchedBy` 与 `evidenceSha256` 采集但不比较，resourceId 命中降级为 annotated fallback 仍算等价；
- `locatorToKey`（capturer `77-94`）在缺 `requested` 时生成 `{resourceId: "resourceId"}`
  之类占位键，不同元素会折叠；
- `evidenceSha256 = sha256(locator.message)` 是对人类可读消息取哈希，不是稳定证据
  （`src/application/checkpoint/baseline-capturer.ts:69`）；
- `absent` 事实在 passed 报告中几乎不会产生。

**改动位置与决策**

1. `src/domain/report.ts`：`screens[].status` 扩为 `matched | ambiguous | unresolved`（保持 optional 数组）。
2. `src/application/checkpoint/regression-comparator.ts`：
   - Screen 事实比较 `status`；
   - element 事实比较 `matchedBy`，降级视为 `RegressionDiff`（kind 仍为 `element`，`expected/actual` 说明命中方式）；
   - 无法生成稳定 key 的 locator 不再折叠：要么跳过并计入 `coverage.skipped`，要么以 `unresolved` 事实表达。
3. `src/application/checkpoint/baseline-capturer.ts`：删除 `evidenceSha256` 的消息哈希，
   或改绑元素语义证据（与 `LocatorSchema.evidence` 一致）。
4. `absent` 能力：本任务不实现，在 `docs/checkpoint-regression.md` 显式声明
   “passed 报告不产生 absent 事实”，由任务 6 的 Checkpoint `absentElements` 提供。

**验收标准**：Screen 由 matched 变 ambiguous、locator 由 resourceId 命中变 fallback，
两种情况都产出 RegressionDiff；占位键不再把不同元素判为同一事实；
既有等价用例（无这些漂移）结果不变。

**测试**：`test/application/checkpoint/regression-comparator.test.ts` 每种漂移一条用例 +
一条“无漂移仍等价”回归用例；更新 `test/fixtures` 中受影响的报告样例。

---

## 任务 4：Replay 策略持久化与可复现的验证身份（P1）

**问题**：finalize 传 `requireFocusedInput: true` / `generatedReplayPolicy: true`
（`src/application/generation/generation-finalizer.ts:399-400`）并使用 `session.idlePolicy`
（同文件 `384-386`），但这些都不随 Journey 发布；CLI `verify` / `verify --contract` / `verify --diff`
只传 `manualReplay`（`src/cli/commands/verify.ts:149,233`、`src/cli/diff-verification.ts:316`、
`src/application/contract/contract-verifier.ts:267`）。所以“独立重放”当前更宽松，
不能作为 Accept 的完成证据。`meta.bindings` 也缺 `knowledgeHash`。

**改动位置**

- `src/domain/generation.ts`：`GenerationMetaSchema`（`482-526`）新增
  `replayPolicy: { generatedReplayPolicy: boolean, requireFocusedInput: boolean, idle: IdlePolicy }`
  与 `bindings.knowledgeHash`（optional，向后兼容）。
- `src/application/generation/generation-publisher.ts`：把上述字段写入 `meta.json` 与 manifest 哈希。
- `src/application/generation/generation-finalizer.ts`：构造 meta 时填入实际使用的策略。
- `src/application/runtime/verify-runtime.ts`：`VerifyInput` 已支持这两个 flag，无需改签名。
- `src/cli/commands/verify.ts`：新增 `--policy-from-meta`（或默认读取同名 `.meta.json`），
  把 meta 的策略与 idle 应用到 `VerifyInput`；`verify --contract` 同样处理。
- `src/application/contract/contract-verifier.ts`：允许透传 replay 策略。
- `src/domain/failure.ts`：新增 `REPLAY_POLICY_UNAVAILABLE`（退出码 2）用于
  “要求复现策略但 meta 缺失或不一致”。

**兼容性**：旧 meta 无 `replayPolicy` 时，`--policy-from-meta` 失败关闭
（`REPLAY_POLICY_UNAVAILABLE`）；不带该选项时保持今天的宽松行为，默认行为不变。

**验收标准**

- `generation finalize` 产出的 `<name>.meta.json` 含 `replayPolicy` 与 `bindings.knowledgeHash`。
- `verify --journey <j> --policy-from-meta` 使用与 finalize 相同的严格度（可通过
  “生成期能通过、宽松策略下也能通过、但前台不匹配时严格策略先失败”的用例区分）。
- 旧 Journey 无 meta → 退出码 2 且 code 明确。
- `verify --contract --policy-from-meta` 的 Verdict 计算路径不变，只是 replay 更严格。

**测试**：`test/application/generation/generation-publisher.test.ts`（meta 字段）、
`test/cli/verify.test.ts`（选项、失败关闭、单值 JSON）、
`test/application/runtime/verify-runtime.test.ts`（策略透传）。
真机：`acceptance:generation` 后用 `--policy-from-meta` 重放同一 Journey 并记录两份报告。

---

## 任务 5：Checkpoint 接入执行与报告（P2）

**问题**：`CheckpointDefinitionSchema` 只存在于 `src/domain/checkpoint.ts`，无任何消费者；
Journey 无法引用 Checkpoint，report 也没有 Checkpoint 结果。

**协议决策（先定，再实现）**

1. `stepIndex` 语义：显式 `stepIndex = n` 表示第 n 步**执行后**求值；缺省表示 Journey 结束后求值。
   在 schema 注释与 `docs/checkpoint-regression.md` 中固化。
2. Journey 侧引用方式：`Journey` 顶层新增
   `checkpoints?: CheckpointDefinition[]`（内联，随 Journey 哈希绑定），
   不引入外部文件引用，避免第二个 Source of Truth。
3. Report 侧：`report.checkpoints?: Array<{ id, stepIndex?, status, conditions: [...] }>`，
   `schemaVersion` 保持 `4`（纯新增 optional 字段），在 `docs/report-schema.md` 说明。
4. 失败语义：新增 `CHECKPOINT_FAILED`（退出码 1）与 `CHECKPOINT_UNRESOLVED`（退出码 1），
   补 `FAILURE_CODE_TYPES`（`checkpoint_failed` 类型或复用 `expect_failed`）与
   `FAILURE_TYPE_STAGES`；taxonomy 测试要求全 code 覆盖。
5. Knowledge 依赖：Checkpoint 的 `screen` 条件在无 Knowledge resolver 时失败关闭，
   语义与 `CONTRACT_KNOWLEDGE_UNAVAILABLE` 对齐。

**改动位置**

- `src/domain/checkpoint.ts`、`src/domain/journey.ts`、`src/domain/report.ts`、
  `src/domain/failure.ts`、`src/domain/failure-classification.ts`；
- `src/application/runtime/step-runner.ts`（步后调度）与
  `src/application/runtime/verify-runtime.ts`（结束后调度、结果汇总、首个失败终止策略）；
- Checkpoint 求值复用现有 `resolveLocator`、anchor resolver 与 `ScreenDetector`，
  不新增视觉判定；`screen` 匹配结果同时写入 `report.screens`（修掉 §3.6 的 Screen 来源问题）。

**验收标准**

- 三种调度点（步后、结束后、无 Checkpoint）行为明确；
- Checkpoint 失败使 run `failed`、`primaryFailure.code = CHECKPOINT_FAILED`，并停在首个失败；
- 证据不可获得（如 layout 抓取失败）→ `unresolved` 且失败关闭，不静默通过；
- `report.screens` 在普通 `verify --journey` 下也能由 Checkpoint 产生。

**测试**：`test/domain/checkpoint.test.ts`、`test/domain/report.test.ts`、
`test/application/runtime/step-runner.test.ts`、`test/application/runtime/verify-runtime.test.ts`、
`test/domain/failure-classification.test.ts`（全 code 覆盖）、fixtures 中新增带 Checkpoint 的 Journey 与报告。

---

## 任务 6：Checkpoint 进入 Contract 与 Baseline（P2）

**改动位置**

- `src/domain/contract.ts`：新增 `requiredCheckpoints: KnowledgeId[]`（default `[]`）与
  `ContractVerdictReason` 新值 `CHECKPOINT_FAILED`；
  `ContractVerdictViewSchema` 新增 `checkpoints` 结果数组。
- `src/application/contract/contract-verifier.ts`：从报告读取 Checkpoint 结果参与 Verdict；
  必需 Checkpoint 缺失结果 → `inconclusive`（不是 `pass`）。
- `src/application/checkpoint/baseline-capturer.ts`：从通过的 Checkpoint 提取事实，
  包括 `absentElements`（补上任务 3 声明缺失的能力）。
- `src/application/checkpoint/regression-comparator.ts`：比较 Checkpoint 事实。

**验收标准**：必需 Checkpoint 失败 → Verdict `fail` 且 reason `CHECKPOINT_FAILED`；
必需 Checkpoint 未执行 → `inconclusive`；Baseline 能冻结 absent 事实并在回归时报出。

**测试**：`test/application/contract/contract-verifier.test.ts`、
`test/application/checkpoint/*`、`docs/contract-schema.md` 与
`docs/checkpoint-regression.md` 同步。

---

## 任务 7：Logcat 解析可靠性加固（P3）

**问题**（`src/application/collector/logcat-collector.ts`）

- `receivedAt` 用宿主 `clock.now()`，不解析设备时间戳（`93`）；
- `lines()` 放过所有 `pid === undefined` 的行，解析失败即绕过 PID 作用域（`130-138`）；
- THREADTIME 正则 tag 用 `[^:]+`，带冒号的 tag 解析失败（`33`）；
- `collected` 无界增长。

**改动位置**

- 解析：补设备时间戳字段（`deviceTimestamp`），tag 解析支持冒号；
- 作用域：新增严格模式——解析失败的行不进入 `lines()` 的匹配集合，但仍保留在 artifact 中；
- 缓冲：加行数/字节上限与丢弃计数，丢弃发生时在报告中标注证据不完整。

**验收标准**：带冒号 tag 可匹配；未解析行不再绕过 PID 作用域；
超过上限时报告标注丢弃计数，不静默丢证据；现有 `logcat` expect 用例全部不变。

**测试**：`test/application/collector/logcat-collector.test.ts`
（解析、作用域、上限、丢弃计数）。

---

## 任务 8：`logcatEvent` expect 类型（P3）

**决策**：新增 `type: "logcatEvent"`，**不改** 现有 `logcat` 语义。
现有匹配是 `find()` 首条命中（`src/application/assertion/expectation-evaluator.ts`），
给旧类型加唯一性属于破坏性变更。

**改动位置**

- `src/domain/journey.ts`：`ExpectSchema` 新增 `LogcatEventExpectSchema`
  （`tag`、`event`、`fields`、`correlation: { key, value }`、`unique: true`、
  `window: { from: "stepStart" | "runStart" | "marker", markerId? }`、`timeoutMs`）；
- `src/domain/report.ts`：`StepExpectationSchema.type` 增 `logcatEvent`，
  记录匹配行摘要（脱敏）与匹配数量；
- `src/application/assertion/expectation-evaluator.ts`：新增求值分支，
  多条命中 → 失败关闭（新增 `EXPECT_LOGCAT_AMBIGUOUS`，退出码 1）；
- 生成侧：`generation` 的 proposal 校验与 `RecorderService` 是否暴露该类型由本任务决定，
  建议第一版只支持手写 Journey 与 Brief 驱动，不进 recorder 提示流程。

**验收标准**：唯一命中通过；重复命中失败关闭；correlation 不匹配不通过；
超时消息区分“未出现”与“出现但不唯一”；旧 `logcat` 用例零变化。

**测试**：`test/domain/journey.test.ts`、
`test/application/assertion/expectation-evaluator.test.ts`、
`docs/journey-schema.md` 与 `docs/report-schema.md` 同步。

---

## 任务 9：Checkpoint `allOf` 与跨 step 观察窗口（P3）

**改动位置**

- `src/domain/checkpoint.ts`：`CheckpointExpectSchema` 增 `allOf`
  （UI / Activity / Screen / logcatEvent 条件数组）与共享 `timeoutMs` 总预算；
- `src/application/runtime`：并行观察各条件，记录每条的开始时间、命中时间与证据引用；
  总超时到达即报告未满足条件，不延长等待；
- 跨 step 窗口：`marker` 由 Journey 显式声明（如 `wait` 步上的 `markerId`），
  求值窗口从 marker 开始而不是隐式的 step 开始。

**验收标准**：UI 与日志条件在同一总超时内求值；
部分满足时报告逐条状态；跨 step 事件可命中且窗口来源可追溯。

**测试**：`test/domain/checkpoint.test.ts`、`test/application/runtime/*`；
`docs/checkpoint-regression.md` 增 `allOf` 章节。

---

## 任务 10：Capture 与运行时 Binding（P4）

**范围限制**：只支持从已匹配的 `logcatEvent` 中提取命名值，
值类型限于短字符串、整数与受长度限制的安全标识符；不支持表达式、脚本或从日志派生新 action。

**改动位置**

- `src/domain/journey.ts`：`logcatEvent` 增 `capture: { name, field | group }`；
  后续 step 的白名单字段（`inputText.text`、`locator.text`、`logcatEvent.correlation.value`）
  支持 `${name}` 引用，其他位置一律拒绝；
- `src/domain/report.ts`：记录来源 step、窗口、脱敏摘要与证据哈希，
  **不记录原始敏感值**；
- `src/application/runtime/step-runner.ts`：binding 只在本次 Replay 内有效，不写回 Journey；
- 独立 verify 与 finalize 都必须重新提取，不得复用生成期值。

**验收标准**：捕获值可用于后续白名单字段；非白名单位置引用 → schema 拒绝；
超长或类型不符 → 失败关闭；报告中无原始敏感值；两次运行各自重新提取。

**测试**：`test/domain/journey.test.ts`（白名单与类型校验）、
`test/application/runtime/step-runner.test.ts`（端到端 binding）、
`docs/journey-schema.md` 增 Capture/Binding 章节与安全约束。

---

## 任务 11：请求失败归因（errorClass）（P4）

**改动位置**

- `src/domain/failure-classification.ts`：新增
  `requestOutcome?: { errorClass: "client" | "auth" | "network" | "server" | "unknown", evidenceRefs }`；
- `src/application/diagnosis/failure-classifier.ts`：只接受 App 输出的稳定 `errorClass` 字段，
  缺失或冲突时保持 `unknown`；不做文案猜测；
- `docs/failure-classification.md` 同步。

**验收标准**：结构化 `errorClass` 能进入分类结果；无 `errorClass` 时为 `unknown`；
分类结果不含敏感字段。

---

## 任务 12：`accept` / `preserve` Workflow Skill 与 manifest（P4）

**改动位置**

- `assets/skills/taphound-accept/SKILL.md`、`assets/skills/taphound-preserve/SKILL.md`
  （`taphound init` 按目录扫描安装，新增目录即可）。
- 不新增 Core CLI 协议；两个 skill 只调用现有公开命令。

**manifest 规范**

- 落点：`.taphound/build/workflows/<caseId>/manifest.json`
  （`.taphound/` 下只有 `build/` 是 ephemeral，路径必须从 `src/domain/workspace.ts` 派生）；
- 字段：Case 与路径声明（Accept / Preserve）、需求来源摘要、实现 diff、验证资产 diff、
  `journeySha256`、`contractSha256`、`knowledgeHash`、replayPolicy 摘要、
  `verify --diff` 使用的 scope、每条命令的退出码与 JSON 结果路径、
  report / verdict / baseline 路径、最终状态（含 Workflow 级 `PAUSED`）。

**职责边界**

- `taphound-journey-generator` 负责到 `generation finalize`；
- `accept` 负责 Contract、独立重放（`--policy-from-meta`）、`journey promote`、可选 `baseline capture`；
- `preserve` 负责变更前 verify/capture 与变更后 verify/compare；
- 两个 skill 不直接读写 `.taphound/build/generations`。

**验收标准**：一个混合变更（新增行为 + 重构）能拆成 Accept 与 Preserve 两个 Case，
分别得到 Verdict `pass` 与 `equivalent: true`，manifest 可复原全部结论来源。

---

## 不在本计划范围内

- 性能、视觉像素比较、多机型矩阵、网络副作用构造与数据库副作用（见设计文档 §7）。
- 通用断言 DSL、并行调度、测试夹具体系。
- 由 Core 直接调用模型：语义评审仍只能通过 `contract review` 合入，且不得改写确定性 `fail` / `invalid`。

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| 任务 1/2 的门禁使既有 Baseline 失效 | 门禁失败给出明确 code 与重建指引；不自动迁移，不静默放行 |
| 任务 4 改变 verify 默认行为 | `--policy-from-meta` 为显式开关，默认行为不变 |
| 任务 5 的 report 字段扩张 | 只加 optional 字段，`schemaVersion` 保持 4，旧报告仍可解析 |
| 任务 8 新 expect 类型与 recorder 脱节 | 第一版限手写 / Brief 驱动，recorder 支持另行评估 |
| 任务 10 的 binding 扩大攻击面 | 白名单字段 + 类型长度校验 + 报告脱敏，且不写回 Journey |
| 设备时间成本上升 | Accept 默认两次重放（finalize + contract verify），只有 promote 场景强制严格重放 |
