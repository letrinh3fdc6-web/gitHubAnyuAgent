# AnyuAgent 桌面客户端

AnyuAgent 是当前 TokenRouter 实例的独立桌面 Agent，不依赖浏览器页面即可登录账号、同步模型，并在本机工作目录中完成对话与任务。桌面端只调用本项目的 AnyuAgent 专用接口，不连接 Leta 后端。

## 安装

1. 下载对应系统的安装包。
2. Windows 双击安装器；macOS 打开对应架构的 DMG 并将 AnyuAgent 拖入 Applications。
3. 启动后使用当前 TokenRouter 网站账号登录；也可以直接注册或找回密码，启用双重验证时继续输入 Authenticator 验证码。
4. 登录后会从当前项目的 AnyuAgent 专用目录同步模型。账号没有可用分组时，客户端会引导回到 AnyuAgent 页面。

部署到远程站点时设置 `ANYU_API_BASE=https://你的站点` 和 `ANYU_ALLOW_CUSTOM_API_BASE=1`；本地联调默认使用 `http://127.0.0.1:8080`。

登录凭据由 Windows 或 macOS 的系统安全存储加密保存；系统安全存储不可用时仅保留当前进程会话，不会把令牌明文写入磁盘。

macOS 包下载入口由当前 AnyuAgent 发布页提供。

macOS 首次打开未签名应用时，在终端执行：

```bash
xattr -cr /Applications/AnyuAgent.app
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
