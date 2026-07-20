# TapHound 0.2.0-dev.1 本地发布就绪审计

- 审计日期：2026-07-20
- 分支：`codex/taphound-rebrand`
- 被审阅源码提交：`17b4d98b86c80d67bf1f6daf6ef75874190f6d21`
- 环境：Node.js `24.3.0`、npm `11.4.2`
- 结论：本地质量门禁、精确 tarball 安装 smoke 与迁移审计通过；GitHub push 和 npm publish 均未执行，仍需各自独立的明确确认。

## 源码质量门禁

在隔离工作树中基于上述源码提交重新执行：

| 检查 | 结果 |
|---|---|
| `npm test` | 通过；37 个测试文件、228 个测试 |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm run build` | 通过 |
| `npm run brand:render` | 通过 |
| `git diff --exit-code -- assets/brand/png` | 通过；确定性重渲染无差异 |

独立完整分支审阅没有 Critical 发现。唯一 Important 发现是旧完成审计中的 Demo 路径不可复现；已用失败回归测试证明、改为 `examples/taphound-android-demo`、重新执行 doctor，并提交修复。审阅提出的 npm `files` 精确 allowlist 建议也已落实为测试。

## 构建后 CLI 与环境探测

`node dist/cli/main.js --help` 退出码为 0，首行是 `Usage: taphound [options] [command]`，仅列出 `doctor`、`record`、`verify` 和 Commander 的 `help`。

执行：

```text
node dist/cli/main.js doctor --project examples/taphound-android-demo --json
```

真实结果为退出码 3：

```json
{"status":"failed","checks":[{"name":"node","status":"passed","version":"24.3.0"},{"name":"adb","status":"passed","version":"Android Debug Bridge version 1.0.41"},{"name":"android","status":"passed","version":"1.0.15857036"},{"name":"gradle","status":"passed"},{"name":"permissions","status":"notRun","message":"Permission probe requires an online selected device"},{"name":"device","status":"failed","message":"Expected exactly one online device, found 0"}],"failureCode":"DEVICE_UNAVAILABLE"}
```

Node、ADB、Android CLI 与示例 Gradle Wrapper 均通过。本机没有在线 Emulator 或 USB Device，权限探测因此按契约为 `notRun`；本审计不声称真实设备端到端验收已通过。

## 精确 tarball 与安装 smoke

唯一完成本地验证、后续允许用于发布闸门的文件是：

```text
/private/tmp/taphound-pack-smoke/taphound-0.2.0-dev.1.tgz
```

| 属性 | 值 |
|---|---|
| 文件大小 | 43,507 bytes |
| 解包大小 | 206,111 bytes |
| 条目数 | 92 |
| SHA-256 | `08ecd80cf66e5c1d7af6e8c8cfe7376ee96237660a8832d6492d435110564cfb` |
| npm shasum (SHA-1) | `a37d7e825f6cfa88a5c3b9e849d677425382387b` |
| npm integrity | `sha512-Cn/MBl1wkjJx4CsxWGQX3oeomUBIYDbszhe3g+Zx7KYr6+DcxVfIYtJi0g6Q+uTFvQ0/nNW/5qoDrbg+jJYEBg==` |

`npm pack --json` 的文件清单仅包含 `dist`、`README.md`、`LICENSE`、`package.json` 与 `assets/brand/taphound-mark.svg`。清单中没有 source map、测试、归档、PNG、概念图或其他品牌 SVG。

该精确 tarball 已安装到 `/private/tmp/taphound-install-smoke-final`。安装后的 `node_modules/.bin/taphound --help` 退出码为 0 并显示正确 CLI；`test ! -e node_modules/.bin/a&#112;r` 退出码为 0，证明旧二进制入口不存在。安装审计报告 0 个 vulnerability。

## 品牌与迁移合约

- 最终 SVG 是唯一品牌源文件；六个 PNG 尺寸由脚本确定性生成。
- 自动化品牌测试验证 SVG 结构、批准色值、尺寸、安全区及打包范围。
- 已在 512 px、32 px、深色、单色、透明背景和圆形裁切情形下人工检查：右向猎犬、鼻尖与橙色点击目标均可辨认，32 px 负空间保持开放，关键几何不被圆形裁切。
- Journey、Report 与配置 schema version 均保持 1；机器契约语义未更改。
- 活跃树陈旧名称扫描仅命中旧完成审计中一处明确标注为“未发布阶段内部代号”的迁移说明，没有活动兼容接口。
- secret 扫描无命中。
- 主 checkout 的原始设计文件与归档副本（`docs/archive/a&#112;r-v0.2/A&#80;R-Design-v0.2.md`）的 SHA-256 均为 `61872af876f52fba677faea2938b27bffbaa50ec91d5ca088207317a9b5abbb9`；原文件未删除或改写。

## 外部变更闸门

- GitHub 首次 push：**待独立明确确认**；未执行，且不会 force-push。
- npm publish：**待另一项独立明确确认**；未执行。允许的目标仅为公开的 `taphound@0.2.0-dev.1`、dist-tag `dev`，不得创建或移动 `latest`。
- npm `11.4.2` 对 `npm publish <tgz>` 不执行 `prepublishOnly`。发布安全性依赖本审计记录的新鲜完整门禁和上方精确 tarball；`prepublishOnly` 仅保护从目录直接发布的路径。若 tarball 内容或摘要变化，必须重新执行完整 pack/install smoke，旧确认也不得沿用。

本文不包含 registry token、GitHub token、OTP 或其他凭据。
