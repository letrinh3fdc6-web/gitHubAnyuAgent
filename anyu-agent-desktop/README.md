# AnYuAgent 桌面客户端

AnYuAgent 是安域 AI 的独立桌面 Agent，不依赖浏览器页面即可登录账号、同步密钥和模型，并在本机工作目录中完成对话与任务。

## 安装

1. 下载对应系统的安装包。
2. Windows 双击安装器；macOS 打开对应架构的 DMG 并将 AnYuAgent 拖入 Applications。
3. 启动后使用与 `x.ailzd.com` 相同的账号登录；也可以直接注册或找回密码，启用双重验证时继续输入 Authenticator 验证码。
4. 登录后会自动同步当前账号的 API 密钥。账号尚无密钥时，客户端会引导前往 <https://x.ailzd.com> 创建，返回客户端刷新后即可开始使用。

登录凭据由 Windows 或 macOS 的系统安全存储加密保存；系统安全存储不可用时仅保留当前进程会话，不会把令牌明文写入磁盘。

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
