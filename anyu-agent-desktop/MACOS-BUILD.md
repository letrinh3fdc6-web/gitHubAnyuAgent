# AnyuAgent macOS 打包

macOS 安装包必须在 macOS 上由 electron-builder 生成；Windows 主机不能可靠地产出 `.dmg`。仓库内提供 GitHub Actions 工作流：

```text
.github/workflows/macos-release.yml
```

## 触发方式

1. 将 `anyu-agent-desktop` 推送到 GitHub 仓库。
2. 打开 **Actions → AnyuAgent macOS → Run workflow**。
3. 填写版本号（例如 `1.0.59`），运行。
4. 工作流会分别在 `macos-14`（Apple Silicon）和 `macos-13`（Intel）上构建：
   - `AnyuAgent-<version>-arm64.dmg`
   - `AnyuAgent-<version>-arm64.zip`
   - `AnyuAgent-<version>-x64.dmg`
   - `AnyuAgent-<version>-x64.zip`
5. 在 Actions 运行的 Artifacts 中下载，或推送 `v*` tag 自动发布到 GitHub Release。

## 本地手动构建（在 Mac 上）

```bash
npm ci
node tools/build-vue-renderer.cjs
npm run dist:mac:arm64   # Apple Silicon
npm run dist:mac:x64     # Intel
```

输出在 `dist/`。

## 关于签名

工作流默认 `CSC_IDENTITY_AUTO_DISCOVERY=false`，生成的是未签名安装包。首次打开需要在 Finder 中右键 → 打开，或在“系统设置 → 隐私与安全性”中允许。

正式对外分发建议配置 Apple Developer ID 证书以及 notarization，对应 secrets：

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

## 下载页

下载页会根据 GitHub 最新 release 自动读取 `arm64.dmg` 和 `x64.dmg` 的地址。仓库或 tag 变化时不需要改前端代码。
