# Aurora Music 开发文档

## 1. 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面容器 | Electron 34 |
| 渲染层 | Vue 3 + TypeScript + Vite（electron-vite） |
| 状态管理 | Pinia（setup store 写法） |
| 路由 | Vue Router 4（hash 模式，兼容 `file://` 生产加载） |
| 样式 | 原生 CSS + CSS 变量（无 UI 框架） |
| 元数据 | music-metadata（主进程解析） |
| 打包 | electron-builder（NSIS 安装版 + Portable 绿色版） |

## 2. 进程结构

```text
src/
├─ main/                 主进程（Node 能力只在这里）
│  ├─ index.ts           生命周期、窗口、协议注册、导航拦截
│  ├─ media.ts           aurora-media:// 协议 + 文件白名单 + Range 流式响应
│  ├─ library.ts         音乐库：元数据、封面缓存、导入、持久化
│  └─ ipc.ts             IPC 处理器（带发送方与参数校验）
├─ preload/index.ts      contextBridge 暴露的最小 API
├─ shared/               主进程与渲染层共享的类型与常量
└─ renderer/src/
   ├─ components/        Sidebar / TopBar / PlayerBar / QueueDrawer / TrackList ...
   ├─ views/             首页 / 搜索 / 音乐库 / 歌单 / 收藏 / 历史 / 下载 / 设置
   ├─ stores/            player（音频引擎）、library、collection、playlists、ui
   ├─ composables/       useTrackActions（统一的歌曲操作）
   ├─ router/
   └─ styles/            base.css（设计令牌与外壳）、app.css（视图与组件）
```

## 3. 为什么需要自定义媒体协议

Electron 渲染进程出于安全策略**无法直接加载 `file://` 资源**（Chromium 会以 “Not allowed to load local resource” 拦截），
所以把 `file:///D:/music/a.mp3` 直接塞给 `<audio>.src` 是播放不出声音的。

Aurora 的做法：

1. 用户通过系统文件选择器授权文件后，主进程计算 `sha1(realpath)` 作为不透明 id，记录到内存白名单 `authorizedAudio`。
2. 渲染层拿到的是 `aurora-media://audio/<id>`，URL 里**不含真实路径**，无法构造越权访问。
3. 主进程用 `protocol.handle` 提供文件流，并实现标准 HTTP Range（206 / `Content-Range`）以支持拖动进度。
4. 封面同理走 `aurora-media://cover/<sha1>.<ext>`，只接受哈希文件名，拒绝路径穿越。

该协议注册为 privileged scheme（`standard` / `secure` / `stream` / `supportFetchAPI`），并在 `index.html` 的 CSP 中只允许 `media-src aurora-media:`。

### ⚠️ preload 必须是 CommonJS

`webPreferences.sandbox: true` 下，Electron **只以 CommonJS 执行 preload**：如果产物是 `.mjs`（ESM），preload 会被静默忽略，
`window.aurora` 就是 `undefined`，于是所有 IPC 功能（导入音乐、读取音乐库、版本信息）全部失效，而界面看起来仍然正常。

因此 `electron.vite.config.ts` 强制 preload 输出 `format: 'cjs'`、`entryFileNames: '[name].cjs'`，主进程引用 `../preload/index.cjs`。
回归检查交给 `npm run smoke:app`。

## 3.5 在线音乐源架构

```text
src/main/sources/
├─ types.ts        MusicSource 插件接口（meta / capabilities / 可选操作）
├─ manager.ts      SourceManager：注册 / 启用禁用 / 排序 / 配置 / 健康检查 / 聚合
├─ errors.ts       SourceError 与错误码映射（NETWORK_ERROR / TIMEOUT / UNAUTHORIZED …）
├─ http.ts         统一 HTTP（超时 / 重试 / 取消 / 响应体上限 / 镜像回退）
├─ platform.ts     内置「平台搜索」音源：一个平台一个 source，搜索靠 musicSdk，播放地址转交用户音源
└─ index.ts        注册内置音源 + 对外导出

src/main/musicSdk/
├─ index.ts        平台表 + LX `MusicInfo` 互转（toLxMusicInfo / toSourceMusicInfo 两代形状）
├─ http.ts         平台请求层（各家签名 / cookie / UA）
└─ platforms/      kw / wy / tx / kg / mg 五家的搜索实现（从洛雪 musicSdk 移植的自有实现）

src/main/sources/
├─ registry.ts     统一 entry 注册表（内置 / 声明式 / 脚本共用一份列表）
├─ store.ts        sources.json 持久化 + legacy custom-sources.json 迁移
└─ log.ts          错误日志与请求日志（环形缓冲，随描述符下发）

src/main/customSources/
├─ adapter.ts      声明式清单 → MusicSource（字段映射 / 白名单 / 流解析）
└─ store.ts        声明式 provider（校验 / 实例化 / 落盘，兼容旧 UI 接口）

src/main/scriptSources/
├─ store.ts        脚本 provider：两阶段导入探测 / 落盘 + 哈希 / 主机授权 / 热重载
├─ lxLibrary.ts    洛雪音源库（user_api.json）解析：gz_ + base64 + deflate，三种形态容错
└─ （探测/安装/授权/重载的对外接口都在 store.ts）

src/shared/customSource.ts  清单类型与校验规则（主进程与渲染层共用）
```

> 当前（v2）接口与数据流见第 11 节；下面这一小节保留了最初的设计背景。

### 数据流

```
渲染层（无网络能力）          主进程（唯一网络出口）
  sources.search(id,q)  ──▶  MusicSource.search()  ──▶ 公开 API
        ◀── AudioTrack[]（fileUrl 为空，封面已是远程令牌）
  sources.resolve(...)  ──▶  MusicSource.resolve() ──▶ 真实 CDN 地址
        ◀── aurora-media://remote/<token>
  <audio>.src = 该令牌   ──▶  media.ts 协议 → remote.ts 中继 → 上游（Range 透传）
```

设计要点：

