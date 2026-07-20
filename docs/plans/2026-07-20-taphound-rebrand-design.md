# TapHound 品牌迁移与预发布注册设计

**日期：** 2026-07-20  
**状态：** 已批准  
**品牌：** TapHound  
**首版定位：** TapHound for Android

## 1. 背景与目标

项目当前以 Android Project Runtime（APR）作为开发期名称。首个版本只支持原生 Android，但产品长期会扩展到 iOS、Web 或其他客户端，因此主品牌不能绑定 Android。

TapHound 是跨平台主品牌；Android 仅作为首个 Adapter 和发布副标题。品牌气质偏轻松、开发者友好，同时保留确定性验证工具应有的可信度。

本次迁移目标：

- 将当前代码树、CLI、协议名称、报告、配置、示例、测试和活跃文档统一为 TapHound。
- 在正式开源前预留 GitHub 仓库和 npm 包名。
- 不改变 v0.2 的功能与确定性语义。
- 不为尚未公开发布的 APR 名称保留兼容层。

## 2. 品牌系统

- 主品牌：`TapHound`
- 首版名称：`TapHound for Android`
- npm 包：`taphound`
- CLI：`taphound`
- GitHub 仓库：`caikaidev/TapHound`
- 产品描述：`Deterministic app journey recording and verification`
- 标语：`Follow every tap. Catch every regression.`
- GitHub Topics：`android`、`testing`、`cli`、`record-replay`、`regression-testing`、`ai-agents`

未来平台扩展使用同一个 Journey 与报告品牌，并由平台 Adapter 区分，例如 TapHound for Android、TapHound for iOS。首期不创建多包仓库或平台抽象占位代码。

## 3. 迁移策略

采用一次性、原子、无兼容层迁移。迁移后：

| 旧名称 | 新名称 |
|---|---|
| Android Project Runtime / APR | TapHound |
| `android-project-runtime` | `taphound` |
| `apr` CLI | `taphound` |
| `apr.config.json` | `taphound.config.json` |
| `.apr/runs` | `.taphound/runs` |
| `APR_*` | `TAPHOUND_*` |
| APR Journey | TapHound Journey |
| APR Report | TapHound Report |
| `AprConfig*` | `TapHoundConfig*` |
| `AprReport*` | `TapHoundReport*` |
| `examples/apr-demo` | `examples/taphound-android-demo` |
| `dev.apr.demo` | `dev.taphound.demo` |

迁移覆盖：

- `package.json`、lockfile、bin、程序名和帮助文本。
- 默认配置、产物目录、临时目录前缀和环境变量。
- Domain 导出类型、测试描述、fixture 和 fake 工具文件名。
- Recorder、Verifier、Doctor、报告摘要、stderr 诊断和错误信息。
- 示例工程目录、Android namespace/applicationId、Manifest label、Journey 和验收脚本。
- README、Agent 集成、Journey/Report Schema、设计、实施与审计文档。

Git 历史不重写。历史提交可以保留 APR；当前可发布树中只允许在明确的迁移说明或归档上下文中提及“APR 曾是内部代号”。本地 checkout 的父目录名称不属于发布产物，本次不改，以免破坏运行中的工作区。

根目录现有未跟踪文件 `APR-Design-v0.2.md` 属于用户原始资料。实施时先把内容迁入可追踪的 TapHound 设计/归档路径并核对，再移除旧路径；不得在没有可恢复副本的情况下删除。

## 4. 配置与协议边界

这是预发布破坏性改名，不接受以下旧入口：

- `apr` 命令。
- `apr.config.json` 默认文件名。
- `.apr` 默认目录。
- `APR_*` 环境变量。

Journey 和 Report 的 JSON schema version 保持 `1`，字段结构不变。品牌名不写入现有机器协议的判定字段，因此不因改名无意义地提升 schema version。人类可见名称、文档标题和 TypeScript 导出类型改为 TapHound。

## 5. GitHub 注册

用户已创建 GitHub 仓库：

```text
git@github.com:caikaidev/TapHound.git
```

实施阶段：

