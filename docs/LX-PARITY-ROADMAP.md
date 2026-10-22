# LX Music → Aurora 能力对齐路线图

本文件是「照着 LX Music Desktop 做」的施工图。它来自对**已安装产物**的只读取证，
不是猜测：`resources/app.asar`（190 个文件）的清单 + `package.json` 的依赖 + 目录里的
`lyric.html` / `userApi/renderer/user-api.html` 等小文件。

参考对象：**`lx-music-desktop` v2.12.0-beta.3**（作者 `lyswhut`，Apache-2.0，
`github.com/lyswhut/lx-music-desktop`）。

## 两条硬约束（先写在最前面）

1. **不许复制代码。** LX 是 Apache-2.0，但 Aurora 的实现、UI、文案全部自己写；只对齐**能力与行为**，
   不搬运源码、不搬图标资源、不使用它的品牌。
2. **不做平台绕过。** Aurora 提供**宿主与运行时**（加载、沙箱、权限、搜索、解析、歌词、榜单），
   不内置也不分发任何绕过登录 / 付费 / DRM 的平台适配器。装什么源是使用者自己的事。

## 一、从产物里读出来的 LX 结构（取证）

| 证据 | 含义 |
| --- | --- |
| `dist/main.js` + `dist/renderer.js` | Electron 主进程 + 渲染层，Vue 3.3 + vue-router |
| `dist/lyric.html` + `dist/renderer-lyric.js` | **独立的桌面歌词窗口**（单独入口、单独进程，支持主题/歌词颜色注入） |
| `dist/renderer.download.worker.js` | 下载在 worker 里跑 |
| `dist/dbService.worker.js` + `better-sqlite3` | SQLite 在 worker 里跑 |
| `dist/renderer.main.worker.js` + `comlink` / `message2call` | worker / 进程间 RPC |
| `dist/pitch_shifter.audioWorklet.js` + `dist/media/*.wav`（13 个脉冲响应） | **变速变调 + 卷积混响/环境音效** |
| `dist/user-api-preload.js` + `dist/userApi/renderer/user-api.html` | 自定义源宿主页（空白页 + `default-src 'none'`） |
| `qrc_decode.node` | 二维码解码（分享/导入） |
| `dist/static/images/{tray,taskbar}` | 系统托盘 + 任务栏缩略图按钮 |
| `locales/` | 多语言 |
| `music-metadata` / `node-id3` | 读音频标签 / **写 ID3 标签** |
| `iconv-lite` + `jschardet` | GBK 等多编码文本与歌词解码 |
| `font-list` | 枚举系统字体（歌词字体选择） |
| `tunnel` | HTTP / SOCKS 代理 |
| `ws` + `bufferutil` / `utf-8-validate` | WebSocket（外部控制） |
| `sortablejs` | 拖拽排序 |
| `@simonwep/pickr` | 拾色器（主题自定义） |
| `crypto-js` | 源签名所需的加密 |
| `electron-log` | 结构化日志 |

## 二、状态表（PASS 表示有实跑证据，不表示「代码写了」）