- 真实地址从不进入渲染层，注册表（最多 2000 条，FIFO 淘汰）是唯一的白名单。
- 播放地址在**播放时**才解析，因为 CDN 链接会过期；队列、收藏、历史只保存元数据快照。
- 在线曲目元数据快照保存在 `localStorage: aurora:online-tracks`（上限 400 条），使收藏与历史在重启后仍能显示在线歌曲。
- 直播源标记 `live: true`：没有时长、进度条不可拖动，播放栏显示 LIVE。

### 实现一个新音源（v1 接口，已被第 11 节的 v2 接口取代）

```ts
import type { AuroraTrack } from '../../shared/types'
import { buildTrack, type MusicSource } from './types'

export const mySource: MusicSource = {
  id: 'my-source',
  describe: () => ({ id: 'my-source', name: 'My Source', description: '...', homepage: '...',
    license: '...', capabilities: ['search', 'stream'], requiresKey: false, configured: true }),
  async search(query, limit) { /* 返回 fileUrl 为空的 AudioTrack[] */ },
  async resolve(trackId) { /* return { url: registerRemoteMedia(真实地址,'audio',id), live: false, downloadAllowed: false } */ },
}
```

实现后只需在 `src/main/sources/index.ts` 里 `registerSource(mySource)`，其余代码（播放器、队列、收藏、历史、UI）无需改动。

> 约束是**技术**约束：音源只能经 HTTP Bridge 访问网络，不能碰文件系统 / 进程 / Electron 能力。
> Aurora 不内置任何平台适配器，也不判断你安装的音源针对哪个平台 —— 那是你和你的音源之间的事。

音源配置保存在 `<userData>/settings.json`，密钥（例如音源的 API key / token）加密后保存在 `<userData>/secrets.json`，两者都由主进程拥有并校验，渲染层通过 `settings:*` / `sources:*` 读写，见第 11 节。

## 4. 安全模型

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- 渲染层只能通过 preload 暴露的 `window.aurora` 访问能力，没有 Node API
- IPC 处理器校验：调用必须来自主窗口的主 frame（拒绝 iframe），id 必须是长度受限的字符串，音量会被夹到 `[0,1]`
- 媒体协议只服务白名单文件与封面目录，扩展名白名单（mp3/flac/wav/m4a/aac/ogg/opus）
- 外部链接一律拒绝窗口内打开，`will-navigate` 被阻止
- 严格 CSP：`script-src 'self'`，无远程字体、无远程脚本（离线可用，启动更快）

## 5. 数据存放

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 音乐库索引 | `<userData>/library.json` | 元数据 + 封面文件名 + 添加时间 |
| 封面缓存 | `<userData>/covers/` | 以内容哈希命名，导入时写一次 |
| 音源设置 | `<userData>/settings.json` | 每个音源的普通配置、启用状态、排序；另外含桌面歌词与下载块（目录 / 文件名模板 / 并发 / 写标签） |
| 下载任务索引 | `<userData>/download-tasks.json` | 任务状态 + 曲目快照（重启后用于重新解析地址） |
| 下载文件 | `<userData>/downloads/`（可在下载页更改） | 真实文件；未完成的在 `<名字>.part` |
| 音源密钥 | `<userData>/secrets.json` | Electron `safeStorage` 加密（系统密钥链 / DPAPI） |
| 用户导入歌词 | `<userData>/lyrics/<sha1(trackId)>.lrc` | 手动导入的歌词，优先级最高 |
| 主题 | localStorage `aurora:theme` | |
| 播放偏好 | localStorage `aurora:player-prefs` | 音量 / 静音 / 播放模式 |
| 收藏 / 历史 | localStorage `aurora:favorites`、`aurora:history` | |
| 歌单 | localStorage `aurora:playlists` | 后续迁移到 SQLite |
| 队列快照 | localStorage `aurora:queue` | 重启后恢复上次队列 |
| 在线曲目快照 | localStorage `aurora:online-tracks` | 让收藏/历史能解析在线歌曲（上限 400） |
| 搜索历史 | localStorage `aurora:search-history` | 最近优先、自动去重、上限 30 条 |

`userData` 目录可在「设置 → 关于 → 数据目录」查看。

## 6. 播放引擎

`stores/player.ts` 是唯一的播放状态来源，内部持有原生 `HTMLAudioElement`：

- 队列（支持拖动排序、移除、清空、插入下一首）
- 播放模式：列表循环 / 单曲循环 / 随机播放 / 顺序播放
- 进度与拖动（`seekRatio`）、音量与静音、缓冲状态
- 播放历史在真正开始播放时记录，暂停后继续不会重复计数
- Media Session（系统媒体控制）与 `player:report` IPC（为后续托盘/迷你播放器预留）
- 文件不可读时不会静默失败：标记该曲目并弹出提示

## 7. 快捷键

| 按键 | 行为 |
| --- | --- |
| `Space` | 播放 / 暂停 |
| `←` / `→` | 后退 / 前进 5 秒 |
| `Ctrl + ↑` / `Ctrl + ↓` | 音量 +5% / -5% |
| `Ctrl + K` / `Ctrl + F` | 跳到搜索页并聚焦搜索框 |
| `Ctrl + Shift + L` | 打开沉浸式歌词页 |
| `F11` | 歌词页内切换沉浸模式；其他页面切换全屏 |
| `Esc` | 退出歌词页的沉浸模式 / 关闭歌词导入弹窗 |

输入框聚焦时快捷键不会触发（`Ctrl+K` / `Ctrl+F` / `F11` 除外）。自定义快捷键属于后续阶段。

## 8. 开发命令

