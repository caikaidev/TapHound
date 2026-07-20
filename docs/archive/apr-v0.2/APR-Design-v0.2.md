# Android Project Runtime (APR)

Version: v0.2

Status: Draft

Target Platform:

- macOS
- Android CLI
- Android Studio (Latest Stable)

---

# 1. Background

AI 已经能够完成大量 Android 代码编写工作。

但代码修改完成后，仍然需要开发者手动完成大量重复操作：

- Build
- Run
- 打开指定页面
- 输入测试数据
- 查看结果
- 查看日志

这些步骤每天都会重复很多次。

APR 的目标不是替代 Android CLI。

而是在 Android CLI 之上，为 Android 项目提供一个可重复执行的 Runtime。

---

# 2. Goal

第一阶段只解决一个问题：

> AI 修改代码以后，可以自动完成一次真实的功能验证。

例如：

```
修改代码

↓

Run App

↓

进入搜索页面

↓

输入 hello world

↓

截图

↓

导出日志

↓

结束
```

第一阶段不引入 AI 推理。

只保证流程稳定执行。

## 2.1 核心定位与价值主张

APR 是**完全自研、不依赖 AI 参与执行**的确定性验证工具。

核心场景：开发者 / AI 完成一次需求代码修改后，需要对这次修改做一次**可重复、可信赖**的回归验证。

验证依据两类信号，二者结合使用：

1. **精确的操作触发结果** —— 点击是否命中目标、页面是否按预期跳转
2. **业务日志是否符合预期** —— 关键路径的日志是否在预期时间窗口内按预期内容出现

二者结合，是为了排除"流程跑完了，但其实没跑对"这类假阳性。

### 2.1.1 与 Android CLI 官方 Journey 的关系