1. 确认仓库没有错误的现有 `origin`。
2. 添加并验证 `origin`。
3. 在推送前确认远端默认分支和内容状态，避免覆盖远端初始化提交。
4. 只有在本地改名、测试、发布审计全部通过后才首次推送。
5. 仓库先保持 private；正式开源前再执行 secrets/history、许可证、社区文件和 GitHub Actions 审计。

首次 push 是外部状态变更，执行时必须显式确认目标 owner/repository/branch。不得 force-push。

## 6. npm 预发布注册

npm 没有独立的“预留包名”操作。使用真实可运行的预发布版本占用名称：

- package：`taphound`
- version：`0.2.0-dev.1`
- dist-tag：`dev`
- access：`public`
- stable `latest`：不创建

发布命令最终形态：

```text
npm publish --tag dev --access public
```

发布前必须完成：

- `npm whoami` 与 registry 校验。
- 再次确认 `taphound` 名称未被占用。
- `npm pack --dry-run` 和 tarball 内容审计。
- 从 tarball 安装并运行 `taphound --help`、`doctor --json` 及机器输出契约测试。
- 确认没有 secrets、本地路径、测试 fixture、源码映射或无关文件泄露。
- 处理 npm 2FA/OTP；不得把 token 或 OTP 写入仓库、日志或命令历史文档。
- 发布后验证 `taphound@dev` 可安装，且不存在 `latest` 标签。

这虽然不是稳定版，但仍是公开 npm 发布。后续稳定开源版本使用新的 semver 并发布到 `latest`，不复用已发布版本号。

## 7. 许可证与发布元数据

许可证采用 Apache License 2.0。新增根目录 `LICENSE`，并在 `package.json` 中设置：

- `license: "Apache-2.0"`
- `repository` 指向 `caikaidev/TapHound`
- `homepage` 指向 GitHub README
- `bugs` 指向 GitHub Issues
- 合理的 `keywords`
- 明确的 `files` 和 publish lifecycle 脚本

正式公开 GitHub 仓库前再补齐 `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、Issue/PR 模板和稳定发布自动化；这些不阻塞 dev 包名预留。

## 8. 错误处理与回滚

- 迁移在独立分支/工作树中完成，避免污染已验证的 `main`。
- 先以测试表达新名称契约，再修改实现。
- 任一阶段失败时不保留“半 APR、半 TapHound”的提交；每个提交只覆盖一个可验证迁移层。
- GitHub 远端已存在内容时停止并审计，不自动合并或覆盖。
- npm dry-run 或 tarball smoke test 失败时禁止发布。
- npm 发布成功后不可回滚版本号；修复必须使用新的预发布版本，例如 `0.2.0-dev.2`。

## 9. 验证策略

自动化验证包括：

- 新 CLI 名称、帮助输出、stdout/stderr 和退出码黑盒测试。
- 默认 `taphound.config.json`、`.taphound/runs` 与 `TAPHOUND_*` 测试。
- Domain 类型、报告摘要、Recorder 提示和 Doctor 错误文案测试。
- 示例 Android Package、Activity、目录和验收 runner 合约测试。
- 文档示例测试只接受 `taphound`。
- 全库 stale-name 审计；仅迁移说明/归档白名单可以出现 APR。
- `npm ci`、单元/集成测试、typecheck、lint、build。
- `npm pack --dry-run`、tarball 文件列表与安装 smoke test。
- Git remote、分支和首次 push 目标审计。

## 10. 完成标准

- 用户可运行 `taphound doctor|record|verify`，不存在 `apr` 兼容入口。
- 默认文件与环境变量全部使用 TapHound 名称。
- 当前发布树的活跃源码、测试、示例和文档无非白名单 APR 残留。
- 所有既有功能测试继续通过，机器协议行为不变。
- Apache-2.0 与 npm/GitHub 元数据完整。
- `origin` 正确指向 `git@github.com:caikaidev/TapHound.git`。
- npm tarball 可独立安装与运行。
- `taphound@0.2.0-dev.1` 仅以 `dev` 标签发布；没有 `latest`。
- GitHub 仓库已安全推送并保持用户指定的可见性。