```bash
npm install
npm run dev            # 开发模式（HMR）
npm run typecheck      # vue-tsc 类型检查
npm run lint           # ESLint
npm run smoke:media    # Electron 集成测试：媒体协议 / Range / 真实播放
npm run smoke:sources  # 音源系统 + 歌词 + 下载管理器：中继 / 权限 / 声明式音源 / 真实文件落盘
npm run smoke:scripts  # JS 音源运行时 E2E：沙箱 / 洛雪兼容 / 权限 / 超时与崩溃隔离 / 重启
npm run smoke:app      # DevTools 协议驱动打包版：preload / IPC / 路由
npm run check:asar     # 检查打包产物内容
npm run verify         # 上面全部串行执行
npm run build:dir      # 仅打包目录（快速验证）
npm run build          # 生成 Windows 安装包与绿色版

# 手动诊断（需要网络，不进 verify）：回的是“音源到底能不能放声”，不是“代码看起来能不能跑”
npm run check:lx -- "path/to/source.js" 晴天   # 单个音源：探测 → 安装 → 搜索 → 解析 → 取音频字节
npm run check:lx-library                      # 整个洛雪音源库：预览 + 导入 + 逐个验证音频字节
```

### 关于两个手动诊断（`check:lx` / `check:lx-library`）

它们是**唯一**能区分「Aurora 兼容层有问题」与「音源自己的后端已失效」的工具 —— 这个区分决定了该修谁：

- `check:lx` 跑单个音源；`check:lx-library` 读整个 `user_api.json`，逐个音源预览（真在沙箱里跑一次）、导入、
  搜索并解析，最后用 `net.fetch` 取真实字节（不是只看“返回了字符串”）。
- `AURORA_FORCE_PLATFORM=wy` 把所有音源钉在同一个平台上，才能把“后端挂了”与“宿主拼错了请求”分开；
  `AURORA_QUALITY=320k` 固定音质；`AURORA_LX_TIMEOUT_MS` 控制单次调用预算。
- `tools/lx-resolve-probe.mjs` 是第三个、最关键的对照：它用 **Node 的真实 crypto/zlib/Buffer** 按洛雪
  `preload.js` 原样跑同一个音源。若它同样失败 → 音源自身后端的问题；若它成功而 Aurora 失败 → 兼容层的 bug。
  实测价值：十个音源在 `tx` 平台全部失败，在 `lx-resolve-probe` 里**同样失败**（后端已失效），而在 `kw`/`wy` 上两类实现都成功。
- 这三个脚本都不会被 `verify` 调用：它们依赖真实网络与用户自己的音源文件，放进构建只会变成不稳定因素。

### 关于 `npm run smoke:media`

该脚本会把真实的 `src/main/media.ts` 打进 Electron 运行，并断言：

- 完整响应 200 且字节数与文件一致
- `Range: bytes=100-199` 返回 206、`Content-Range` 正确、内容逐字节一致
- 未授权 id 返回 404
- 封面端点拒绝 `..%2F` 与 `..%5C` 形式的穿越
- 渲染层 `<audio>` 能解码、能播放前进、能拖动到指定时间
- 运行时生成的托盘 / 任务栏图标真的是可解码的 PNG（签名 + IHDR 尺寸 + 不透明像素数量），
  而不是“看起来像缓冲区”的东西（一个 `nativeImage` 拒绝的 buffer 只会在用户机器上表现为托盘图标不见了）

### 关于 `npm run smoke:app`

该脚本用 `--remote-debugging-port` 启动**打包后的应用**，通过 DevTools 协议断言：渲染进程可达、`window.aurora` 桥接存在、IPC 往返成功、主进程返回版本信息、Vue 已挂载、hash 路由可导航。
它专门用来抓「开发正常、打包失效」这一类问题。

## 9. 分阶段计划

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| Phase 1 | 工程骨架、窗口、导航、主题 | 已完成 |
| Phase 2 | 本地音乐扫描 + SQLite + 增量索引 | 部分完成（JSON 索引 + 手动导入，SQLite 待做） |
| Phase 3 | 播放内核、队列、播放模式 | 已完成 |
| Phase 4 | 歌词、封面更换、Now Playing | 已完成（.lrc / 内嵌 / 逐行 + 逐字 / 沉浸歌词页） |
| Phase 5 | 歌单、收藏、历史（SQLite 化） | 部分完成（本机存储版可用） |
| Phase 6 | 搜索 + 音乐源插件系统 | 已完成（多音源统一搜索 + SourceManager + 能力模型 + 平台搜索音源 + 用户自定义声明式/JS 音源 + 后台健康检查） |
| Phase 7 | 下载管理器 | 已完成（真实落盘 + 并发 + 断点续传 + 写 ID3 标签 + 重启恢复） |
| Phase 8 | 均衡器、频谱、桌面歌词、Mini Player | 待开始 |
| Phase 9 | 快捷键自定义、托盘、媒体控制 | 部分完成（基础快捷键 + Media Session） |
| Phase 10 | 开放 API、数据备份、自动更新 | 待开始 |

## 11. 架构升级：音源插件化 / 歌词 / 多音源搜索

### 11.1 分层与依赖方向

```text
text
View（views/*.vue）
  ↓ 只读 store
Store（stores/source | search | lyrics | sourcePlaylist）
  ↓ 只调 service
Service（renderer/src/services/aurora.ts，唯一接触 window.aurora 的地方）
  ↓ IPC（preload/contextBridge）
SourceManager（main/sources/manager.ts）
  ↓ 能力门控 + 错误隔离
Source plugin（平台搜索 / 声明式清单 / JS 脚本）
  ↓
平台搜索接口（kw / wy / tx / kg / mg）+ 音源自己的后端
```

约定：

- **页面组件不允许直接调用 `window.aurora`**，也不允许出现 `sourceId === 'kw'` 这类分支；
  需要判断时统一走 `sourceStore.can('lyrics', sourceId)` 这类能力查询。
- 主进程是唯一的网络出口；渲染层没有 Node / 网络 / 文件系统能力（`sandbox: true`）。

### 11.2 能力模型

```ts
interface SourceCapabilities {
  search: boolean        // 关键词搜索
  stream: boolean        // 可解析播放地址
  lyrics: boolean        // 能提供歌词（UI 据此决定是否显示歌词入口）
  playlists: boolean     // 能提供歌单 / 合集
  playlistDetail: boolean
  albums: boolean
  artists: boolean
  recommendations: boolean
  radio: boolean         // 直播电台（无时长、不可拖动）
  download: boolean      // 能解析播放地址就能下载（宿主能力，不是许可判定）
}
```

