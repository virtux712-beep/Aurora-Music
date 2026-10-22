# Aurora Music

一款 Windows 优先、跨平台兼容的**本地优先**桌面音乐播放器。Electron + Vue 3 + TypeScript + Vite 构建，独立 UI 与独立代码结构。

当前版本 **v0.1.0**（Windows 10 / 11 x64）。两条核心链路已经跑通：

- 「导入音乐 → 播放 → 队列 → 收藏 / 历史 / 歌单」
- 「发现 / 搜索 → 多音源聚合 → 播放 → 沉浸式歌词 → 管理音源立即生效」

## 下载

| 版本 | 说明 | 下载 |
| --- | --- | --- |
| 安装版 | NSIS 安装程序 | [Aurora-Music-Setup-0.1.0-x64.exe](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases/download/v0.1.0/Aurora-Music-Setup-0.1.0-x64.exe) |
| 便携版 | 解压即用，免安装 | [portable.zip](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases/download/v0.1.0/portable.zip) |
| 源码包 | 完整源码（与本仓库内容一致） | [Aurora-Music-0.1.0-source.zip](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases/download/v0.1.0/Aurora-Music-0.1.0-source.zip) |

全部历史版本见 [Releases](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases)。

## 功能亮点

- **本地音乐库**：多选导入或递归扫描文件夹；music-metadata 读取标题 / 艺术家 / 专辑 / 时长；内嵌封面缓存；万首级虚拟滚动列表
- **播放与队列**：播放模式（循环 / 单曲 / 随机 / 顺序）、队列拖动排序、重启后恢复；系统托盘、任务栏按钮、全局媒体键、Media Session
- **沉浸式歌词**：模糊封面背景、逐行 / 逐字同步、点击跳转、F11 沉浸模式、桌面歌词窗口；歌词本地优先（同目录 `.lrc`、内嵌标签、手动导入）
- **多音源插件架构**：能力模型 + Registry + 沙箱 Runtime + 按主机授权。内置五家平台**搜索**（酷我 / 网易云 / QQ / 酷狗 / 咪咕，仅搜索与元数据，不含曲库）
- **自定义音源**：JSON 声明式清单接入你自己的 API；或导入 JS 脚本音源（含洛雪风格 `globalThis.lx` 兼容层与洛雪音源库 `user_api.json` 一键导入）
- **下载管理器**：并发队列、断点续传、进度 / 速度 / 剩余时间、文件名模板、MP3 写 ID3 标签、重启后任务保留
- **主题与统计**：深 / 浅 / 跟随系统主题；曲目数、总时长、收藏与播放统计

详细功能状态与已知边界见 [开发文档](docs/DEVELOPMENT.md) 与 [完整使用手册](docs/USER-GUIDE.md)。

## 快速开始（开发）

```bash
npm install
npm run dev          # 开发模式
```

生产构建（Windows）：

```bash
npm run build        # 生成 NSIS 安装版 + Portable 便携版到 release/
npm run build:dir    # 只打包目录，便于快速验证
npm run verify       # 类型检查 + Lint + 全部冒烟测试 + 构建，串行执行
```

## 文档

- [使用手册](docs/USER-GUIDE.md) —— 安装、导入、播放、歌词与音源的完整说明
- [发布说明 v0.1.0](docs/RELEASE-NOTES-0.1.0.md)
- [开发文档](docs/DEVELOPMENT.md) —— 架构、数据落盘位置、测试体系
- [音源运行时设计](docs/SOURCE-RUNTIME-DESIGN.md)
- [视觉引擎](docs/visual-engine.md)
- [洛雪对齐路线图](docs/LX-PARITY-ROADMAP.md)

## 目录结构

```text
src/
├─ main/          主进程：窗口 / 媒体协议 / 音乐库 / 歌词 / 音源系统 / IPC
│  ├─ customSources/  声明式自定义音源（清单 → 适配器 + 内置样板）
│  ├─ scriptHost/     JS 音源沙箱宿主（自研契约 + 洛雪兼容层）
│  ├─ lyricsEngine/   歌词引擎与多来源匹配
│  └─ musicSdk/       五家平台搜索与元数据（自有移植实现）
├─ preload/       contextBridge 桥接
├─ shared/        共享类型、常量、歌词解析
└─ renderer/      Vue 3 应用（views / stores / components / theme）
tools/            Electron 集成与冒烟测试
docs/             项目文档
```

## 安全与法律说明

Aurora 本身不包含任何绕过 DRM、避开访问控制或破解鉴权的代码，也不内置任何平台曲库：内置音源只有五家的**平台搜索**（本身放不出声音），可播放的音源全部由使用者自行安装，运行在受权限约束的沙箱 Runtime 里。音源能访问什么、播放什么，取决于使用者与该来源之间的约定及运行时授予的主机权限。
