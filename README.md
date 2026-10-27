# 会话删除

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的会话列表补上**删除**功能：在每个会话的「…」菜单中新增「删除会话…」，确认后永久删除会话及其全部存储数据。

> Adds a **Delete session** action to the DeepSeek Harness session list. Permanently removes a session and its stored data after confirmation.

## 功能

- 会话行「…」菜单新增红色危险项 **「删除会话…」**
- **永久删除确认框**：明确提示不可恢复、会停止运行中的工作；Esc / 焦点管理与宿主弹窗一致
- 删除内容包括：
  - 会话日志目录 `~/.dsh/sessions/<工作区>/<会话>/`
  - 投影缓存 `~/.dsh/storages/session_projcache/sessions/<会话>.json`
  - 工作区注册表中的成员、置顶、归档标记
- 删除前自动**停止会话中运行的工作**
- 支持删除**归档**的会话
- 支持删除**刚创建/刚分叉、尚未落盘**的会话
- 删除当前打开的会话时，自动切到同工作区的新会话
- 中英文界面，随主题明暗自适应

## 安装

### 方式一：从 GitHub 安装（推荐）

在 Harness 的 **设置 → 插件 → 添加插件** 中选择从 Git 仓库安装，填入安装规格：

```
github:jessonzhong/dsh-session-delete
```

也可以直接对 Harness 助手说：「用 plugin_manager 安装 github:jessonzhong/dsh-session-delete」。

### 方式二：本地目录安装（开发调试）

把本目录放到任意路径（如 `~/Desktop/Workspace/dsh-session-delete`），首次使用前在目录内执行一次：

```powershell
pnpm install
```

然后在插件管理器中从本地目录安装，或让助手执行 `plugin_manager install_bundle` 指向该目录。

> 从 GitHub 安装时无需手动 `pnpm install`；仅本地目录安装需要。

## 使用

1. 在左侧会话列表中，悬停任意会话行，点击「…」；
2. 点击「删除会话…」（红色项）；
3. 在确认框中核对会话标题，点击「永久删除」。

删除后该行立即从列表消失；如个别文件正被占用暂时删不掉，对话框会列出路径（会话本身仍会被移除）。

## 删除逻辑

按顺序执行，每步独立容错，任何一步失败不会中断后续清理：

1. **存在性检查** —— 内存活会话 / 磁盘日志 / 工作区记录 / 置顶归档集，任一命中即视为存在；
2. **停止工作** —— 走归档闸门停止运行中的轮次与子任务，并阻止后续唤醒；
3. **拆除活会话** —— `cancel` 停驱动 → `whenIdle` 排空 → 释放 agent 作用域；
4. **关闭持久化句柄** —— 解除文件占用（Windows 必需），并防止事后复活落盘；
5. **卸载内存条目** —— 触发 `session/disposed`，列表行立即消失；
6. **删除磁盘数据** —— 会话目录整删 + 投影缓存，带 3 次重试；
7. **清理注册表** —— 工作区成员摘除（follow 流实时广播到所有页面）、清置顶/归档；
8. **兜底** —— 若内存拆除在某版本上失效，会话保持隐藏并提示重启后彻底消失。

搜索索引（SQLite）是派生缓存，会在下次同步自动清除已删会话，无需处理。

## 兼容性与限制

- 在 DeepSeek Harness **0.2.1-rc.3**上开发并完整验证
- 删除**不可恢复**，请确认后再操作；建议重要内容先用「导出会话日志」备份
- 删除父会话不会删除它的分支/子会话
- 第 3、5 步触及 Harness 的内部拆除顺序（已做特性检测与降级），若未来版本变更，最坏情况是"会话隐藏、重启后消失"，不会损坏数据

## 目录结构

```
dsh-session-delete/
├── index.js          # Host 半：删除服务 + Typert Remote 描述符 + 删除逻辑
├── client.js         # Client 半：菜单项、确认框、Remote 挂载
├── cordis.patch.yml  # Loader 插件行
├── package.json      # 包清单
├── locale/
│   ├── en.json       # 插件管理器显示元数据（英文）
│   └── zh.json       # 插件管理器显示元数据（中文）
└── icon.svg          # 插件图标
```

## 开发说明

- 修改 `client.js` 后刷新页面即可生效（Client 包变更由 HMR/重载换入）；
- 修改 `index.js`（Host 半）后建议在插件管理器中**停用再启用**本插件，必要时重启 Harness；
- UI 样式复制自宿主 primitives（`MenuItemButton` / `Modal` / `Button`）并重命名为 `sd_` 前缀，仅使用 `--dsw-alias-*` 主题 token，不依赖任何 Harness Client 包。

## License

[MIT](./LICENSE)
