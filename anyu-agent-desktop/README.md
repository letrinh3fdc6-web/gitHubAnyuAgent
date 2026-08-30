# AnYuAgent Windows 客户端

AnYuAgent 是独立 Electron 桌面客户端，不嵌入网站，也不依赖终端 Pi 窗口。

## 安装与启动

1. 双击 `dist/AnYuAgent-Setup-1.0.16.exe`。
2. 安装完成后，从桌面双击 `AnYuAgent` 图标启动。
3. 输入 Anyu 邮箱和密码；启用 2FA 时再输入 Authenticator 验证码。
4. 登录后客户端会同步当前账号的 API Keys、会话和可用模型，可在右侧直接切换密钥和模型。
5. 新版本发布后，点击左下角“检查更新”。客户端会显示下载进度，校验安装包后自动退出、静默替换旧版本并重新启动；登录凭据和本机会话保留在用户数据目录中。

## 开发运行

```powershell
npm start
```

## 重新打包

Electron 运行时已经作为 `electronDist` 固定到本地依赖。首次安装依赖时如果镜像下载失败，可设置：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm install
npm run dist
```

安装器输出在 `dist/AnYuAgent-Setup-1.0.16.exe`。

## macOS 构建

GitHub Actions 会在 `main` 或 `v*` 标签推送后分别构建 Apple Silicon（`arm64`）和 Intel（`x64`）版本。打 `v1.0.16` 这类标签时，构建成功后会自动创建 GitHub Release，并附加 `.dmg` 与 `.zip` 文件。当前包未做 Apple Developer 签名与公证，首次打开按 macOS 提示允许即可。