UI 能力驱动的例子：歌单广场只展示声明 `playlists` 的音源，音源合集详情与推荐行为由能力门控，未声明 `recommendations` 的音源不会在首页产生推荐入口。

### 11.3 实现一个音源（当前接口）

```ts
import { buildTrack, defineCapabilities, type MusicSource } from '../main/sources/types'

export const mySource: MusicSource = {
  meta: {
    id: 'my-source',
    name: 'My Source',
    version: '1.0.0',
    author: 'you',
    description: '自建/第三方 JSON 接口音源',
    homepage: 'https://example.com',
    license: '开放授权',
    capabilities: defineCapabilities({ search: true, stream: true }),
    requiresConfig: false,
    builtin: false,
    configSchema: {
      fields: [{ key: 'apiKey', label: 'API Key', type: 'password', secret: true, required: true }],
    },
  },

  async search(query, options, context) {
    // context.config 已合并默认值与解密后的密钥；context.allowDownloads 仅保留给
    // 需要逐曲判断“这个地址能不能存”的音源，下载管理器本身不再用它做准入
    return items.map((item) => buildTrack('my-source', { id: `my-source:${item.id}`, title: item.name, /* … */ fileUrl: '' }))
  },

  async resolve(trackId, context) {
    return { url: registerRemoteMedia(directUrl, 'audio', 'my-source'), live: false, downloadAllowed: true }
  },
}
```

在 `src/main/sources/index.ts` 里 `registerSource(mySource)` 即可，播放器 / 队列 / 收藏 / 历史 / UI 都不需要改动。

### 11.4 配置、密钥与健康检查

- 插件通过 `meta.configSchema` 声明配置字段，设置页据此**自动生成表单**（不再为每个插件手写 UI）。
- 标记 `secret: true` 的字段用 Electron `safeStorage` 加密后写入 `<userData>/secrets.json`；
  描述符只告诉渲染层“该字段是否已配置”（`secretKeys`），密钥值永不下发，也不写入 localStorage。
- 每个音源可提供 `healthCheck()`；“测试连接”按钮会显示真实延迟与错误原因。
- 主进程会定时跑一轮后台健康检查（`startHealthMonitor`）：逐个探测已启用音源，**每次都重新读取设置**，
  所以关闭开关或禁用某个音源会在下一轮立即生效；探测失败的音源只被标记为 `error`，
  搜索页会把它显示为“暂时不可用”，其余音源照常工作。可在音源管理页一键关闭。

### 11.5 用户自定义音源（两种：声明式清单 / JS 脚本）

Aurora 是 **用户自定义 Source Host**：它只判断“这个 Source 能不能被当前 Runtime 加载执行”，
不判断“这个平台是不是被批准”。安装只要求**格式可识别 + 契约可满足**，
而“能不能联网”是运行时的另一件事（见 §11.5.3 权限层）。

**格式一：声明式 JSON 清单**（不执行任何用户代码）：

```jsonc
{
  "apiVersion": "1",
  "id": "my-source",
  "name": "我的音源",
  "version": "1.0.0",
  "homepage": "https://example.com",
  "license": "CC BY 4.0",
  "capabilities": { "search": true, "stream": true },
  "permissions": ["network"],
  "allowedHosts": ["api.example.com"],
  "search": {
    "url": "https://api.example.com/search",
    "query": { "q": "{query}", "limit": "{limit}" },
    "resultsPath": "results",
    "fields": { "id": "id", "title": "title", "artist": "artist.name", "streamUrl": "stream" }
  }
}
```

为什么是声明式清单：

- **可校验**：`shared/customSource.ts` 在保存前一次性列出所有问题（apiVersion、必填字段、
  占位符、能力与 endpoint 是否匹配），导入的文件也会在**读入磁盘时**再校验一次。
- **不执行代码**：没有 `eval` / `vm` / `child_process` / 文件系统；它只能经 HTTP Bridge 发请求。
- **网络边界是运行时的事**：只允许 http(s)（仅 `localhost` / `127.0.0.1` / `::1` 允许明文 HTTP），
  重定向被直接拒绝（`redirect: 'error'`），API 返回的封面 / 播放地址同样要过**已授权主机**检查，
  不通过则丢弃并在音源卡片上给出授权入口（`smoke:sources` 有专门的 SSRF 用例）。
- `allowedHosts` 空着完全合法：那就是“什么都没授权”，首次请求会被权限层拒绝并记入待授权列表。
- 该格式没有歌词端点字段，因此声明 `capabilities.lyrics` 会被拒绝 ——
  原因是**本格式无对应实现**，与“音源是否合法/公开”无关；需要歌词请用脚本音源。
- `capabilities.download` 不需要声明：它能解析音频流就会自动为真（真正的保存由宿主完成），
  所以「能不能下载」从来不是一次准入判断。

真实目录需要两个声明式逃生口（都已支持并在测试里覆盖）：

- **字段 URL 模板**：`cover` / `homepage` / `streamUrl` 可以写成 `https://host/cover/{id}.png`，
  其中 `{id}` 是该条目的 id；其余字段必须是 JSON 路径（写了占位符会被拒绝）。
- **从列表里选文件**：有些 API 的播放地址不在搜索结果里，而是要先查一份文件清单：

```jsonc
"stream": {
  "url": "https://archive.org/metadata/{id}",
  "select": {
    "list": "files",
    "match": { "field": "format", "equals": ["VBR MP3", "Ogg Vorbis"] },
    "url": "name"
  },
  "urlTemplate": "https://archive.org/download/{id}/{value}"
}
```

  `select` 取清单里第一个 `format` 命中 `equals` 的条目，读出 `name`；因为它是文件名而不是地址，
  再用 `urlTemplate`（`{value}` = 选中的值，自动百分号编码）拼成真实下载地址。
  也可以只用 `urlPath` 直读一个地址；两者都不写时，`stream.url` 本身就是音频地址（旧式直播端点）。

内置样板（`main/customSources/templates.ts`）把上面这套写法变成了可载入的起点——
音源管理 → 自定义音源 → 添加 → 编辑器顶部点一下即可载入：

