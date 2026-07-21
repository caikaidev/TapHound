# TapHound 本地测试指南

本指南用于在当前机器或新的开发机器上验证源码、npm tarball 和 Android 设备流程。所有命令都从仓库根目录执行；测试阶段不要运行 `npm publish`。

## 1. 准备环境

要求：

- Node.js 22 或更高版本
- npm
- 进行设备测试时，额外安装 Android SDK、ADB、Android CLI，并启动一个 Emulator 或连接 USB Device

克隆并安装锁定依赖：

```bash
git clone git@github.com:caikaidev/TapHound.git
cd TapHound
npm ci
```

## 2. 运行源码测试

只运行一个测试文件：

```bash
npm test -- test/domain/journey.test.ts
```

运行完整源码质量门：

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run brand:render
git diff --exit-code -- assets/brand/png
```

全部命令都应退出 0，品牌 PNG 重渲染不应产生 Git diff。最新的精确测试数量记录在 [`verification/taphound-v0.2-dev.1-audit.md`](verification/taphound-v0.2-dev.1-audit.md)。

构建后可以直接检查 CLI：

```bash
node dist/cli/main.js --help
```

首行应为 `Usage: taphound`，并列出 `doctor`、`record` 和 `verify`。

## 3. 测试 npm tarball

先执行上方完整源码质量门，再生成本机将要验证的 tarball：

```bash
mkdir -p /private/tmp/taphound-pack-smoke
npm pack --json \
  --pack-destination /private/tmp/taphound-pack-smoke \
  --cache /private/tmp/taphound-npm-cache
shasum -a 256 /private/tmp/taphound-pack-smoke/taphound-0.2.0-dev.1.tgz
```

将摘要和 `npm pack --json` 的 size、shasum、integrity、entryCount 与[发布就绪审计](verification/taphound-v0.2-dev.1-audit.md)比较。任何差异都意味着必须重新完成本节的安装 smoke，不能沿用旧机器的验证结论。

把精确 tarball 安装到临时目录：

```bash
mkdir -p /private/tmp/taphound-install-smoke
npm install \
  --prefix /private/tmp/taphound-install-smoke \
  --cache /private/tmp/taphound-npm-cache \
  /private/tmp/taphound-pack-smoke/taphound-0.2.0-dev.1.tgz
/private/tmp/taphound-install-smoke/node_modules/.bin/taphound --help
test ! -e "/private/tmp/taphound-install-smoke/node_modules/.bin/$(printf 'a\160r')"
```

帮助命令和最后一个否定检查都应退出 0。npm 11 对 `npm publish <tgz>` 不执行 `prepublishOnly`，因此完整源码质量门和精确 tarball smoke 都是发布前的独立必需步骤。

## 4. 检查 Android 环境

查看在线设备：

```bash
adb devices -l
```

运行环境诊断：

```bash
node dist/cli/main.js doctor \
  --project examples/taphound-android-demo \
  --json
```

无在线设备时允许返回退出码 3 和 `DEVICE_UNAVAILABLE`；这不等于真实设备验收通过。存在多个在线设备时，后续命令必须使用 `--device <serial>` 明确选择。

## 5. 运行 Android Demo Journey

恰好有一个在线设备时运行仓库验收入口：

```bash
TAPHOUND_ACCEPTANCE_DEVICE=1 npm run acceptance:device
```

存在多个设备时直接指定 serial：

```bash
node dist/cli/main.js verify \
  --project examples/taphound-android-demo \
  --config examples/taphound-android-demo/taphound.config.json \
  --journey examples/taphound-android-demo/journeys/search.json \
  --device emulator-5554 \
  --json
```

将 `emulator-5554` 替换为 `adb devices -l` 返回的目标 serial。报告写入 `examples/taphound-android-demo/.taphound/runs/`，包含 `report.json`、`summary.txt`、截图和日志。

TapHound 使用仓库内自研的 JSON Journey；不要将其替换为 Android CLI 的 XML Journey。

## 6. 测试失败时记录什么

跨机器验证至少保留：

- Git commit SHA、Node/npm/Android CLI 版本和设备 serial
- 失败命令及退出码
- 对应 run 目录中的 `report.json`、`summary.txt` 和必要日志
- 是否能在相同 commit 上稳定复现

不要提交 token、OTP、设备隐私数据或其他凭据。