| # | 能力 | Aurora 现状 | 证据 / 缺口 |
| --- | --- | --- | --- |
| 1 | 桌面歌词独立窗口 | **已完成** | 独立入口 `desktop-lyrics.html` + 独立 preload；逐字高亮、翻译、字号配色、锁定鼠标穿透、位置持久化。打包用例 9 项：窗口渲染当前行、时钟推进、字号生效并落盘、悬停控件、锁定、播放/暂停真的控制播放器、重启自动恢复 |
| 2 | 下载管理器 | **已完成** | `main/downloads.ts` + `main/id3.ts`（自实现 ID3v2.3，未引入 `node-id3`）。并发队列、断点续传（`Range`，开工前用 `stat()` 对齐 `.part` 真实长度）、暂停/继续/重试/取消/移除、进度/速度/剩余时间、文件名模板与非法字符清洗、重名自动 `(2)`、MP3 写标签（含封面）、重启后任务恢复为暂停且能接着下、清除已结束不删文件。打包用例里真实 UI 点 ⇩ 下载后用测试进程 `stat()` 验证文件。注：LX 把下载放在 worker 里以便 UI 不卡；Aurora 在主进程流式落盘，UI 完全不参与传输（下载页只渲染状态），故不需要 worker |
| 3 | SQLite 持久化 | 未开始（现为 JSON + localStorage） | 迁移面较大，且现有数据必须无损 |
| 4 | 音效（变速变调 / 环境音效） | 未开始 | 变速可先用 `playbackRate` + `preservesPitch`；真正的变调/混响需要 AudioWorklet + 自备脉冲响应 |
| 5 | 系统托盘 + 任务栏缩略图按钮 | **已完成** | `main/systemIntegration.ts`。托盘菜单：当前曲目 / 播放暂停 / 上下一首 / 显示隐藏主窗口 / 开关桌面歌词 / 退出；左键隐藏与显示。任务栏缩略图按钮（Windows）为上一首 / 播放暂停 / 下一首。**曲目显示不是副本**：托盘 tooltip 与菜单首行渲染的是渲染层上报的 `ReportedPlayerState`。打包用例 7 项：托盘真的注册到 OS、`mediaKeys` 真的被占用、tooltip 等于正在播放的那首、设置页四块开关、关掉媒体键真的释放、再打开再次占用、托盘真的销毁重建 |
| 6 | 全局媒体键 | **已完成** | `globalShortcut` 注册 `MediaPlayPause` / `MediaNextTrack` / `MediaPreviousTrack` / `MediaStop`，可开关且即时生效。被其他应用占用的键不会导致启动失败，也不会在 UI 里假装已生效（设置页显示的是实际占用的键名） |
| 7 | 外部命令通道（渲染层统一入口） | **已完成** | `sendPlayerCommand`（`desktopLyrics.ts`）是唯一入口，桌面歌词、托盘、任务栏按钮、媒体键全部走它；`appService.onPlayerCommand` 在渲染层执行。**没有第二条播放路径** |
| 15 | 操作系统图标 | **已完成** | `main/mediaGlyphs.ts`：托盘图标与任务栏按钮图在运行时**用代码画出来**（4× 超采样后降采样）并编码为真 PNG（zlib + CRC32，RGBA），不依赖任何图片资源。Media smoke 多了 5 项断言（PNG 签名与 IHDR 尺寸、`nativeImage` 能解码、不透明像素数量、32px 托盘、五个图标都非空） |
| 8 | 代理设置 | 未开始 | `session.setProxy` + 校验（源请求统一走 `http.ts`，接入点单一） |
| 9 | 多语言 i18n | 未开始 | 纯机械改造，但面积大（全部 UI 文案） |
| 10 | 歌词字体枚举 | 未开始 | 不想引入原生模块：可用 `document.fonts` + canvas 度量做近似枚举 |
| 11 | 榜单 / 歌手 / 专辑 / 歌单搜索维度 | 部分 | 歌单详情与推荐有；榜单缺（需能力位 `leaderboard`）、歌手/专辑缺 |
| 12 | 二维码导入导出 | 未开始 | 低优先级 |
| 13 | WebSocket 外部控制 | 未开始 | 低优先级（第 7 项的命令通道是它的前提） |
| 14 | 主题自定义（拾色器 + 背景图） | 部分 | 深/浅/跟随系统已有；自定义色板与背景图缺 |

## 三、施工顺序（按「用户能立刻感觉到」排序）

1. ~~桌面歌词独立窗口~~ ✅
2. ~~下载管理器~~ ✅
3. ~~托盘 + 任务栏按钮 + 全局媒体键~~ ✅
4. **音效**（先变速变调，再评估混响）
5. **代理设置**
6. **榜单 / 歌手 / 专辑维度**（源能力位 + UI）
7. SQLite（基础设施，风险最大，放到功能稳定之后）
8. i18n / 字体枚举 / 二维码 / 外部控制

每一项的验收标准都和这一项一样：**typecheck + lint + 三套 smoke（媒体 / 音源 / 脚本）+ 打包用例
必须全绿**，并且新功能要在打包产物里被真实驱动，而不是只存在于源码里。