| 样板 | 目标 | 说明 |
| --- | --- | --- |
| Internet Archive | `advancedsearch.php` + `metadata/{id}` + `download/` + `services/img/` | 只保留声明了许可证、未被限制访问、且确实有 MP3 派生文件的条目 |
| Internet Archive · 独立厂牌 | 同上，叠加 `collection:(netlabels)` | Creative Commons 授权的独立厂牌专辑与单曲 |

样板不会被自动安装：它只是填进编辑器，用户仍需自己保存，而且保存时走的是同一套校验。
想验证样板在真实 API 上确实能搜、能解析、能取到音频字节：

```bash
AURORA_LIVE_TEMPLATES=1 npm run smoke:sources   # 额外打真实 Internet Archive API 验证内置样板
```

这个联网用例**不在** `npm run verify` 里：第三方目录偶发不可用不应该让构建失败。

运行时链路：`manifest → main/customSources/adapter.ts → MusicSource`，因此自定义音源和内置音源
走的是**同一套** SourceManager 逻辑（启用 / 禁用 / 排序 / 能力门控 / 缓存 / 错误隔离）。
清单保存在统一的 `<userData>/sources/sources.json`（旧 `custom-sources.json` 首次启动自动迁移并保留原文件），
支持导出 / 导入（导入后仍需校验）。

#### 11.5.1 格式二：JS 脚本音源（沙箱 Runtime）

导入 `.js` 时不会把它当作 JSON 解析，而是在**独立沙箱渲染进程**中真正执行：

```
文件 → Source Detector（只判断格式）→ probe（无权限跑一次，读声明）
     → 你确认权限与主机 → 落盘（带 SHA-256）→ 注册 → search/song/playUrl/lyric/cover/…
```

- **隔离**：`sandbox:true` + `contextIsolation:true` + 独立 session。沙箱里没有 `require`、`process`、
  Electron，也没有文件系统；session 在 Chromium 层**拦截所有 http(s)/ws 请求**，
  所以脚本自己的 `fetch` 出不了网，唯一出口是 preload 桥。
- **自研契约**：`globalThis.defineAuroraSource({ search, getSongDetail, getPlayUrl, getLyric, getCover,
  getAlbum, getArtist, getPlaylist, getLeaderboard, healthCheck })`，方法最后收到
  `api = { http, request, config, permissions, sourceId }`；也可用全局 `globalThis.auroraRequest`。
- **洛雪兼容层（best-effort）**：`globalThis.lx` = `{ EVENT_NAMES, on, send, request, utils, env, version,
  currentScriptInfo }`；`send(EVENT_NAMES.inited, { sources })` 被解读为平台/能力/音质声明；
  `musicUrl` / `lyric` / `pic` 映射到 Aurora 的播放/歌词/封面。`utils.crypto.md5` / `sha1` 是**同步**实现
  （签名要直接拼进 URL），并与 `node:crypto` 交叉验证；AES/RSA/HMAC 走桥。
- **崩溃与卡死隔离**：每次调用都有超时，超时直接丢弃宿主窗口，下一次调用自动重建；
  渲染进程崩溃只影响它自己。一个音源卡死不会冻结播放器，也不会拖住其他音源的聚合搜索。
- **篡改检测**：文件哈希与导入时不一致时，音源进入“需要重新确认”状态（所有调用明确报错），
  而不是静默执行未审阅的代码。

#### 11.5.2 脚本音源示例（最小可用）

```js
globalThis.defineAuroraSource({
  name: 'My Source',
  version: '1.0.0',
  platforms: [{ id: 'custom', name: '自定义' }],
  qualities: ['128k', '320k'],
  async search(keyword, page, api) {
    const body = await api.request.json(`https://api.example.com/search?q=${encodeURIComponent(keyword)}&page=${page}`)
    return body.data.list
  },
  async getPlayUrl(track, quality, api) {
    const body = await api.request.json(`https://api.example.com/url?id=${encodeURIComponent(track.id)}`)
    return { url: body.data.url, quality: quality || '320k' }
  },
  async getLyric(track, api) {
    const body = await api.request.json(`https://api.example.com/lyric?id=${track.id}`)
    return body.data.lyric
  },
})
```

#### 11.5.3 权限层：安装与联网彻底解耦

- 安装 / 注册 / 启用一个音源**不需要**它声明任何主机；`allowedHosts` 是**已授权集合**。
- 首次请求未授权主机 → 请求被拒（错误码 `PERMISSION`，消息写明主机名）→ 该主机记入**待授权列表**
  （`main/sources/permissions.ts`）→ 音源管理页出现“允许 <host>”按钮 →
  一键授权写入 entry 并**热重载**（无需重启）。
- 请求日志里被拒的请求以 `status: 0` 记录，方便排查“为什么这个音源没数据”。

> 明确不做：不受限的 Node 插件（插件直接 `require` / 访问文件系统 / `child_process`）。
> 沙箱宿主的能力面就是 `http`（经权限层）与 `crypto`，其余一律不可达。

### 11.6 聚合搜索与错误隔离

```ts
// manager.searchAll：并发上限 4，每个音源单独 settle
const outcomes = await mapWithConcurrency(targets, 4, (source) => searchOne(source.id, query, options))
// → [{ sourceId, sourceName, ok, tracks, error?: { code, message }, latencyMs }]
```

- 单个音源失败只会变成一行 `ok: false` 的结果（写入具体错误码），其余音源与本地结果照常渲染。
- 被禁用的音源**根本不会被请求**（下一次搜索立即生效，不需要重启）。
- 错误码：`NETWORK_ERROR` / `TIMEOUT` / `UNAUTHORIZED` / `RATE_LIMITED` / `NOT_FOUND` / `INVALID_RESPONSE` / `UNSUPPORTED` / `NEEDS_CONFIG` / `UNKNOWN`。
- 所有请求统一走 `main/sources/http.ts`：超时、可重试错误的重试、`AbortController` 取消、响应体上限、镜像回退。
- 结果缓存：搜索 60s、推荐/歌单 5min、歌词 30min（`main/cache.ts`，LRU + TTL）。

### 11.7 歌词引擎

歌词来源优先级（`main/lyrics.ts`）：

1. 用户手动导入的 `<userData>/lyrics/<sha1>.lrc`（最高优先级）；
2. 音源插件提供的歌词（仅当该音源声明了 `lyrics` 能力）；
3. 本地音频旁边的同名 `.lrc`（含 `.LRC` / `.Lrc` / `song.mp3.lrc`）；
4. 音频文件内嵌歌词（ID3 USLT / SYLT 等）。

解析在共享层 `shared/lyrics.ts`，主进程与渲染层共用：

- 支持普通文本、`[mm:ss.xx]` 标准 LRC、`<mm:ss.xx>` 逐字增强 LRC、`[offset:±ms]` 校正、
  同一时间戳的第二行自动识别为翻译；
- 渲染层不做自己的计时：`stores/lyrics.ts` 用播放器真实 `currentTime` **二分查找**当前行，
  因此暂停、拖动进度、切歌、单曲循环全部天然同步；
- 有逐字时间轴时逐字高亮，否则自动退化为逐行高亮；
- 点击任意一行会 seek 播放器（歌词页不自带时钟）。

Aurora **不抓取任何未授权的第三方歌词站**；没有歌词时明确显示空状态并提供“导入歌词”。

### 11.8 下载管理器

`main/downloads.ts` + `main/id3.ts`。它只做一件事：把音源解析出的地址变成一个真实文件，并用
**主进程自己的状态**回答进度问题。

```
TrackRow ⇩ → downloadService.start(track) → IPC
  → resolveStream()（主进程自己解析，渲染层看不到媒体地址）
  → 主机授权检查（未授权 → 记入待授权，任务失败并可直接重试）
  → net.fetch(Range: bytes=<已下载>- ) → <名字>.part
  → 写完改名 → （MP3）写入 ID3v2.3 标签
  → download-tasks.json 落盘，downloads:progress 推送
