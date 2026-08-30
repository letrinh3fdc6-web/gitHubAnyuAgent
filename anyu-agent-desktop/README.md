# AnYuAgent Windows 客户端

AnYuAgent 是独立 Electron 桌面客户端，不嵌入网站，也不依赖终端 Pi 窗口。

## 安装与启动

1. 双击 `dist/AnYuAgent-Setup-1.0.9.exe`。
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

安装器输出在 `dist/AnYuAgent-Setup-1.0.9.exe`。
