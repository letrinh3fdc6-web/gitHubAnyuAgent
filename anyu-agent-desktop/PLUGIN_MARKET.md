# AnYuAgent 插件市场规范

## 1. 插件包结构

插件可以是目录，也可以压缩为 `.anyu-plugin.zip`。根目录必须包含：

```text
my-plugin/
  anyu-plugin.json
  skills/
    summarize/
      SKILL.md
```

ZIP 可以多包一层目录，安装器会自动定位唯一的插件根目录。

## 2. `anyu-plugin.json`

```json
{
  "schemaVersion": 1,
  "id": "my-plugin",
  "name": "my-plugin",
  "displayName": "我的插件",
  "version": "1.0.0",
  "description": "为 AnYuAgent 提供可复用的摘要 Skill。",
  "publisher": { "id": "community", "name": "发布者名称", "verified": false },
  "license": "MIT",
  "categories": ["productivity"],
  "keywords": ["summary", "notes"],
  "skills": [
    { "name": "summarize", "path": "skills/summarize", "description": "总结长文本" }
  ],
  "permissions": {},
  "compatibility": { "anyuAgent": ">=1.0.0" }
}
```

必填字段：`id`、`version`、`name`、`displayName`、`description`、至少一个 `skills` 项。`id` 只能使用小写字母、数字、点和连字符；`version` 使用 SemVer。每个 Skill 必须能在声明路径下找到 `SKILL.md`，也支持直接声明 `skills/foo/SKILL.md`。

`image` 和 `video` 是 AnYuAgent 核心 Skill，属于保留名称，插件不能覆盖或替换。

## 3. Skill 编写约定

`SKILL.md` 使用 AnYuAgent 的标准 Skill 格式：用 frontmatter 或标题描述触发条件、输入、步骤、输出和限制。Skill 只能通过提示词和 AnYuAgent 已有工具工作；插件 v1 不加载 Node 扩展、Electron 主进程脚本或 Renderer 脚本。

## 4. 本地导入与生命周期

设置 -> 插件市场 -> 导入插件支持目录和 ZIP。导入流程会校验 manifest、SemVer、路径穿越、符号链接、文件数量和大小，并检查每个 `SKILL.md`。插件按 `userData/plugins/packages/<id>/<version>` 隔离安装，启用后重启 AnYuAgent 生效。

市场插件支持安装、更新、启用/禁用和卸载。每个插件最多保留最近 5 个版本，可在已安装列表中切换到历史版本。图片和视频核心 Skill 的执行逻辑不受插件卸载影响。

## 5. 发布

在“我的上传”中选择本地插件并填写发布者名称，可选择：

- `public`：提交市场审核，审核状态写回本地注册表。
- `private`：作为自定义插件，仅当前账号可见和使用。

发布前会重新扫描并生成 ZIP，同时计算 SHA-256。后端应实现：

```text
GET  /api/v1/marketplace/plugins
POST /api/v1/marketplace/plugins/publish
```

发布请求为 `multipart/form-data`，字段包含 `plugin_id`、`version`、`publisher_name`、`visibility`、`sha256`、`manifest`、`metadata` 和 `package` 文件。目录返回数组或 `{ "items": [...] }`，每项至少提供 `id`、`displayName`、`description`、`version`、`publisher`、`downloadUrl`、`verified`、`categories`、`keywords`。

## 6. 安全边界

市场下载仅接受 HTTPS；下载包仍在本地经过同样的 ZIP、manifest 和 Skill 校验。注册表采用原子写入，安装目录与隔离区分离；失败安装会清理暂存文件，不污染已安装版本。