```

几个刻意的设计：

- **进度不是估算的**：`received` 永远等于磁盘上 `.part` 文件的真实字节数，速度由 1 秒采样算出，
  `eta` 由 `(total-received)/speed` 得出；总量只在服务器给了 `Content-Length` 时显示。
- **断点续传**：开始前用 `stat()` 对齐 `.part` 的真实长度（而不是信持久化的计数），
  再发 `Range`；服务器忽规 Range 而返回 200 时宁可从头发也不会拼接出损坏文件。
- **重启后不自动重下**：加载索引时把 `downloading/queued` 降级为 `paused`，用户点“继续”才继续。
- **标签写入只对 MP3**：以**最终文件名**的扩展名判断（工作文件叫 `<名字>.mp3.part`，
  这一条曾经写错并被测试抓到）；其他容器不碰，否则会损坏文件。
- **并发是队列的，不是 UI 的**：修改并发设置后 `pumpDownloads()` 立即重新评估队列。
- **权限与安装解耦**：下载的 Host 检查发生在**发请求时**，不做任何平台/Provider 准入。
- 文件名模板（歌手-歌名 / 歌名-歌手 / 歌名）会清洗 Windows 非法字符，重名自动加 `(2)`。

下载页显示的每一项都来自 `DownloadTask`，按钮只提交状态转换（pause / resume / retry / cancel / remove），
不自己在渲染层算进度，也不可能把失败显示成完成。

### 11.9 路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | Home | 本地音乐概览 |
| `/search` | Search | 多音源统一搜索（全部 / 本地音乐库 / 单音源 Tab） |
| `/lyrics` | Lyrics | 沉浸式歌词页（Teleport 到 body 的全屏层） |
| `/playlist/:id` | Playlist | 音源合集详情，`:id` 为 `<sourceId>:<playlistId>` |
| `/settings` | Settings | 设置总览 |
| `/settings/sources` | Sources | 音源管理（启用 / 排序 / 配置 / 测试连接 / 自定义音源 / 后台健康检查） |
| `/downloads` | Downloads | 下载管理器（任务列表 / 暂停继续重试取消 / 目录与文件名设置 / 打开目录 / 清除已结束） |
| `/library` `/playlists` `/favorites` `/history` | 既有页面 | 保持不变 |
| `/online` | — | 旧单音源页面，已重定向到 `/search` |

### 11.10 运行时分层与音源注册表（架构重构）

详细设计与迁移阶段见 [`docs/SOURCE-RUNTIME-DESIGN.md`](SOURCE-RUNTIME-DESIGN.md)。当前已落地：

- **统一注册表**（`main/sources/registry.ts`）：内置 / 声明式 / 脚本三种音源共用一份 `SourceEntry` 列表，
  新增一种音源种类不再需要改 IPC / preload / service / 设置页；
- **统一持久化**（`main/sources/store.ts`）：`<userData>/sources/sources.json`，首次启动自动把旧的
  `custom-sources.json` 迁成 `kind: 'declarative'` entry（旧文件保留不动，便于降级）；
- **契约扩展**：`getPlayUrl(track, quality)` / `getSongDetail` / `getCover` / `getAlbum` / `getArtist` 已加入
  `MusicSource`（全部可选，回退由 manager 负责），`ResolvedStream.quality`、`AudioTrack.platform`、
  `AudioTrack.metadata`（脚本源解析所需的原始载荷，IPC 侧限制 4KB）；
- **能力缺口断言**：声明了 `albums` 却没有 `getAlbum` 的音源会被注册时捕获，写进错误日志并在设置页提醒 ——
  不再出现「UI 显示了按钮但一定失败」；
- **诊断出口**：每个音源都有错误日志（操作名 + 错误码，最新在前，上限 20 条）与全局请求日志
  （URL / 状态码 / 耗时，上限 50 条，白名单拒绝记为 status 0）。

> Script Runtime（沙箱宿主 + `lx` shim）与音源管理页的分区导航已完成；详见第 11.5 节与
> [`docs/LX-PARITY-ROADMAP.md`](LX-PARITY-ROADMAP.md)。

### 11.11 测试覆盖

`npm run smoke:sources`（144 项）中的最后 30 项是下载管理器：本地起一个限速且真正支持 `Range`
的服务，逐项断言真实文件、断点续传、模板、ID3 标签、并发、重启恢复、权限拒绝与失败隔离。
最强的证据在打包用例里：在真实 UI 上点 ⇩，然后由测试进程自己 `stat()` 用户数据目录里的文件。

`npm run smoke:scripts`（56 项）用真实的本地 HTTP 服务 + 真实的沙箱宿主跑完整链路：
探测与安装（无授权也能装）、未授权主机被拒并记入待授权、一键授权后热重载、
真实 search/getSongDetail/getPlayUrl/getLyric/getCover、中继地址真的能读到音频字节（206 + Content-Type）、
沙箱无 `require`/`process`/`module`、脚本自身 `fetch` 被会话层拦下、错误数据得到 `INVALID_RESPONSE`、
死循环被超时强杀且宿主可重建、洛雪风格脚本全链路（服务端校验同步 md5 签名）、启停 / 篡改检测 / 重载 / 删除 /
重启后从 `sources.json` 恢复。`npm run smoke:sources`（144 项，联网样板用例额外 2 项）覆盖：远程中继（Range / 未授权 token）、音源注册表与能力模型、
**公网 HTTP（非回环）媒体地址必须被中继**（见 `checkMediaUrl`）、聚合搜索的局部失败隔离、
启用/禁用的即时生效、能力门控、健康检查、
LRC 解析（逐行 / 逐字 / 翻译 / offset）、二分查找同步与用户歌词缓存，以及自定义音源的完整链路：
校验失败用例、字段映射、时长单位、封面白名单（SSRF）、流中继、推荐、歌单详情、聚合参与、
禁用即时生效、导出/重新加载、删除后不再可用；加上声明式模板能力（字段 URL 模板真的可获取、
从文件清单里挑选 + 空格文件名的编码、无可用文件时报 `NOT_FOUND`）与内置样板的校验。

洛雪音源库导入在 `smoke:scripts` 里有一整段（10 项）：用**真实编码**（`gz_` + base64 + zlib deflate，
而不是 gzip）构造库文件，断言 gz 解出来的脚本真被执行并声明平台、库里的名称优先于脚本内声明、
坏脚本被标记但**仍然可安装**（安装与运行是两个阶段，调用时才报错）、无法解码的条目会被列出但不会写盘、
预览不写任何东西、同 id 条目不会互相覆盖、导入后的音源立刻能搜索并解析出真实音频字节。

`npm run smoke:app`（72 项）在**打包后的应用**上验证 preload 桥接、IPC 往返、路由、音源注册表、
脚本音源通道与打包内真实探测（宿主 preload 是否真的被打进产物）、待授权主机通道、安装/JS/API 三分区 UI、
后台健康检查开关、音源种类 / 权限 / 请求日志通道、自定义音源的 IPC 校验 / 编辑器渲染 / 样板载入，
以及搜索 / 音源管理 / 歌词真的渲染出来。

这条用例还会把渲染层的控制台与未捕获异常标上 `[page]` 打印出来 —— 否则失败会完全沉默。它抓到过一个
真实 bug：store 把 Vue 响应式数组（`ref([]).value`）作为参数交给 contextBridge，Electron 报
`An object could not be cloned.`，而 `ipcRenderer.invoke` 在这种情况下**不会 reject，而是永远不 resolve**，
于是「确认安装」按钮永远停在“安装中…”。修法是 `services/aurora.ts` 的 `plain()`：所有交给桥接的
UI 载荷先深度解包成普通对象 / 数组。**写新的 IPC 调用时，参数不要直接传响应式对象。**

打包用例的最后一段是最强断言，也是产品链路的最小验收：通过真实 UI 走「粘贴 → 识别内容 → 授权主机 →
确认安装」装进一个 JS 音源，然后在搜索页输入关键词、点播放，等播放器自己的时钟真的走动
（脚本 → 沙箱运行时 → 权限桥 → 本地 HTTP → 媒体中继 → `<audio>` 解码），并验证歌词真的取得、
删除后注册表真的不再包含它。

系统集成那一关断言的是**操作系统真的接受了什么**，而不是开关回显自己：`trayActive` 来自活动的
`Tray` 句柄、`mediaKeys` 来自 `globalShortcut` 实际占用、tooltip 等于正在播放那首；
然后通过真实设置页把媒体键关掉（断言真的释放）再打开（断言再次占用），以及托盘真的销毁与重建。

最后是**重启**关卡：关掉主窗口（断言进程真的退出，不留幽灵进程）→ 用同一个 profile 重新启动 →
断言脚本音源仍在注册表里（从 `sources.json` + 磁盘脚本恢复，不需要重装）、收藏与队列快照仍在、
播放栏真的显示上次那首。这就是「重启后 Source / 收藏 / 队列仍然存在」的自动化版本。

想单独重跑：`npm run build:dir && npm run smoke:app`。

### 11.12 系统集成（托盘 / 任务栏按钮 / 媒体键）

三个能力放在 `main/systemIntegration.ts`，因为它们对用户来说是同一件事的三个面：
**不切换窗口就能控制播放**。它们全部通过 `sendPlayerCommand`（`desktopLyrics.ts`）下发，
也就是桌面歌词窗口用的那条通道 —— 从“应用窗口之外的一次点击”到 `<audio>` 元素只有一条路径。

两条设计规则值得写下来：

1. **托盘不是第二个真相源。** tooltip 与菜单首行渲染的是渲染层上报的 `ReportedPlayerState`，
   所以托盘上显示的曲目不可能与播放栏不一致。
2. **UI 显示的是“真的注册了什么”，不是开关状态。** `system-integration:status` 返回
   `trayActive`（读活动的 `Tray` 句柄）、`mediaKeys`（实际占用的加速键）、`taskbarButtons`、
   `trayTooltip`。托盘创建失败（例如没有 status-notifier 的 Linux 会话）或媒体键已被其他应用占用时，
   设置页会显示“未生效”，而不是一个勾上但什么都没做的开关。

`main/mediaGlyphs.ts` 负责图标：托盘与任务栏按钮需要图片，而 Aurora **不带任何图片资源** ——
它在运行时画出来（4× 超采样后降采样做抗锯齿），自己编码成真 PNG（IHDR/IDAT/IEND + zlib + CRC32，RGBA）。
这样做既避开了“每个 DPI 都要重新生成一套资源”，也避开了搬运参考播放器那套受版权保护的图标。
`smoke:media` 里 5 项断言直接量它：PNG 签名与 IHDR 尺寸、`nativeImage` 能解码、
不透明像素数量在合理区间、32px 托盘图标、五个图标都不是空白。

没有自动化的部分说清楚：**真实按下媒体键**无法在 CDP 里合成（那是操作系统层面的按键），
所以测试断言的是注册与释放，以及命令通道本身（已由桌面歌词窗口的播放/暂停按钮实测覆盖）。

关于“关窗即退出”：目前主窗口关闭就是退出应用（重启恢复的测试依赖这个语义），
所以托盘提供的是“隐藏 / 显示窗口”与后台控制，而不是“关窗后继续放歌”。若要改成最小化到托盘，
需要同时改启动/退出语义与重启用例。

设置持久化为 `systemIntegration` 块（`systemIntegration: { tray, taskbarButtons, mediaKeys, showTrackInTray }`，settings 版本 v5）。

### 11.13 洛雪兼容层的保真度（为什么它必须是“真宿主”）

一个已发布的音源只会在“宿主真的像洛雪”时才能跑。实测下来，下面每一条都曾经是真实故障：

| 宿主行为 | 音源实际依赖的东西 | 不同则报什么错 |
| --- | --- | --- |
| `lx.on(lx.EVENT_NAMES.request, handler)` | 请求确实从 handler 走 | “没有注册请求处理器” |
| `lx.send(EVENT_NAMES.inited, { sources })` | 平台 / actions / qualitys 声明 | 一切能力都探不到 |
| 事件名可以未知 | 新版本音源会用新事件（`showConfigView` 等） | 报错并中断初始化 |
| `lx.request(url, opts, cb)` | 回调形状 + `statusCode` + `body` + **`raw`** | 解析/签名失败 |
| `lx.utils.crypto` | **同步** md5/sha1（服务端会验签） | 签名不过，接口拒绝 |
| `lx.utils.buffer` / `zlib` | 真 Buffer 语义 + 解压 | 解包失败 |
| `lx.currentScriptInfo.rawScript` | 脚本原文（部分音源拿它做服务端签名） | 鉴权失败 |
| 未知 `action` 不能是致命错 | 音源自己报“不支持该操作” | 健康检查误报“连接失败” |
| `musicInfo` 同时给新旧两种形状 | 老一代音源读 `songmid` / `hash`，新一代读 `meta.*` | 拿不到 id，只能回落到前缀 id（`kw_228908`），于是请求错歌或 404 |

最后两行对应两个已修的真实 bug：

1. **健康检查曾在没有 `action` 的情况下调用 `request`** —— 于是一个完全正常的音源在安装后被报「连接失败：action not support: undefined」。就绪性属于运行时，不属于请求：现在 `healthCheck`/`describe` 在本地答复。
2. **解析出来的媒体地址曾被端点规则校验** —— `checkEndpointUrl` 要求非回环必须 HTTPS，而聚合接口大量返回 `http://`，导致每个请求都报「播放地址不是合法的 http(s) 地址」。现在媒体地址走 `checkMediaUrl`（只看协议），端点也不再强制 HTTPS。**测试盲区值得记住**：所有 fixture 都用 `127.0.0.1`，恰好被旧的 HTTPS 规则豁免，所以 143 项全绿也漏了它 —— 现在有一条专门用公网 HTTP 地址的回归用例。

