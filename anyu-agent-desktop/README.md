# AnYuAgent 桌面客户端

AnYuAgent 是安域 AI 的独立桌面 Agent，不依赖浏览器页面即可登录账号、同步密钥和模型，并在本机工作目录中完成对话与任务。

## 安装

1. 下载对应系统的安装包。
2. Windows 双击安装器；macOS 打开对应架构的 DMG 并将 AnYuAgent 拖入 Applications。
3. 启动后输入 Anyu 邮箱和密码；启用双重验证时继续输入 Authenticator 验证码。

macOS 包下载入口：<https://github.com/letrinh3fdc6-web/gitHubAnyuAgent/releases/latest>

macOS 首次打开未签名应用时，在终端执行：

```bash
xattr -cr /Applications/AnYuAgent.app
```

## 开发运行

```powershell
npm install
npm start
```

## 构建

```powershell
# Windows
npm run dist

# macOS Apple Silicon
npm run dist:mac:arm64

# macOS Intel
npm run dist:mac:x64
```

GitHub Actions 会在推送 `v*` 标签后构建 macOS arm64/x64 的 DMG 和 ZIP，并自动发布到 GitHub Release。

## 许可

MIT