Android CLI 自身已经提供了 Journey 能力（[Android CLI support for Journeys](https://developer.android.com/tools/agents/android-cli/journeys)），但两者设计哲学完全不同，必须在这里说清楚，避免"重复造轮子"的误解：

| | 官方 Journey | APR Journey |
|---|---|---|
| 定位方式 | AI 视觉 + 推理，实时判断 | resourceId / text / contentDescription，固定匹配 |
| 每次执行 | 都需要 AI 参与推理 | 纯确定性回放，不调用模型 |
| 成本 | 每次运行消耗模型 token | 录制一次，之后近乎零成本重放 |
| 稳定性 | 依赖模型判断，存在漂移风险 | 固定路径，结果可复现、可对比 |
| 断言方式 | 自然语言描述，由 AI 判断是否满足 | 预先录制的结构化断言（跳转目标 / 日志匹配），确定性判断 |
| 适用场景 | 探索性验证、复杂语义判断 | 高频回归验证、CI、需要稳定基线的场景 |

**APR 的核心卖点是确定性、可重复、不消耗 AI token，适合作为"AI 每次改完代码后都要跑一遍"的高频自我回归验证手段**，而不是替代官方 Journey 的探索式验证能力。两者可以并存：官方 Journey 适合"探索这个功能对不对"，APR 适合"确认这次改动没有破坏已知路径"。

---

# 3. Scope

## Included

- Android CLI 集成
- Journey Replay
- Journey Recorder
- Screenshot
- Logcat
- Verification Report
- 断言机制（跳转 / 日志）
- 基于 Layout Diff 的等待策略

## Excluded

- AI 自动探索
- OCR
- Vision（除官方 `screen resolve` 兜底定位外）
- DFS
- Android Studio Plugin
- Windows
- Linux
- CI
- 多设备并发
- 自动修复 Journey
- 自动生成断言内容（断言仍需人工/AI 在录制阶段显式指定）

---

# 4. Development Constraints

## Platform

仅支持：

- macOS

其它平台后续支持。

macOS 首次运行涉及 USB 调试授权、屏幕录制权限等系统弹窗，这类权限问题会中断自动化流程，属于已知限制，需要在环境准备阶段提示开发者提前完成授权。

---

## Android CLI 依赖边界

APR 依赖官方 Android CLI（[developer.android.com/tools/agents/android-cli](https://developer.android.com/tools/agents/android-cli)），但需要明确：**Android CLI 并不提供完整的交互执行能力**，APR 对它的依赖分为两部分：

### 4.1 由 Android CLI 提供

| 能力 | 对应命令 | 用途 |
|---|---|---|
| 部署已构建的 APK | `android run --apks=<path>` | Run 阶段安装并启动 App。**注意：该命令不执行任何构建步骤**，APK 必须提前由 Gradle 构建好 |
| 获取产物路径 | `android describe` | 定位 Build 输出的 APK 路径，供 `run` 使用 |
| 获取 UI Layout | `android layout [--diff]` | Locator 匹配的数据来源；`--diff` 可用于判断界面是否稳定（见 10.1） |
| 截图 | `android screen capture [--annotate]` | Collector 采集截图；`--annotate` 附带元素标注框 |
| 坐标兜底定位 | `android screen resolve` | 将标注截图上的标签转换为屏幕坐标，作为 Locator 失败时的兜底方案（见 8.3） |
| 设备管理 | `android emulator create/list/start/stop` | Emulator 生命周期管理 |

### 4.2 不由 Android CLI 提供，需 APR 自行通过 ADB 实现

Android CLI **没有**提供点击 / 输入 / 滑动 / 日志采集的原生命令，以下能力必须由 APR 直接调用 `adb`：

- Click / LongClick / Swipe / Back → `adb shell input tap|swipe|keyevent`
- InputText → `adb shell input text`
- Logcat 采集 → `adb logcat`

因此第 8 节的架构图需要修正为：

```
Journey

↓

Interaction

↓ ↘

Android CLI      ADB (直接)

(layout / screenshot / run / device)   (click / input / swipe / logcat)
```

### 4.3 Build 阶段

`android run` 不做构建，Runtime Flow 中必须显式包含独立的 Build 阶段（Gradle），流程修正为见第 5 节。

---

## Android Project

第一阶段仅支持：

- Android Application
- Gradle Project

---

## Device

支持：

- Emulator
- USB Device

默认一次仅连接一个设备。

---

# 5. Runtime Flow

```
Build (Gradle)

↓

Run (android run，部署已构建 APK)

↓

Replay Journey（含逐步断言校验）

↓

Capture Screenshot

↓

Collect Logcat（按步骤时间窗口切片）

↓

Generate Report（分层判定结果）
```

整个流程保持简单，但 Build 作为独立阶段显式存在，不再隐含在 Run 中。

---

# 6. Journey

Journey 表示：

一次完整的用户操作，**以及每一步操作后预期发生的结果**。

例如：

```
首页

↓

点击搜索

↓ (预期：跳转到 SearchActivity)

输入 hello world

↓ (预期：日志出现 query=hello world)

等待页面刷新
```

Journey 不关心：

- Activity 内部实现细节
- Fragment
- 底层 ADB 命令

只描述用户行为 + 该行为应达成的可验证结果。

---

# 7. Journey Format

第一阶段使用 JSON。

在原有 `action` / `locator` 基础上，新增可选的 `expect` 字段，用于承载精确验证所需的断言。

```json
{
  "name": "Search",

  "steps": [

    {
      "action": "click",

      "locator": {
        "resourceId": "toolbar_search"
      },

      "expect": {
        "type": "activity",
        "value": "com.example.SearchActivity",
        "timeoutMs": 3000
      }
    },

    {
      "action": "inputText",

      "text": "hello world",

      "expect": {
        "type": "logcat",
        "tag": "SearchViewModel",
        "pattern": "query=hello world",
        "level": "D",
        "timeoutMs": 3000
      }
    }

  ]
}
```

## 7.1 `expect` 类型

第一阶段支持三种断言类型：

| type | 说明 | 判定依据 |
|---|---|---|
| `activity` | 当前前台 Activity 是否符合预期 | `dumpsys activity` 或等效方式获取当前 Activity |
| `element` | 新页面上是否出现指定元素（更细粒度的"跳转成功"判定） | `android layout` 匹配 resourceId/text |
| `logcat` | 指定时间窗口内是否出现匹配日志 | 见 11.1 时间窗口切片规则 |

`expect` 为可选字段。不写 `expect` 的步骤只做"结构级"校验（Locator 找到 + Action 执行成功），不做"断言级"校验，两者在 Report 中分别体现（见 12 节）。

Recorder 自动生成 `action` 与 `locator`。`expect` 原则上需要开发者或 AI 在录制后显式补充——这是有意的设计取舍：APR 不分析业务语义、不推断"这一步应该跳到哪"，只负责确定性地校验人为声明的预期，这样才能保证断言本身的可信度不依赖 AI 判断。

---

# 8. Interaction Layer

Journey 不直接执行 ADB。

所有操作统一通过 Interaction Layer。

```
Journey

↓

Interaction

↓ ↘

Android CLI (layout/screenshot/run)     ADB (click/input/swipe/logcat)
```

这样可以避免 Journey 与底层实现耦合，同时也把"哪些能力来自 Android CLI，哪些来自原生 ADB"这件事封装在 Interaction 层内部，对上层透明。

---

## Supported Actions

第一阶段仅支持：

| Action | Support | 执行方式 |
|---------|---------|---|
| Click | ✅ | ADB |
| LongClick | ✅ | ADB |
| InputText | ✅ | ADB |
| Swipe | ✅ | ADB |
| Back | ✅ | ADB |
| Wait | ✅ | 内部调度，见 10.1 |

其它操作后续增加。

---

## Locator

统一使用：

Android CLI Layout（`android layout`）。

Locator 优先级：

1. resourceId
2. text
3. contentDescription

第一阶段不支持：

- XPath
- 直接指定 Coordinate

### 8.3 兜底定位（新增）

当以上三种 Locator 均无法定位到目标元素时，允许使用 Android CLI 提供的 `screen capture --annotate` + `screen resolve` 作为兜底：先截图并获取标注框，再通过 `screen resolve` 将标签转换为坐标执行点击。

该兜底路径仅作为定位失败时的降级方案使用，不作为首选策略，且触发兜底时需要在 Report 中明确标记，提示这一步的稳定性弱于常规 Locator 命中。

---

# 9. Recorder

Recorder 用于录制 Journey。

流程：

```
Start

↓

Developer Operates App

↓

Stop

↓

Generate Journey（action + locator）

↓

（可选）人工/AI 补充 expect 断言
```

第一阶段 Recorder 自动录制：

- Action
- Locator

**不自动生成 `expect`**。断言涉及业务语义判断（"这一步应该跳到哪个页面""应该打印什么日志"），APR 不做推断，需要显式补充，以保证断言本身是可信的、非猜测的。

---

# 10. Replay

Replay 根据 Journey 执行操作，并在每一步之后校验对应的 `expect`（如有）。

每一步：

```
Execute Action

↓

Wait Until Idle

↓

（如有 expect）校验断言，记录结果

↓

Next Action
```

禁止：

```
sleep(1000)
```

## 10.1 Wait Until Idle 的具体实现

基于 `android layout --diff`：

1. 执行完 Action 后开始轮询 `android layout --diff`
2. 若连续 N 次（建议 N=2~3）轮询返回空 diff，则判定界面已稳定，可以进入下一步
3. 设置超时上限（建议默认 5s，可按 Journey 配置覆盖），超时后仍视为"未稳定"，记录为该步失败并附带最后一次的 diff 内容，便于排查

这一机制替代了原文档中悬而未决的"统一等待"描述，同时避免了硬编码 sleep。

## 10.2 失败处理策略（新增）

单步失败（Locator 未命中 / Action 执行异常 / Wait Until Idle 超时 / 断言不匹配）时：

- 默认策略：终止当前 Journey，不继续执行后续步骤，避免在错误状态上叠加更多不可控操作
- Report 中明确区分失败类型：
  - **环境类失败**（设备未连接、App 未启动成功等）
  - **结构类失败**（Locator 未命中、Action 执行异常）
  - **断言类失败**（跳转不符预期、日志未按预期出现）

第一阶段不做自动重试，重试策略留待后续阶段评估。

---

# 11. Collector

执行完成后统一采集：

- Screenshot
- Logcat

## 11.1 Logcat 时间窗口切片（新增）

为了让日志断言可信，Collector 需要按步骤对 logcat 做时间切片，而不是整段日志笼统匹配：

- 每个 Action 开始前记录时间戳 `T0`
- 该 Action 对应的 Wait Until Idle 结束（或断言校验完成）时记录时间戳 `T1`
- 该步骤的 `expect.type = logcat` 仅在 `[T0, T1]` 窗口内的日志中匹配 `pattern`

这样可以避免其他组件产生的无关日志造成误判。

第一阶段不对日志内容做进一步语义分析，只做 tag + pattern 的确定性匹配。

---

# 12. Report

输出分层判定结果，而不是单一的 Success/Fail：

```
Run Success（App 是否正常启动，未崩溃）

Journey Structural Success（每一步 Locator 是否命中、Action 是否执行成功）

Journey Assertion Success（每一步 expect 是否匹配：跳转 / 元素 / 日志）

Screenshot

Logcat（按步骤切片）

Duration

Fallback 使用记录（是否触发了 8.3 的坐标兜底定位）
```

三层判定分开展示的原因：出问题时，开发者或 AI 需要能立刻区分"是元素没找到""是跳转错了"还是"跳转对了但日志没打出来"，而不是只看到一个笼统的失败。

Report 不包含 AI 分析，所有判定均基于确定性规则。

---

# 13. Project Structure

```
apr/

├── cli/          # Android CLI 封装（layout / screenshot / run / device）

├── adb/          # 原生 ADB 封装（click / input / swipe / logcat）

├── runtime/      # 流程调度（Build → Run → Replay → Collect → Report）

├── interaction/  # 用户操作，统一编排 cli 与 adb

├── journey/      # Journey 定义（含 expect 断言 schema）

├── recorder/     # Journey 录制

├── collector/    # 日志与截图，含时间窗口切片

└── report/       # 结果输出，分层判定
```

职责：

**cli** —— Android CLI 封装，负责 layout / screenshot / run / 设备管理。

**adb** —— 原生 ADB 封装，负责 Android CLI 未覆盖的 click / input / swipe / logcat。

**runtime** —— 流程调度，包含显式的 Build 阶段。

**interaction** —— 用户操作，对上层屏蔽 cli 与 adb 的差异。

**journey** —— Journey 定义，包含 action / locator / expect。

**recorder** —— Journey 录制，仅生成 action + locator，expect 需另行补充。

**collector** —— 日志与截图，按步骤时间窗口切片 logcat。

**report** —— 结果输出，分 Run / Structural / Assertion 三层判定。

---

# 14. Success Criteria

第一阶段完成后，应满足：

- 可以录制 Journey（action + locator）
- 可以为 Journey 步骤补充断言（跳转 / 日志）
- 可以重复、确定性地执行 Journey
- 可以自动完成 Build + Run
- 可以基于 Layout Diff 稳定判断页面空闲状态，无需硬编码等待
- 可以输出 Screenshot
- 可以输出按步骤切片的 Logcat
- 可以输出分层（Run / Structural / Assertion）的验证结果
- 可以稳定完成开发验证，且验证结果不依赖 AI 判断

达到以上目标即可进入下一阶段。

不提前增加复杂能力。
