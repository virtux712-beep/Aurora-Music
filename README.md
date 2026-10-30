<p align="center">
  <img src="docs/images/banner.jpg" alt="Aurora Music" width="100%" />
</p>

<h1 align="center">Aurora Music</h1>

<p align="center">
  <strong>把你的音乐库，装进一片极光里。</strong><br/>
  一款 Windows 优先、跨平台兼容的<b>本地优先</b>桌面音乐播放器<br/>
  本地曲库 · 多音源聚合 · 沉浸式歌词 · 插件化音源系统，一个应用全部搞定
</p>

<p align="center">
  <a href="https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases"><img src="https://img.shields.io/github/v/release/virtux712-beep/Aurora-Music-v0.1.0" alt="最新版本" /></a>
  <a href="https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases"><img src="https://img.shields.io/github/downloads/virtux712-beep/Aurora-Music-v0.1.0/total" alt="下载量" /></a>
  <img src="https://img.shields.io/badge/Electron-34-47848F?logo=electron&logoColor=white" alt="Electron 34" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white" alt="Vue 3" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011-0078D6" alt="Windows 10 / 11" />
</p>

<p align="center">
  <a href="#-下载"><b>⬇️ 下载安装</b></a> ·
  <a href="docs/USER-GUIDE.md"><b>📖 使用手册</b></a> ·
  <a href="#-功能亮点"><b>✨ 功能亮点</b></a> ·
  <a href="#-架构一览"><b>🏗 架构一览</b></a> ·
  <a href="CHANGELOG.md"><b>📝 更新日志</b></a> ·
  <a href="docs/README.md"><b>📚 文档中心</b></a>
</p>

<table align="center">
  <tr>
    <td align="center" width="25%"><h3>🎧 本地优先</h3>曲库、封面、收藏、歌单<br/>全部保存在本机，离线可用</td>
    <td align="center" width="25%"><h3>🔌 插件化音源</h3>JSON 清单音源 + JS 脚本音源<br/>含洛雪风格兼容，装完即生效</td>
    <td align="center" width="25%"><h3>🎤 歌词第一公民</h3>逐行 / 逐字同步<br/>桌面歌词 + F11 沉浸模式</td>
    <td align="center" width="25%"><h3>🛡️ 安全默认开启</h3>脚本音源隔离沙箱运行<br/>联网逐主机授权，密钥加密保存</td>
  </tr>
</table>

## 📸 界面预览

<p align="center">
  <img src="docs/images/app-screenshot.png" alt="主界面" width="880" />
</p>

<table align="center">
  <tr>
    <td align="center"><img src="docs/images/shot-lyrics.png" alt="沉浸式歌词" width="420" /><br/><sub><b>沉浸式歌词</b> · 模糊封面背景，逐字高亮</sub></td>
    <td align="center"><img src="docs/images/shot-vinyl.png" alt="黑胶播放" width="420" /><br/><sub><b>黑胶播放</b> · 唱片转动，氛围拉满</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/shot-playlists.png" alt="歌单" width="420" /><br/><sub><b>歌单</b> · JSON 导入导出，随身带走</sub></td>
    <td align="center"><img src="docs/images/shot-theme.png" alt="主题" width="420" /><br/><sub><b>主题系统</b> · 内置主题 + 自定义主题文件</sub></td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/shot-search.png" alt="聚合搜索" width="880" />
  <br/><sub><b>聚合搜索</b> · 五家平台一次搜齐</sub>
</p>

