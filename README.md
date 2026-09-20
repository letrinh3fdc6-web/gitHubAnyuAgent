# AnYuAgent

AnYuAgent 是安域 AI 的独立桌面 Agent。它将账号、密钥、模型和本地工作区连接在一个简洁的桌面工作台中，支持对话、文件读写、终端任务、图片与视频技能，以及本地会话管理。

## 快速下载

<p>
  <a href="https://x.ailzd.com/downloads/anyu-agent-setup.exe"><strong>Windows 下载安装包</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://github.com/letrinh3fdc6-web/gitHubAnyuAgent/releases/latest"><strong>macOS 前往 GitHub 下载</strong></a>
</p>

macOS 用户请打开 GitHub 的最新 Release：

- Apple 芯片选择 `arm64.dmg`。
- Intel 芯片选择 `x64.dmg`。
- 首次打开未签名应用时，按页面提示执行 `xattr -cr /Applications/AnYuAgent.app`。

## 核心能力

- Anyu 账号登录与双重验证。
- API Key、模型目录和协议自动同步。
- 本地工作目录中的文件读取、编辑和终端任务。
- GPT、Claude、Gemini、Grok 等模型的统一对话体验。
- 图片、视频、文件附件和本机会话历史。
- 智能模型权限适配，也支持手动选择受控访问或完整访问。

## 本地开发

```powershell
cd anyu-agent-desktop
npm install
npm start
```

Windows 安装包：

```powershell
cd anyu-agent-desktop
npm run dist
```

macOS 包由 `.github/workflows/build-anyuagent-macos.yml` 在 GitHub Actions 上构建。推送 `v*` 标签后，工作流会生成 Apple Silicon 和 Intel 两套 DMG/ZIP，并发布到 GitHub Release。

## 许可

MIT
