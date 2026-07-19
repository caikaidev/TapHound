# APR Journey Schema v1

APR Journey 是独立、自研、严格校验的 JSON 协议。它不复用、不调用且不兼容 Android CLI 官方 Journey。未知字段、空步骤列表、非 v1 文档以及自然语言步骤都会被拒绝。

## 顶层结构

```json
{
  "version": 1,
  "name": "Search flow",
  "steps": []
}
```

- `version`：当前固定为 `1`。
- `name`：非空 Journey 名称。
- `steps`：至少一个步骤，按数组顺序串行执行，首个失败后停止。

## Activity Checkpoint

每个步骤必须包含：

```json
"activity": {
  "before": "com.example.app.MainActivity",
  "after": "com.example.app.SearchActivity"
}
```

`activity.before` 在 Locator 解析之前检查；`activity.after` 在 Action 成功且 Layout 稳定之后检查。二者必须是完整限定类名。Recorder 从设备直接读取并自动写入，它们是结构性检查，不是业务 `expect`。

## Locator

目标型 Action 使用一个或多个字段：

```json
{
  "resourceId": "toolbar_search",
  "text": "Search",
  "contentDescription": "Open search"
}
```

优先级固定为 `resourceId`、`text`、`contentDescription`。Replay 从第一个有命中的字段开始，并用后续字段消除歧义；零命中返回 `LOCATOR_NOT_FOUND`，多命中返回 `LOCATOR_AMBIGUOUS`，不会猜测目标。

## Action

- `click`：需要 `locator`，执行 ADB tap。
- `longClick`：需要 `locator`，可设置正整数 `durationMs`，默认 800。
- `inputText`：需要非空 `text`，输入到当前焦点。
- `swipe`：需要 `locator`、`direction`；`distancePercent` 取 `(0, 1]`，默认 0.6；`durationMs` 默认 300。Recorder 只展示 Android CLI 标记为 scrollable 且提供 bounds 的元素；手写 Journey 若只定位到没有 bounds 的元素，会以 `ACTION_FAILED` 终止，不会猜测滑动区域。
- `back`：执行 ADB BACK keyevent。
- `wait`：只执行 Layout 稳定检测，不使用固定 sleep。

示例：

```json
{
  "action": "swipe",
  "locator": { "resourceId": "results" },
  "direction": "up",
  "distancePercent": 0.6,
  "durationMs": 300,
  "activity": {
    "before": "com.example.app.SearchActivity",
    "after": "com.example.app.SearchActivity"
  }
}
```

## 显式标注回退

只有 `click` 与 `longClick` 接受标注截图回退：

```json
"fallback": {
  "type": "annotatedLabel",
  "label": "#7"
}
```

常规 Locator 失败且存在 `annotatedLabel` 时，Replay 才会采集新的标注截图并让 Android CLI 解析该 `#编号`。APR 不通过 AI 或视觉推理选择标签。其他 Action 不允许回退。

## 显式 Expect

Recorder 不自动生成业务断言。步骤可以拥有一个 `expect`：

### `activity`

```json
{
  "type": "activity",
  "value": "com.example.app.SearchActivity",
  "timeoutMs": 3000
}
```

### `element`

```json
{
  "type": "element",
  "locator": { "resourceId": "search_input" },
  "timeoutMs": 3000
}
```

### `logcat`

```json
{
  "type": "logcat",
  "tag": "SearchViewModel",
  "level": "I",
  "pattern": "submitted query=hello world",
  "match": "literal",
  "timeoutMs": 3000
}
```

Logcat 只匹配本步骤 `[T0, T1]` 窗口。`match` 可为 `literal` 或 `regex`；正则必须有效。完整可执行示例见 [`examples/search.journey.json`](../examples/search.journey.json)。