### 洛雪音源库导入（`scriptSources/lxLibrary.ts`）

洛雪把全部音源存在一份 `LxDatas/user_api.json`，而不是每源一个 `.js`。格式是 `script: "gz_" + base64(zlib deflate)`
（前缀叫 gz，实际是 **zlib**，`78 9c`）。兼容三种存储形态（`{userApis:[]}` / 裸数组 / `id → 载荷` 映射）
与三种压缩形态（zlib / raw deflate / gzip），以及纯文本脚本。

关键设计：**文件由主进程选并读取，预览只回摘要，导入只传 id**。
所以渲染层从头到尾拿不到那 1MB 可执行文本，被写进磁盘的字节就是主进程从磁盘读到的字节 ——
不存在“预览 A、导入 B”的窗口。预览会对每个音源**真实跑一次**（无授权、同普通导入），
因为有用的问题不是“这是不是 JavaScript”，而是“它能不能起来、声明了哪些平台”。

### 三个渲染器、三个 preload（注意选对 CDP target）

Aurora 现在有三种页面目标，打包用例必须显式区分，否则断言会跑在错误的窗口上：

| 窗口 | URL 特征 | 桥 |
| --- | --- | --- |
| 应用主窗口 | `.../index.html` | `window.aurora`（全部能力） |
| 桌面歌词窗口 | `.../desktop-lyrics.html` | `window.auroraLyrics`（**只有四个通道**） |
| 脚本音源宿主 | `data:text/html,...` | `window.auroraSourceHost`（沙箱，仅出网桥） |

桌面歌词窗口是刻意分开的：它有自己的 HTML 入口与 preload，加载不到 app 的 store / router /
音源运行时，也拿不到库、文件系统。歌词本身由**主进程**解析（复用 `main/lyrics.ts` 的四级优先级），
窗口只负责渲染主进程推过来的时钟与文本 —— 播放状态没有第二个真相源。

位置、字号、配色、锁定等都存在主进程 settings（`desktopLyrics` 块，v3 schema），
所以重启后窗口会自己回到原位；锁定用的是 `setIgnoreMouseEvents(true, { forward: true })`，
点击会直接穿透到下面的窗口。

| Phase 11 | 全量测试 | 进行中（媒体管线、音源系统、自定义音源均已自动化测试） |
