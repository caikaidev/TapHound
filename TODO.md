# TapHound 换机后 TODO

本清单用于当前开发阶段结束后的跨机器验证和后续预发布。GitHub 推送证据完成后，应以远端 `main` 和 [`docs/verification/taphound-v0.2-dev.1-audit.md`](docs/verification/taphound-v0.2-dev.1-audit.md) 为基线。

## 换机后恢复

- [ ] 从 `git@github.com:caikaidev/TapHound.git` 克隆或拉取 `main`。
- [ ] 记录 `git rev-parse HEAD`，确认它不早于本次 GitHub 发布证据提交。
- [ ] 使用 Node.js 22 或更高版本运行 `npm ci`。
- [ ] 按 [`docs/local-testing.md`](docs/local-testing.md) 运行完整源码质量门。

## 跨机器验证

- [ ] 重新生成 `taphound-0.2.0-dev.1.tgz`，核对 size、SHA-256、npm shasum、integrity 和文件清单。
- [ ] 从精确 tarball 安装并验证 `taphound --help`，确认没有旧二进制入口。
- [ ] 在 Emulator 或 USB Device 上运行 doctor 和 Demo Journey。
- [ ] 检查 `.taphound/runs/` 中的报告、截图和日志；记录设备、工具版本及失败复现步骤。
- [ ] 如发现问题，从远端 `main` 创建独立修复分支，不重写已推送历史。

## npm `dev` 预发布

- [ ] 完成跨机器验证并解决所有阻塞问题。
- [ ] 检查 npm 登录身份、2FA 要求及 `taphound` 包名状态，不记录 token 或 OTP。
- [ ] 重新运行完整质量门和精确 tarball 安装 smoke。
- [ ] 向用户展示账号、版本、public access、`dev` tag、tarball 摘要及文件清单，并取得独立明确确认。
- [ ] 仅发布 `taphound@0.2.0-dev.1` 到 `dev`；不得创建或移动 `latest`，不得发布不同 tarball。
- [ ] 从 registry 全新安装 `taphound@dev` 并运行 CLI smoke。
- [ ] 将 registry 证据写回发布审计，提交并正常推送；绝不 force-push。

在 npm 独立确认闸门之前，不执行任何 `npm publish` 命令。
