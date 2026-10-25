# 技能管理 · dsh-skill-manager

[![npm](https://img.shields.io/npm/v/@limnalash/dsh-skill-manager)](https://www.npmjs.com/package/@limnalash/dsh-skill-manager)

DeepSeek Harness 插件：把本机各软件已经安装的 Agent Skills 统一管理起来。

## 功能

- **本地技能库**：自动发现 `~/.dsh`、`~/.claude`、`~/.cursor`、`~/.codex`、`~/.agents` 等软件的技能目录（约定 `~/.<软件>/skills` 自动收录），显示软件名、安装位置、技能数量；只读的 DSH 内置技能单独列出。
- **中文简介与适用场景**：英文技能自动翻译并缓存，可手动修改；列表/详情/选择器都优先显示中文名（如「参数化建模（cad）」）。
- **自动分类**：首次打开按本机实际技能自动生成分类（钉钉办公、3D 打印、CAD 与制造、编码开发、文档处理、AI 与智能体……），只保留默认分类兜底；「自动整理」可随时重算，支持自定义分类、规则关键词、手动归类与移动。
- **仓库安装**：粘贴 GitHub 仓库地址 → 识别（星数/分支/技能列表）→ 保存仓库 → 单个或全部安装；安装前可给技能起中文名；同名冲突可选覆盖/跳过/重命名。
- **跨库复制 / 回收站**：技能可在 DSH、Claude Code、Codex、Cursor 等库之间复制；删除进回收站，可恢复或彻底删除。
- **输入框技能选择**：输入框左下角「技能」按钮，按分类折叠展示，选中即插入 `/技能名 `，回车直接调用。
- **分页**：技能列表每页 30 个，带页码与总数。
- 颜色全部使用宿主 `--dsw-*` 主题 token，跟随明暗主题；无轮询、无第三方前端依赖。

## 安装

```sh
dsh plugin --profile <profile> add @limnalash/dsh-skill-manager
```

或在 DSH Desktop 的「插件」页从插件市场安装。

## 界面截图

| 本地技能库 | 我的分类（自动生成） | 新增技能（仓库安装） |
| --- | --- | --- |
| ![本地技能库](https://raw.githubusercontent.com/Limnal-Ash/dsh-skill-manager/main/assets/screenshot-1.png) | ![自动分类](https://raw.githubusercontent.com/Limnal-Ash/dsh-skill-manager/main/assets/screenshot-2.png) | ![仓库安装](https://raw.githubusercontent.com/Limnal-Ash/dsh-skill-manager/main/assets/screenshot-3.png) |

## 兼容性

- DSH `>= 0.2.1-rc.2`（Web 版 / Desktop；Host + Client 双半）
- 无构建步骤；`index.js` 为 Host（Node ESM），`client.js` 为浏览器 loader 模块

## 数据位置

- 状态：`~/.dsh/skill-manager/state.json`（分类、中文名、翻译缓存、仓库、回收站）
- 回收站：`~/.dsh/skill-manager/trash/`

## 许可

MIT