## 💡 为什么选 Aurora

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🎧 本地优先，不绑云</h3>
      音乐库、封面、收藏、历史、歌单、队列全部保存在本机，不依赖任何云服务；万首级曲库虚拟滚动，导入、搜索、定位都不卡。
    </td>
    <td width="50%" valign="top">
      <h3>🔌 真正的插件化音源</h3>
      能力模型 + 注册表 + 沙箱运行时 + 按主机授权：声明式 JSON 清单音源零代码接入，JS 脚本音源（含洛雪风格）沙箱实跑预览后再安装，管理即时生效。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🎤 歌词是第一公民</h3>
      同目录 <code>.lrc</code>、内嵌标签、手动导入三级来源，逐行 / 逐字同步、点击跳转；独立桌面歌词窗口可锁定，F11 进入沉浸模式。
    </td>
    <td width="50%" valign="top">
      <h3>🛡️ 安全默认开启</h3>
      脚本音源跑在隔离沙箱里（无 Node 能力、网络全拦截），联网要逐个主机授权；密钥用系统级加密保存，永不进入渲染层。
    </td>
  </tr>
</table>

## ⬇️ 下载

当前版本 **v0.3.0**，适用于 Windows 10 / 11（x64）：

| 版本 | 说明 | 下载 |
| --- | --- | --- |
| **安装版** | NSIS 安装程序，推荐日常使用 | [Aurora-Music-Setup-0.3.0-x64.exe](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases/download/v0.3.0/Aurora-Music-Setup-0.3.0-x64.exe) |
| **便携版** | 免安装绿色版，双击即用 | [Aurora-Music-Portable-0.3.0-x64.exe](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases/download/v0.3.0/Aurora-Music-Portable-0.3.0-x64.exe) |
| **源码包** | 完整源码（与本仓库一致） | [Aurora-Music-0.3.0-source.zip](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases/download/v0.3.0/Aurora-Music-0.3.0-source.zip) |
| **校验文件** | SHA-256 完整性校验 | [SHA256SUMS.txt](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases/download/v0.3.0/SHA256SUMS.txt) |

## 📜 版本历史

| 版本 | 发布日期 | 亮点 | 详情 |
| --- | --- | --- | --- |
| **v0.3.0** | 2026-10-30 | 视觉与主题 2.0：10 套内置主题 · 统一 SVG 图标 · 胶片模式 · 沉浸播放页与歌词效果升级（候选版） | [发布页](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases/tag/v0.3.0) |
| **v0.2.0** | 2026-10-29 | 迷你播放器窗口 · 可访问性全面改进 · 端到端测试扩至 278 项，功能状态 52/52 | [发布页](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases/tag/v0.2.0) |
| **v0.1.0** | 2026-09-18 | 首个公开版本：本地曲库、插件化音源、沉浸式歌词、下载管理 | [发布页](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases/tag/v0.1.0) · [发布说明](docs/RELEASE-NOTES-0.1.0.md) |

每个版本的完整改动说明见 [更新日志 CHANGELOG](CHANGELOG.md)，历史版本文件见 [Releases](https://github.com/virtux712-beep/Aurora-Music-v0.1.0/releases)。

## ✨ 功能亮点

### 本地音乐

- 文件多选导入或递归扫描整个文件夹，带导入进度
- music-metadata 读取标题 / 艺术家 / 专辑 / 时长；内嵌封面自动缓存
- 万首级音乐库虚拟滚动不卡顿，支持排序、筛选、定位文件

### 播放与歌词

- 双声道交叉淡化与无缝衔接；列表循环 / 单曲循环 / 随机 / 顺序，队列拖动排序，重启自动恢复
- 迷你播放器：独立置顶小窗（封面 / 进度 / 上一首 / 下一首），与主窗口共享播放状态，位置与置顶自动记住
- 系统托盘、任务栏缩略图按钮、全局媒体键、Media Session 全支持
- 沉浸式歌词：模糊封面背景、逐字高亮、点击歌词跳转；独立桌面歌词窗口可锁定
- 响度均衡、睡眠定时、主题与视觉引擎（粒子 / 帧率治理）
- 主题系统 2.0（v0.3.0）：10 套内置主题、Theme Schema v2、主题中心（实时预览 / 对比度提示 / 导入导出），旧版用户主题继续兼容
- 胶片模式（v0.3.0）：颗粒、暗角、上下遮幅与冷暖色调，独立开关，低能耗自动降级
- 统一 SVG 图标与动效系统（v0.3.0）：核心操作不再依赖 Unicode 字形；页面进入动效、焦点环与弹窗焦点管理，尊重「减少动态」偏好

### 在线与音源系统

- 内置五家平台**搜索**（酷我 / 网易云 / QQ / 酷狗 / 咪咕，仅搜索与元数据）
- 声明式音源：一份 JSON 清单（URL 模板 + 字段映射 + 主机白名单）接入你自己的 API，不执行任何代码
- 脚本音源：导入 `.js` 或整包导入洛雪音源库 `user_api.json`，沙箱实跑预览后再安装
- 音源管理即时生效：启用 / 禁用 / 排序 / 配置表单 / 连通性测试 / 后台健康检查

### 下载与管理

- 下载队列：并发、断点续传、暂停 / 继续 / 重试，进度、速度、剩余时间实时显示
- 文件名模板、MP3 自动写入 ID3 标签（含封面），重启后任务与文件都在
- 收藏、播放历史、歌单（JSON 导入导出）、音乐统计一应俱全
- 完整备份 / 恢复；可选的本机只读 HTTP API（默认关闭，仅 127.0.0.1 + 令牌）

## 🏗 架构一览

```mermaid
flowchart LR
    UI["渲染层 · Vue 3 + Pinia<br/>界面 / 播放器 / 视觉引擎"]
    Bridge["预加载 · window.aurora<br/>最小桥接 API"]
    Main["主进程<br/>曲库 SQLite · 音源管理<br/>下载队列 · 媒体协议"]
    Sandbox["脚本沙箱 · 独立窗口<br/>断网隔离 / 权限拦截"]
    UI <-->|"IPC · 发送方校验"| Bridge
    Bridge <--> Main
    Main --> Sandbox
```

三层隔离是 Aurora 的地基：**Node 能力只存在于主进程**，渲染层只能通过受校验的桥接 API 访问文件与网络；脚本音源再单独关进一个断网的沙箱窗口，全部外联经主进程按主机授权放行。细节见 [开发文档](docs/DEVELOPMENT.md) 与 [音源运行时设计](docs/SOURCE-RUNTIME-DESIGN.md)。

## 🚀 快速开始（开发）

```bash
npm install
npm run dev          # 开发模式
npm run build        # 构建安装版 + 便携版到 release/
npm run verify       # 类型检查 + Lint + 全部冒烟测试 + 构建
```

## 📚 文档

全部文档见 [文档中心](docs/README.md)：

- [更新日志](CHANGELOG.md)：每个版本的改动说明与版本历史
- [使用手册](docs/USER-GUIDE.md)：安装、导入、播放、歌词与音源的完整说明
- [开发文档](docs/DEVELOPMENT.md)：架构、数据落盘位置、测试体系
- [发布说明 v0.1.0](docs/RELEASE-NOTES-0.1.0.md)
- [音源运行时设计](docs/SOURCE-RUNTIME-DESIGN.md) · [视觉引擎](docs/visual-engine.md) · [洛雪对齐路线图](docs/LX-PARITY-ROADMAP.md)

## 🧱 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面运行时 | Electron 34（contextIsolation + sandbox） |
| 界面 | Vue 3 + Vue Router + Pinia |
| 语言 / 构建 | TypeScript 5 + electron-vite + electron-builder |
| 数据 | SQLite（node-sqlite3-wasm）+ 本地文件镜像 |
| 元数据 | music-metadata |

## ⚖️ 安全与法律说明

Aurora 本身不包含任何绕过 DRM、避开访问控制或破解鉴权的代码，也不内置任何平台曲库：内置的只有五家平台**搜索**（本身放不出声音），可播放的音源全部由使用者自行安装，运行在受权限约束的沙箱里。音源能访问什么、播放什么，取决于使用者与该来源之间的约定及运行时授予的主机权限。

---

<p align="center">
  如果 Aurora 对你有用，欢迎点一个 ⭐ 支持一下。<br/>
  <sub>Aurora Music · 为本地音乐库而作</sub>
</p>
