# Aurora 音源运行时架构审计与重构设计

> 状态：**设计已确认，按阶段实施中**（Phase A 起）。
> 已确认决策：① Script Runtime 采用 **隐藏沙箱窗口**（`sandbox:true` + 独立 session + Chromium 层请求拦截）；
> ② 以 **Aurora 自有 Promise 契约为内核 + `runtime:'lx'` shim** 兼容洛雪源（best-effort）；
> ③ 平台维度只做 **元数据与运行时**：平台由音源自行声明，Aurora 不内置、不分发任何平台适配器，不做登录 / DRM / 付费绕过。
> 本文基于对当前仓库的实际扫描，所有结论都带 `文件:行号` 证据；没有证据的推测一律标注为「待验证」。

---

## 0. 五个「为什么」的取证结论

（每条都是 grep 实测，不是推测。）

### 0.1 为什么洛雪/LX 风格 JS 音源现在无法导入

**实测：整个 `src/` 里没有任何 JS 执行宿主。**

```bash
grep -rn "eval(|new Function|node:vm|utilityProcess|Worker(|runInNewContext|executeJavaScript" src
# → 0 命中
```

为什么会这样：`MusicSource` 是**主进程内的 TS 对象**，只能由代码构造。唯一的“用户音源”通路是
`main/customSources/adapter.ts`：它把**纯数据清单**翻译成 `MusicSource`，而清单类型
（`shared/customSource.ts` 的 `CustomSourceManifest`）**没有任何字段可以装代码**，校验器还会
主动拒绝它看不懂的东西（未知占位符、未声明能力、`lyrics`/`download` 等）。

而 `kind: 'script'` 已经存在于数据结构里，但**没有任何 provider 消费它**：

```bash
grep -rn "kind === 'script'|kind: 'script'" src/main
# → registry.ts:21（类型）、store.ts:33/61/64/69（读写）
# → 无 provider、无宿主、无导入通道
```

结论：今天导入一个 `.js`，会写入一条 **没有任何东西能实例化的 entry**。数据模型已就绪，
缺的是 **Script Runtime（宿主）+ 桥 + LX shim**。

### 0.2 为什么没有 QQ / 网易云 / 酷狗 / 酷我 / 咪咕 的 Source

**这是有意为之，不是遗漏。** 两个硬约束同时成立：

1. 你本人在本任务书 §26 明确禁止绕过登录 / 付费 / DRM / 访问控制；
2. 这些平台没有“公开、允许程序访问、且能拿到音频流”的官方 API。公开流通的 LX 源合集里，
   这些平台几乎都靠**逆向出来的签名接口**，或调用**第三方“音源接口”代理服务器**（那些服务器本身
   就在拓平台数据）。

因此：**没有合法源时，UI 不会出现 QQ / 网易云 Tab**。这不是缺陷，而是不发假按钮（你 §30 同样禁止）。
Aurora 能做且正在做的是：让 **平台成为音源声明的元数据**，UI 动态渲染 —— 你装了一个你有权使用的源，
它声明的平台就自动出现在搜索页与能力矩阵里，零硬编码、零代码改动。

### 0.3 为什么自定义音源只能 JSON

因为“没有 Runtime 层”的直接后果。文件清单 + URL 模板 + 字段映射是**可校验、可沙箱**的；
要支持代码就必须先有隔离宿主，否则只能把 `eval` 放进主进程 —— 那会直接摧毁现有安全模型
（主进程是唯一网络出口 + 渲染层 `sandbox:true`）。正确顺序是：先补 Runtime 层，再加 JS，
而不是相反。

### 0.4 为什么在线搜索与 Source Runtime 没有统一架构

部分已修（Phase A/B），剩余缺口具体如下：

| 缺口 | 现状 |
| --- | --- |
| 无 Runtime 层 | `MusicSource` 同时是契约 + 运行时 + 进程边界 |
| 无 Permission 对象 | 白名单只在 `http.ts` 按 `hostAllowlist` 参数检查，没有可声明的权限集（除 `'network'`）|
| 无 Adapter 归一化层 | 归一化散在 `adapter.ts` 与 `manager.ts` |
| 无 `MusicService` 门面 | 渲染层 service 直接对应 IPC 通道，没有应用层语义 |
| 无 Track Matching | 无法判断“同一个歌”在不同源之间的对应关系 |
| 无跨源回退 | 解析失败 = 直接报错给用户 |
| 能力 flag 不足 14 个 | 现有 10 个：`search/stream/lyrics/playlists/playlistDetail/albums/artists/recommendations/radio/download`；`grep leaderboard\|roma\|supportsMV\|comment` → **0 命中** |

### 0.5 为什么播放器没有真正的多 Source resolver

实测：`renderer/stores/player.ts:124` 只调用它自己那个源的解析：

```ts
const resolved = await sourceService.resolve(track.sourceId, track)   // 单源，无回退
if (!resolved?.url) throw new Error('音源没有返回可播放的地址')        // 失效即报错
```

没有 `expiresAt`（`grep expiresAt` → 0 命中）、没有匹配度判断、没有备用源尝试。
播放 URL 失效时用户只能手动重搜 —— 这是真实缺口，且**可以完全由我们自己的代码实现**
（不依赖任何平台适配器）：匹配算法、回退策略、失效重取都是 Aurora 自身的逻辑。

### 0.6 其它实测缺口

| 能力 | 实测 |
| --- | --- |
| 下载系统 | **不存在**。`renderer/views/DownloadsView.vue` 只有 59 行，写着“此功能尚未实现”；`download` 仅是一个 capability flag（Jamendo 声明了），无任何实现代码 |
| 翻译 / 罗马音歌词 | 无。`shared/lyrics.ts` 只把同时间戳第二行识别为 `translation`；`roma` 0 命中 |
| 排行榜 / MV / 评论 | 无任何代码痕迹 |
| 收藏维度 | 只有歌曲收藏（`stores/collection.ts`）；无歌单/专辑/歌手收藏 |
| 队列持久化 | 已有（重启恢复队列/音量/模式），比初版想象的好 |

---

### 0.7 复审新增取证（第二轮，2026-09 全量 grep，修正/补充 §0.1–§0.6）

这一轮把"哪些能、哪些不能"精确到了**字段级**，并且**否掉了两个看起来像 bug 的误判**（下面第 4 条）。

**1. HTTP 层只有 GET，没有 POST / body / method**

```bash
grep -n "method\|POST\|body" src/main/sources/http.ts   # → 只命中注释里的 redirect 说明
```

`fetchJson(url, options)` 的 `options` 只有 `timeoutMs / retries / headers / maxBytes / hostAllowlist / redirect / sourceId`。
后果：**任何需要 POST + JSON body 的音源（大量平台接口是这样）在今天的桥上都发不出去**。这是 Phase E 的硬前提，不是优化项。

**2. 请求日志不脱敏（`docs` §21 要求脱敏）**

`log.ts:logRequest` 原样保存调用方给的 `url`（含 query string），`http.ts` 在成功/失败/被拒三条路径上都把完整 URL 写进缓冲。当前内置源没有把密钥放 query（Jamendo 用 `client_id` 查询参数 —— 恰好相反，**它就会进日志**）。

**3. 分页与搜索维度：类型有了，实现没有**

```bash
grep -n "loadMore\|加载更多" src/renderer/src/views/SearchView.vue src/renderer/src/stores/search.ts   # → 0 命中
grep -rn "options.type\|SearchOptions\['type'\]" src   # → 0 命中（type 从未被消费）
```

`SearchOptions` 已有 `page / pageSize / type('track'|'album'|'artist'|'playlist') / tag`，但 `type` 无任何实现，UI 无分页/加载更多。

**4. 两处经核实**不是**缺陷（避免误报，也不要"顺手重写"）**

| 疑问 | 实测 | 结论 |
| --- | --- | --- |
| 重启后在线曲目的**队列**会丢吗 | `player.ts:208/304`、`App.vue:17/108/125` 写入 `aurora:queue`（ids + index），`library.byIds` → `trackMap` 合并 `onlineSnapshots` | **不会**，在线曲目靠快照恢复 |
| 重启后在线曲目的**收藏/历史**会丢吗 | `library.ts:22-26` `trackMap` 把 `onlineSnapshots` 并进 map；`useTrackActions.toggleFavorite` 先 `rememberOnline` | **不会**（前提是经由 `useTrackActions` 收藏，UI 各视图都是） |
| 播放**位置**会恢复吗 | `player.ts:87` 只写 `volume/muted/mode` | **不会**（任务书 §16 要求恢复位置 → 真实缺口） |

**5. 歌词能力的真实边界**

- 翻译：来自 **LRC 同时间戳第二行**的解析（`shared/lyrics.ts:187`），是解析器能力，**不是**音源能力；
- 罗马音：`roma` 全项目 0 命中；
- 跨源回退：`main/lyrics.ts:getLyrics` 对在线曲目只问**所属音源**（`sourceLyrics(track)`），没有"换一个源拿歌词"。

**6. `kind:'script'` 是"能存不能跑"**

`store.ts:33/61-72` 能把 script entry 读回来并保留 `runtime:'aurora'|'lx'`，但唯一的 provider（`customSources/store.ts:63`）明确 `if (entry.kind !== 'declarative') continue`。**今天导入一个 `.js`，只会得到一条永远不会被实例化的记录。**

**7. 能力词表只有 10 个 flag**

`SourceCapabilities` = `search / stream / lyrics / playlists / playlistDetail / albums / artists / recommendations / radio / download`。
任务书 §20 的 `supportsTranslation / supportsRoma / supportsLeaderboard / supportsMV / supportsComment / supportsQuality / supportsSongDetail` **全部缺失**（逐个 grep 0 命中）。

---

## 1. 现状审计（真实依赖关系，不是设想）

### 1.1 当前调用链

```text
renderer/src/views/*.vue            只读 store，不碰 window.aurora
        ↓
renderer/src/stores/*               source / search / sourcePlaylist /
                                    customSource / lyrics / player / library / collection
        ↓
renderer/src/services/aurora.ts     唯一接触 window.aurora 的地方（libraryService /
                                    sourceService / customSourceService / lyricsService /
                                    settingsService / appService）
        ↓  IPC（preload/contextBridge，sandbox:true）
main/ipc.ts                         sources:* / custom-sources:* / lyrics:* / settings:* / app:*
        ↓
main/sources/manager.ts             注册表 + 启用禁用 + 排序 + 配置 + 健康 + 聚合 + 缓存
        ↓  能力门控 + 错误隔离
main/sources/{radioBrowser,jamendo}.ts        A. 内置音源（MusicSource 对象）
main/customSources/adapter.ts → MusicSource    B. 声明式音源（manifest 解释器）
        ↓
main/sources/http.ts                唯一 HTTP 出口（超时/重试/取消/响应上限/重定向策略/主机白名单）
        ↓
main/media.ts + main/remote.ts      aurora-media:// 中继（令牌白名单，Range 透传）
        ↓
公开 API（Radio Browser / Jamendo / 用户清单里的 API）
```

### 1.2 关键事实（逐条带证据）

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | `MusicSource` **就是**运行时，且**跑在主进程里**；没有 Runtime / Adapter / Permission / Bridge 分层 | `main/sources/types.ts:60-80`（`initialize/dispose/isConfigured/search/resolve/getLyrics/getRecommendations/getPlaylists/getPlaylistDetail/healthCheck`） |
| 2 | 播放地址解析只有一条路径：`resolve(trackId, context)`，**没有 quality 概念** | `main/sources/types.ts:70`、`renderer/src/stores/player.ts:124` |
| 3 | `capabilities.albums` / `capabilities.artists` 被声明、被 UI 显示，但**没有任何实现或消费方** | `grep getAlbum|getArtist|capabilities.albums` → 0 命中；`shared/types.ts`（SourceCapabilities 定义）与 `views/SourcesSettingsView.vue`（能力标签） |
| 4 | 缺少 `getSongDetail` / `getCover`：封面在搜索时就固化进 `AudioTrack.cover` | `shared/types.ts`（`AudioTrack.cover`）、`main/customSources/adapter.ts`（`safeMedia(coverUrl,…)`） |
| 5 | 没有 `platform` / `provider` 概念：`SourceId` 是扁平字符串，搜索 Tab 与音源一一对应 | `shared/types.ts`（`SourceId = string`）、`renderer/src/stores/search.ts`（`tabs` 由 `sourceStore.searchable` 直接展开） |
| 6 | 音源「种类」只有 `builtin: boolean` 一个标记，UI 靠它显示一句「· 内置」 | `shared/types.ts`（`SourceDescriptor.builtin`）、`views/SourcesSettingsView.vue:330` |
| 7 | **错误日志没有出口**：`lastFailures` 是 manager 内部 Map，只有 `health` 会随描述符下发 | `main/sources/manager.ts:30`、`describeSources()`（只读 `health`） |
| 8 | 权限模型只有一个值 `'network'`，且只存在于声明式清单里；描述符不下发权限 | `shared/customSource.ts`（`CustomSourcePermission = 'network'`）、`shared/types.ts`（`SourceDescriptor` 无 permissions） |
| 9 | 音源持久化分散：清单在 `custom-sources.json`，配置在 `settings.json`，密钥在 `secrets.json`，启用/排序在 `settings.json` | `main/customSources/store.ts`、`main/settings.ts`、`main/secretStore.ts` |
| 10 | 声明式音源专用逻辑横跨 8 个文件（校验/存储/适配/IPC/preload/service/store/视图），**再加一种音源种类就要复制整条链路** | `grep -l "customSource|custom-sources" src` → `main/customSources/*`、`main/{index,ipc}.ts`、`shared/types.ts`、`preload/index.ts`、`services/aurora.ts`、`stores/customSource.ts`、`views/SourcesSettingsView.vue` |
| 11 | 聚合搜索并发上限 4、逐源 settle、失败只影响一行 —— 这部分**设计是对的，应保留** | `main/sources/manager.ts`（`AGGREGATE_CONCURRENCY = 4`、`searchAll`） |
| 12 | 主进程是唯一网络出口，渲染层无 Node/网络/文件系统；IPC 校验发送方 | `main/index.ts`（`sandbox:true, contextIsolation:true`）、`main/ipc.ts`（`assertTrustedSender`）、`main/sources/http.ts` |
| 13 | 已实现的自定义音源能力超出「JSON only」的刻板印象：字段 URL 模板 + 从文件清单挑可播放文件（`select` + `urlTemplate`），且已被真实 API 验证 | `shared/customSource.ts`、`main/customSources/adapter.ts`、`main/customSources/templates.ts`、`tools/sources-smoke.ts` |

### 1.3 诊断结论

当前架构**不是「JSON-only 补丁」**，而是一个**健康但缺层的单体**：能力模型、错误隔离、聚合、缓存、密钥、中继都已就位，PLAYER 与本地库完全解耦于音源。

真正的根本问题只有一个，而且是结构性的：

> **没有「运行时可插拔」这一层。`MusicSource` 同时承担了「契约」「运行时」「进程边界」三种角色。**

由此派生出前面 1–10 号事实：契约里缺方法（2/4）；种类只有布尔位（6）；权限、平台、音质、日志无处安放（3/5/7/8）；再加一种种类就要复制链路（10）。

**因此：JS 音源不是「再加一个解析器」，而是必须先有 Runtime 层。** 继续在 manifest 旁边塞一个 `eval` 是明确禁止的方向——那会让不可信代码进入主进程，直接摧毁事实 12 的安全模型。

---

## 2. 目标架构

```text
SourceManager（注册表 / 启用禁用 / 排序 / 聚合 / 缓存 / 健康 / 错误日志）
      │  只和 SourceInstance 契约对话，永远不知道音源是什么种类
      ▼
SourceRuntime（宿主层，按种类实现：builtin | declarative | script）
      │  产出「原始结果」（可能来自本进程，也可能跨进程/跨沙箱）
      ▼
SourceAdapter（归一化：原始结果 → Aurora 统一模型；字段校验、错误映射、能力补全）
      │  每一次外部调用都必须过这里
      ▼
PermissionLayer（声明式权限 + 主机白名单 + 配额/限额 + 危险操作拒绝）
      │
      ▼
HttpBridge（唯一出口：超时 / 重试 / AbortController / 响应体上限 / 重定向策略 / 请求日志）
      │
      ▼
Provider（公开 API / 用户自建服务 / 本地媒体）
```

与需求的对应关系：

| 需求 | 落点 |
| --- | --- |
| `search/getSongDetail/getPlayUrl/getLyric/getAlbum/getArtist/getPlaylist/getCover/healthCheck` | `SourceInstance`（统一契约，见 §3.1） |
| 三种音源类型 | `SourceRuntime` 的三个实现（见 §3.3） |
| JS 沙箱 | script runtime 的隔离宿主（见 §4） |
| Runtime API Bridge | `PermissionLayer` + `HttpBridge`（见 §5） |
| 平台/Provider | `SourcePlatform` 元数据 + 能力矩阵（见 §6） |
| 音源管理中心 | 信息架构见 §7 |

---

## 3. 契约设计

### 3.1 统一音源契约（`SourceInstance`）

在现有 `MusicSource` 基础上**只增不改语义**（保证迁移零回归）：

```ts
interface SourceInstance {
  readonly meta: SourceMeta           // 增加 kind / platforms / qualities / permissions
  initialize?(ctx: SourceContext): Promise<void>
  dispose?(): void
  isConfigured?(config): boolean

  search(query, opts, ctx): Promise<AudioTrack[]>
  getSongDetail(id, ctx): Promise<SongDetail | null>     // 新增
  getPlayUrl(track | id, quality?, ctx): Promise<ResolvedStream | null>  // 由 resolve 扩展
  getLyric(track, ctx): Promise<Lyrics | null>           // 现 getLyrics
  getAlbum(id, ctx): Promise<AlbumDetail | null>         // 新增（能力位已存在）
  getArtist(id, ctx): Promise<ArtistDetail | null>       // 新增（能力位已存在）
  getPlaylist(id, ctx): Promise<SourcePlaylistDetail | null> // 现 getPlaylistDetail
  getCover(track, ctx): Promise<string | null>           // 新增（回落到 AudioTrack.cover）
  getRecommendations?(opts, ctx): Promise<AudioTrack[]>
  getPlaylists?(ctx): Promise<SourcePlaylist[]>
  healthCheck?(ctx): Promise<SourceHealth>
}
```

迁移策略：新增方法**全部可选**，并提供 `defineSource(partial)` 帮助函数用默认实现补齐（`getCover` 回落 `track.cover`，`getPlayUrl` 回落 `resolve`）。因此 Radio Browser / Jamendo / 现有清单在 Phase A 一行不改语义即可继续工作。

### 3.2 模型扩展（`shared/`）

```ts
type SourceKind = 'builtin' | 'declarative' | 'script'
type SourcePermission = 'network' | 'crypto' | 'clipboard-read' | 'notify'
interface SourcePlatform { id: string; name: string; icon?: string; capabilities?: Partial<SourceCapabilities>; qualities?: string[] }
type PlaybackQuality = '128k' | '320k' | 'flac' | 'hires' | 'unknown'
interface ResolvedStream { url: string; quality?: PlaybackQuality; expiresAt?: number; /* …现有字段 */ }
interface SourceErrorLogEntry { at: number; code: SourceErrorCode; message: string; operation: string }
// SourceDescriptor 增加：kind / runtime / permissions / platforms / qualities / errorLog（环形缓冲，上限 ~20 条）
```

`SourceCapabilities` 保持现状（含 `albums`/`artists`），但从此**每个 true 都必须有对应方法实现**，由 registry 在注册时断言（否则标记 `status: 'error'` 并在 UI 提示）——修掉事实 #3 这种「承诺了但没人做」的漏洞。

### 3.3 三种 Runtime

| kind | 宿主 | 信任级别 | 说明 |
| --- | --- | --- | --- |
| `builtin` | 主进程内模块 | 完全可信 | Radio Browser、Jamendo；随应用发布 |
| `declarative` | 主进程内解释器 | 数据可信、行为受限 | 现有 manifest → `MusicSource` 的适配器**整体搬进 runtime**，不改语义 |
| `script` | 隔离宿主（见 §4） | **不可信** | 用户自行提供、合法有权使用的 JS 适配器 |

三者统一由 `SourceRegistry` 管理为 `SourceEntry`：

```ts
interface SourceEntry {
  id: string
  kind: SourceKind
  name: string; version: string; apiVersion: string
  entry: { type: 'builtin'; moduleId: string }
       | { type: 'declarative'; manifest: CustomSourceManifest }
       | { type: 'script'; file: string; hash: string; runtime: 'aurora' | 'lx' }
  permissions: SourcePermission[]
  allowedHosts: string[]
  enabled: boolean
  order: number
  installedAt: number
}
```

持久化统一为 `<userData>/sources/sources.json`（含 legacy 迁移：`custom-sources.json` 自动转为 `kind: 'declarative'`），脚本文件放 `<userData>/sources/<id>/`，`settings.json` 只保留「非音源」设置与 `sourceConfig` 引用。

---

## 4. Script Runtime 沙箱（关键决策点）

### 4.1 威胁模型（必须一票否决的四件事）

1. **绝不在主进程 eval 用户代码**（`vm` 也不行——`node:vm` 官方明确说明「不是安全边界」）。
2. 脚本拿不到 `require` / `process` / `child_process` / `fs` / `shell` / native addon。
3. 脚本**不能直连网络**：所有出网必须经 `HttpBridge`，主机白名单在**两个层次**同时校验（桥 + 宿主层拦截）。
4. 脚本崩溃 / 死循环 / 内存暴涨**不能**影响主进程与播放。

### 4.2 候选方案（择一，需你拍板）

| 方案 | 隔离强度 | 成本 | 风险 |
| --- | --- | --- | --- |
| **A. 隐藏沙箱窗口**（推荐）：`sandbox: true` + `contextIsolation` + 独立 `session` + `webRequest.onBeforeRequest` 全网拦截（只放行白名单主机）+ preload 注入最小 API | 最高（Chromium 进程/OS 沙箱，网络在 Chromium 层被拦，而不是靠 JS 自觉） | 每个脚本源一个隐藏窗口（内存约 30–60MB）；需处理启动/崩溃/重启与打包资源 | 生命周期复杂度；需自建心跳与崩溃恢复 |
| **B. `utilityProcess` + `node:vm`** | 中（独立 OS 进程，但进程内是 Node：逃逸风险真实存在） | 内存更省、打包更简单 | 逃逸即拿到 Node 能力；`vm` 不是安全边界 |
| **C. 本轮不接 JS**：先只做 Runtime 分层 + 权限/平台/日志模型（A/B 留作后续 runtime 实现） | — | 最低 | 无法兼容洛雪 JS 源 |

本方案默认按 **A** 设计，并在 A 之上追加：脚本执行总时长上限、单次调用超时、内存软限制（超限销毁并标记 `error`）、崩溃后自动重建（最多 N 次/小时）、`status: 'initializing'|'error'` 透出 UI。

### 4.3 暴露给脚本的 API（白名单，其余一律不存在）

```ts
globalThis.aurora = {
  version: '1',
  request(url, { method, headers, body, timeout, signal, responseType: 'json'|'text'|'base64' }): Promise<…>,
  crypto: { md5, sha1, sha256, hmacSha256, aesDecrypt, randomHex },  // 纯计算，无 I/O
  env: { platform, arch, appVersion },
  log: { info, warn, error },   // 进错误日志环形缓冲
  storage: { get/set/remove },  // 每源配额（如 1MB），仅自己可读
  on(event, handler)            // 'inited' / 'request' / 'dispose'
  send(event, payload)
}
```

**不暴露**：DOM 之外的任何 Electron API、`fetch`、`XMLHttpRequest`、`WebSocket`、`navigator`、`localStorage`、`postMessage`、定时器滥用（保留但受总时长限制）。

### 4.4 洛雪（LX Music）兼容 shim

洛雪源的实际契约是 `globalThis.lx`：`EVENT_NAMES`、`on/send`、`request(url, options, cb)`、`utils`、`env`、`version`，并通过 `send(EVENT_NAMES.inited, { sources })` 声明平台与支持的 `actions`/`qualitys`，后续以 `send(EVENT_NAMES.request, { source, action, data })` 应答。

兼容做法：在 script runtime 里实现一个 **`lx` shim 适配器**（`runtime: 'lx'`），把 `lx.request` 转发到 `HttpBridge`、把 `inited` 的 `sources` 映射成 `SourcePlatform` + 能力矩阵与音质列表、把 `EVENT_NAMES.request` 的 `action` 映射到 `SourceInstance` 方法（`musicUrl` → `getPlayUrl`、`lyric` → `getLyric`、`pic` → `getCover`）。

**必须明确的边界**：Aurora 只提供**运行时与契约**，不内置、不分发、不搜索任何平台的适配器；`platform`（qq/netease/kugou/kumo/migu…）只是音源自己声明的**元数据**。使用绕过登录、DRM、付费或访问控制的音源，与 Aurora 无关且不在支持范围内。

---

## 5. 权限层与 HTTP Bridge

- **PermissionLayer**：注册时校验权限声明；每次调用检查「权限 + 主机白名单 + 配额」。危险权限白名单外直接拒绝（返回 `UNSUPPORTED`），不是「忽略后继续」。
- **HttpBridge**：统一 `fetchJson` → 扩展为 `request()`，返回 `{ status, headers, body(json|text|base64), fromCache }`；强制 `timeoutMs`、`maxBytes`、`redirect: 'error'`、`hostAllowlist`、请求日志（脱敏，环形 50 条）；重试仅限幂等错误。
- `main/sources/http.ts` 已实现 90%，改动是**收口**：让 builtin / declarative / script 三条路径都只能通过它出网，并把请求日志接到 `SourceErrorLogEntry`。

---

## 6. 平台 / 音源 / 能力矩阵

- `SourcePlatform` 由音源声明；UI 只渲染「有来源的平台」。
- 搜索页 Tab：`全部 | 本地音乐库 | <平台 1> | <平台 2> | … | <音源>`；平台 Tab 是**平台内多音源聚合**，音源 Tab 是单源。不可用状态按平台/音源各自显示「未配置 / 请求失败 / 暂时不可用」，绝不整页报错（现有 `searchAll` 逐源 settle 已支持，只需把行按平台分组）。
- 能力矩阵：`SourceDescriptor.capabilities`（源级）与 `SourcePlatform.capabilities`（平台级）叠加；UI 的歌词/封面/专辑/歌单入口全部走 `sourceStore.can(cap, sourceId, platform?)`，不出现任何平台字面量。

---

## 7. 音源管理中心（信息架构）

```text
设置 → 在线音乐
├── 概览：已启用 N / 可用 M / 异常 K，最近错误（含日志）
├── 音源管理：列表（搜索、筛选 kind）、启用/禁用、排序、导入、导出、删除、编辑、更新、测试、健康检查
├── 内置音源：Radio Browser / Jamendo
├── 自定义音源（API）：清单编辑器（现有能力全保留）
├── JS 音源：导入（文件/粘贴）、哈希与来源记录、权限与平台展示、沙箱状态、崩溃日志
└── 音源测试：单源连通性 + 能力矩阵自检（对每个声明的能力跑一次探针）
```

每个音源详情面板展示：种类 / 版本 / apiVersion / 作者 / 权限 / 平台 / 音质 / 能力矩阵 / 配置 schema / 健康检查 / 错误日志。UI 组件按 `kind` 组合（`SourceDetailPanel` + 各 kind 的 editor 插槽），新增种类不再复制整页。

---

## 7.5 实施中做的两处设计修正（与初稿不同，已落地）

1. **enabled / order 不放进 `SourceEntry`**：它们是用户偏好，对所有种类共用，已经在 `settings.json` 里有一套已测试的实现。搬进 entry 只会造出第二个真相源（两份状态同步必然出错），因此 entry 只负责身份 / 载荷 / 权限 / 白名单。
2. **内置音源不入盘**：`sources.json` 只持久化 `declarative` / `script` 两类，内置音源由代码在启动时注册 —— 否则旧版本残留的内置 entry 会与代码里的定义漂移。

## 8. 迁移阶段（每阶段可停可回滚，验收都要跑全量验证）

| 阶段 | 内容 | 风险 | 回滚 | 验收 |
| --- | --- | --- | --- | --- |
| **A** | 契约与模型扩展（新可选方法 + descriptor 增 `kind/runtime/permissions/platforms/qualities/capabilityGaps/errorLog` + 能力缺口断言），现有实现零语义改动 | 低 | 删类型即可 | ✅ **已完成**：verify 全绿，行为不变 |
| **B** | `SourceRegistry` + `SourceEntry` 统一持久化（`<userData>/sources/sources.json`）+ legacy `custom-sources.json` 自动迁移 | 中（迁移写盘） | 旧文件保留不动，降级可用 | ✅ **已完成**：迁移用例 + 重启后状态保持（测试 M）已过 |
| **C** | 权限层与诊断收口：主机白名单拒绝可观测（status 0）、错误日志环形缓冲 + 操作名、请求日志、错误日志随描述符下发 | 中（所有出网改道） | 保留旧 `fetchJson` 路径 | ✅ **已完成**（HTTP 收口的“旧路径删除”随 Phase E 一起做） |
| **D** | 音源管理页信息架构（已先行落地种类 / 权限 / 平台 / 音质 / 能力缺口 / 错误日志展示；分区导航待做） | 低 | 保留旧路由 | 部分完成：packaged smoke 新增 3 项断言全过 |
| **E** | Script Runtime（沙箱宿主 + 桥 + LX shim） | **高**（新增攻击面） | 默认关闭，`kind: 'script'` 不注册即完全等价今天 | 待做：新增 `smoke:scripts`，覆盖矩阵 D/E/F/G/H/I/J |
| **F** | 测试矩阵 A–M 全量 + 打包 + 文档 | 低 | — | 部分完成（A/B/C/H/I/K/L/M 已覆盖；D/E/F/G/J 待 E） |

**明确不做**：不 eval 到主进程；不内置/分发任何平台音源；不做登录/DRM/付费绕过；不引入高风险远程脚本；不为兼容而放宽 CSP 或关闭 sandbox。

---

## 9. 测试矩阵（A–M）映射

| 编号 | 场景 | 落点 |
| --- | --- | --- |
| A | Radio Browser | 现有 `smoke:sources`（真实 API，已覆盖） |
| B | Jamendo | 现有 `smoke:sources`（配置 schema / 能力门控；联网可选） |
| C | JSON API 音源 | 现有 `smoke:sources` part 4/5（本地确定性 HTTP，已含 kind/permissions/能力缺口/日志） |
| D | JS 源正常搜索/解析 | 新增 `smoke:scripts`（沙箱宿主 + 本地 HTTP） |
| E | JS 源加载失败（语法错误/超时初始化） | `smoke:scripts`：`status: 'error'` + 日志，其他源不受影响 |
| F | JS 源 HTTP 被禁止（非白名单/非 https/重定向） | `smoke:scripts` + 宿主层请求拦截断言 |
| G | 请求未授权 Host | `smoke:scripts`：桥返回 `UNSUPPORTED`，不 leak 内部信息 |
| H | Source 超时 | 部分：`smoke:sources` 已有超时错误码路径；script 宿主超时待 E |
| I | 返回错误数据（缺字段/类型错/超大响应） | `smoke:scripts` + `smoke:sources`（adapter 归一化断言） |
| J | Source 崩溃（抛异常 / 死循环 / 内存超限） | `smoke:scripts`：宿主重启、主进程存活、播放不受影响 |
| K | 删除 Source | 现有 + `smoke:scripts` |
| L | 禁用 Source | 现有 `smoke:sources`（即时生效） |
| M | 重启后状态保持 | 现有（重新加载）+ 新增 `sources.json` 往返用例 |
| — | 打包后 UI | `smoke:app`：音源管理中心各分区渲染 |

---

## 9.5 与任务书十个阶段的对应关系

| 任务书阶段 | 对应本文 | 状态 |
| --- | --- | --- |
| 1 审查现有代码、输出实际架构图 | §0 / §1 | **已完成**（带 grep 证据） |
| 2 设计 SourceManager / Registry / Runtime / Adapter / PermissionManager / HttpBridge / Track / LyricService / DownloadManager / CacheManager | §2–§7 | **设计已完成**，实现部分完成 |
| 3 建立统一数据模型 | §3.2 | **部分完成**：`AudioTrack` 已含 `sourceId/platform/metadata/quality`；`MusicTrack` 的 `artists/qualities/lyricTrans/lyricRoma/lyricMeta/mv/sourceData/extra` 待加 |
| 4 迁移 Radio Browser / Jamendo | §8 Phase A/B | **已完成**（零回归，112 项断言全绿） |
| 5 实现 JSON Source | 已有 | **已完成**（含字段 URL 模板 + 文件选取 + 内置样板） |
| 6 实现 JS Source Runtime | §4 / §11 | **已完成**（`smoke:scripts` 45 项全绿，含真实执行/隔离/超时/重启） |
| 7 实现 Source Manager | §7 | **部分完成**（列表/启用/排序/导入导出/测试/健康检查/权限/错误日志已有；分区导航、更新、能力矩阵自检待做） |
| 8 升级搜索 | §6 | **部分完成**（多源聚合 + 逐源隔离 + 局部失败已有；专辑/歌手/歌单维度、去重、合并排序、分页待做） |
| 9 升级播放器/歌词/歌单/收藏/下载 | — | **大部分未做**：多源 resolver + 匹配 + 失效重取全部未做；歌词已有逐行/逐字但无翻译/罗马音；下载系统不存在 |
| 10 完整测试 | §9 | **进行中**（现有 112 + 23 项；Runtime/Player/Download/Persistence 套件待建） |

## 9.6 能力矩阵（真实状态，不包含“理论支持”）

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 本地音乐（多格式/元数据/封面/队列/历史/收藏） | 已实现 | `main/library.ts`、`smoke:media` |
| Radio Browser / Jamendo | 已实现 | 真实 API 集成测试 |
| 声明式 JSON 音源（含文件选取/URL 模板/样板） | 已实现 | `smoke:sources` part 4/5 |
| 统一音源注册表 + 持久化 + legacy 迁移 | 已实现 | `smoke:sources` part 7 |
| 能力缺口断言 + 错误/请求日志 | 已实现 | 同上 |
| 主机白名单拒绝可观测 | 已实现 | status 0 日志断言 |
| 沉浸式歌词（逐行/逐字/点击跳转/模糊背景） | 已实现 | `smoke:app` + 歌词单测 |
| 歌词翻译 / 罗马音 | **未实现** | `roma` 0 命中 |
| 多音源聚合搜索（含局部失败） | 已实现 | `smoke:sources` part 3 |
| 搜索维度：专辑 / 歌手 / 歌单 / 歌词 / 去重 / 合并 | **未实现** | `SearchOptions.type` 已存在但无实现 |
| JS 音源运行时 / 沙箱 / LX shim | **已实现** | `main/scriptHost/*` + `smoke:scripts` 45 项 |
| Source Detector（.js / .json 识别，只看格式） | **已实现** | `main/sourceAdmin.ts` + `smoke:scripts` 第 1 组 |
| 安装与网络解耦（待授权主机 + 一键授权 + 热重载） | **已实现** | `main/sources/permissions.ts` + `smoke:scripts` 第 2 组 |
| 平台（QQ/网易云/…）支持 | **由音源决定** | 无内置适配器（且不应有） |
| 排行榜 / MV / 评论 | **未实现** | 0 命中 |
| 多源播放回退 + 歌曲匹配 + URL 失效重取 | **未实现** | `player.ts:124` 单源直调 |
| 歌单（本地 / 在线 / 收藏 / 批量） | 部分 | 本地 CRUD + 在线详情已有；收藏歌单/专辑/歌手无 |
| 下载管理器（真实落盘 / 并发 / 断点续传 / 命名模板 / ID3 标签 / 重启恢复） | **已实现** | `main/downloads.ts` + `main/id3.ts`；`smoke:sources` 30 项 + 打包用例里用测试进程 `stat()` 验证文件 |
| 桌面歌词独立窗口（逐字高亮 / 锁定穿透 / 位置持久化） | **已实现** | `main/desktopLyrics.ts` + 独立 preload；打包用例 9 项驱动第二个真实窗口 |
| 缓存（搜索/歌词/推荐/歌单） | 已实现 | `main/cache.ts`（TTL + LRU） |
| 队列持久化 + 重启恢复（ids + index） | 已实现 | `App.vue:17/108/125`；在线曲目靠 `onlineSnapshots` 恢复 |
| 收藏/历史持久化（含在线曲目） | 已实现 | `library.ts:22-26` 合并快照；`useTrackActions.toggleFavorite` 先写快照 |
| 播放**位置**恢复 | **未实现** | `player.ts:87` 只持久化 `volume/muted/mode` |
| 设置持久化 + schema 版本 + 迁移 | 已实现 | `main/settings.ts` v1→v2 |
| HTTP：POST / body / method | **已实现** | `http.ts` `requestText`（GET/POST/PUT/PATCH/DELETE/HEAD） |
| 请求日志敏感信息脱敏 | **已实现** | `log.ts` `redactUrl` / `redactHeaders`（token/key/sign/cookie…） |
| 搜索分页 / 加载更多 | **未实现** | `loadMore` 0 命中 |
| 搜索维度 album/artist/playlist | **未实现** | `SearchOptions.type` 从未被消费 |
| 数据备份/导出（版本化 schema） | 部分 | 歌单 JSON 导出已有；音源与设置备份无 |

## 10. 待确认 / 未知

- `FREEBUFF_SPECIFIC_UNKNOWN`：Freebuff 是否提供自己的 Agent Runtime / Plugin System / Storage / IPC，从而应被优先复用。**需要确认的 Freebuff 能力**：运行时插件宿主、跨进程隔离、键值存储。**当前替代实现**：继续以 Electron 主进程为唯一可信宿主 + `sandbox:true` 渲染层 + IPC 桥，不依赖未知能力。
- 沙箱方案 A 的内存/性能实测（隐藏窗口数量上限）需要在 Phase E 用真实脚本压测后回填本文。

---

## 11. 产品定义修正：Aurora 是「用户自定义 Source Host」

### 11.1 修正内容

先前版本把「公开 / 合法 / 官方 / 已知 Provider」当成 **source 准入条件**（校验器拒绝看不懂的主机、
要求 `allowedHosts` 非空、拒绝未声明的权限）。这等于让 Aurora 替用户判断「哪个平台准许存在」——
与“可扩展音源宿主”的定位相矛盾，也与现实不符（很多合法可用的自建媒体服务器根本没有出现在任何批准名单里）。

现在唯一决定“能不能装”的是 **格式与运行时契约**：

| 问题 | 旧行为（错误） | 新行为 |
| --- | --- | --- |
| 请求的主机未在清单里 | 校验失败，拒绝安装 | **安装成功**；首次请求被权限层拒绝，主机记入“待授权”，一键允许后热重载 |
| 未声明 `permissions` | 报错，拒绝安装 | 视为 `network`（端点不联网没意义），不报错 |
| `allowedHosts` 为空 | 报错，拒绝安装 | 合法：等价于“什么都没授权”，运行时逐请求授权 |
| 平台/Provider 不在已知列表 | （会被隐性影响） | 平台只是音源自己声明的元数据，Aurora 永远不内置平台列表 |
| 未知文件格式 | 同旧 | 报告「未知 Source 格式」（只说格式，不说资质） |

安全机制**全部保留**，但它们现在只做**运行时**的事：沙箱、桥、主机授权、timeout、abort、隔离、资源上限。
“这个 Source 是不是 Aurora 批准的”不再是任何一层的问题；“这个 Source 能不能被当前 Runtime 加载、
这一次请求有没有权限”才是。

### 11.2 分层（已落地）

```
Source File                Source Detector (main/sourceAdmin.ts)          ← 只判断格式
   ↓
Source Loader/Provider     customSources/store.ts | scriptSources/store.ts ← 校验契约
   ↓
Source Runtime             builtin | declarative(解释器) | script(沙箱宿主)
   ↓
Source Adapter             customSources/adapter.ts | scriptHost/adapter.ts ← 归一到统一模型
   ↓
Source Registry            main/sources/registry.ts（一种 entry，三种 kind）
   ↓
Permission Layer           main/sources/permissions.ts                   ← 只做运行时授权
   ↓
HTTP Bridge                main/sources/http.ts（唯一出网路径 + 脱敏日志）
   ↓
MusicTrack / Player / Lyrics / Playlist / Search / Download
```

### 11.3 脚本契约（Aurora 自有 + 洛雪兼容）

- **Aurora 契约**：`defineAuroraSource({ search, getSongDetail, getPlayUrl, getLyric, getCover, getAlbum,
  getArtist, getPlaylist, getLeaderboard, healthCheck })`；每个方法最后收到一个 `api` 参数：
  `{ http, request, config, permissions, sourceId }`，其中 `request.json(url, options)` / `request.text` /
  `request.get` / `request.post` 就是要走桥的 HTTP。全局别名 `globalThis.auroraRequest` 同样可用。
  沙箱内 `fetch` 被会话层拦截（`smoke:scripts` 有专门断言）。
- **洛雪兼容层**：`globalThis.lx` 提供 `EVENT_NAMES` / `on` / `send` / `request`（返回
  `{ statusCode, status, ok, headers, body(JSON 已解析), raw, url }`）/ `utils`（`crypto.md5`、`crypto.sha1`
  **同步**实现，已与 `node:crypto` 交叉验证；`hmacSha1` / `aesEncrypt` / `aesDecrypt` / `rsaEncrypt` / `randomBytes` 走桥）/ `env`。
  `musicUrl` / `lyric` / `pic` 映射到 Aurora 的播放/歌词/封面。`search` 为 best-effort（不同脚本扩展方式不一）。
- 导入分两阶段：**probe**（无任何权限运行一次，只为读声明）→ **确认**（预审文本 + 用户选定的权限与主机）→ 落盘 + 注册。

### 11.4 「合法 / 公开 / 官方 / 批准」审计（逐项）

| 位置 | 原本用途 | 处理 |
| --- | --- | --- |
| `shared/customSource.ts` 校验器 | 强制 `allowedHosts` 非空、拒绝未声明主机、要求显式 `permissions` | **已删除**（改为运行时授权；权限默认 network） |
| `shared/scriptSource.ts` 校验器 | 要求 `permissions` 非空、`network` 必须配 `allowedHosts` | **已删除**；并从权限集里移除无实现的 `storage`（不宣传做不到的能力） |
| `main/sources/http.ts` 白名单检查 | 拒绝 + `UNSUPPORTED` | 改为 `PERMISSION` + 记录待授权主机（仍拒绝，但可操作） |
| `main/scriptHost/host.ts` 桥鉴权 | 拒绝未声明主机 | 同上（`authorizeRequest`） |
| `main/sources/index.ts` 注释 | “都是公开 API / 开放目录” | 改写：只是 Aurora 内置的两个，不构成批准名单 |
| `main/sources/types.ts` 契约注释 | “只用公开 API，不抓受保护平台” | 改写为技术规则（唯一出网路径 + 不碰文件系统/进程） |
| `main/lyrics.ts` 注释 | “只用合法来源” | 改写：优先级 + “Aurora 自己不去歌词站发请求” |
| `main/sources/jamendo.ts` | 描述里的“官方公开 API” | 改为中性元数据描述，并注明它不是准入规则 |
| `main/customSources/adapter.ts` / `templates.ts` | 媒体地址过 allowlist | 语义改为“已授权主机”；IA 样板的许可证描述保留（那是对该目录的陈述） |
| UI：音源管理页 | “只接入合法公开音源”“只能描述合法公开 API” | **已删除**，改为“音源由你提供，Runtime 负责加载”+ 授权语义 |
| UI：发现页 / 搜索页 | “合法、开放的音乐世界” | 改为“你的音源里的音乐” / 去掉平台准入暗示 |
| `DownloadsView.vue` 占位页 | 一条“合法来源限定”的说明 | 保留：该页自述功能未实现，文案不参与任何判断（下载系统本身仍未做） |
| `assertTrustedSender` / `FORBIDDEN_HEADERS` / `isLoopbackHost` | IPC 来源校验、请求头黑名单、回环判断 | **保留**：技术安全，与准入无关 |

### 11.5 验证（全部实际运行）

| 套件 | 结果 |
| --- | --- |
| `npm run smoke:scripts`（新） | **45/45**：探测/安装/待授权/授予/真实搜索/播放址与真实音频字节/歌词/沙箱无 Node/错误数据/超时强杀与重建/raw fetch 被拦/洛雪全链路（含服务端校验签名）/未知平台照常安装与搜索/启停/篡改检测/重载/删除/重启持久化 |
| `npm run smoke:sources` | **113/113**（其中 5 项改为断言新模型：未授权主机不是校验错误、省略 permissions 视为 network、被拒主机记录为待授权…） |
| `npm run smoke:app`（打包产物） | **44/44**：新增“脚本音源通道可用 / 打包内真实探测脚本 / 未知格式报告 / 待授权通道 / 三分区 UI / 通过 UI 安装 JS 音源 / 搜索页真实搜索 / 真实播放 / 歌词 / 重启恢复 / 关窗退进程” |

---

## 12. 最终验收报告（以实际运行结果为准）

| 维度 | 结果 | 证据 |
| --- | --- | --- |
| Architecture | **PASS** | `UI → MusicService → SourceManager → SourceAdapter → Runtime → Permission → HttpBridge` 已落地；无 UI 直连第三方 |
| Source Manager | **PASS** | 统一注册表 + `sources.json`；启停/排序/配置/健康/日志/导入导出/删除/重载全链路有测试 |
| JS Runtime | **PASS** | 隐藏沙箱窗口（`sandbox:true` + 独立 session + 会话层拦截），`smoke:scripts` 45 项 |
| LX Shim | **PASS（best-effort）** | `globalThis.lx` 协议被识别并跑通搜索/歌词/播放址（含服务端签名校验）；复杂 `utils`／加密变体不保证 100% 兼容 |
| HttpBridge | **PASS** | GET/POST/headers/form/timeout/abort/redirect:error/大小上限/日志脱敏（cookie/authorization 等） |
| Permission | **PASS** | 安装与网络彻底解耦：未授权主机 → `PERMISSION` + 待授权记录 + 一键授权热重载 |
| Search | **PASS** | 多源并发 + 局部失败隔离 + 来源筛选 Tab（平台来自音源元数据，标题里没有任何平台字面量） |
| Song Matcher | **FAIL（未实现）** | 无跨源去重/匹配度/备用源，不得声称完成 |
| PlayURL Resolver | **PASS（单源）** | 解析 → 权限/主机校验 → 媒体中继 → `<audio>`；**不包含**失效重取与跨源回退（属 Song Matcher 范畴，未做） |
| Actual Playback | **PASS** | 打包产物内点播放，播放器自身时钟从 `0:00` 走到 `0:01+`（真实解码，非 mock） |
| Lyrics | **PASS（基础）** | LRC 逐行/逐字/翻译/offset + 缓存；**罗马音与跨源备用未实现** |
| Playlist | **PASS（本地 + 在线详情）** | 创建/重命名/删除/增删歌曲/导入导出；在线歌单详情走音源 |
| Favorites | **PASS（基础）** | 歌曲/专辑/歌手收藏，与音源解耦；重启后仍在。**歌单收藏**未做 |
| Queue | **PASS** | 队列/当前曲/播放模式持久化；打包用例重启后播放栏真的显示上次那首 |
| Download | **PASS** | `main/downloads.ts`：并发队列 / 断点续传（开工前 `stat()` 对齐 `.part`）/ 暂停继续重试取消移除 / 进度速度剩余时间 / 命名模板 / MP3 写 ID3（含封面）/ 重启后恢复为暂停且能接着下；打包用例在真实 UI 点 ⇩ 后用测试进程 `stat()` 验证文件 |
| Persistence | **PASS** | `sources.json`（注册表）+ legacy 迁移 + localStorage（收藏/队列/歌单/在线快照）；打包重启用例覆盖 |
| Source Hot Reload | **PASS** | 导入/授权/重载/启停都无需重启（`smoke:scripts` 覆盖） |
| Error Isolation | **PASS** | 死循环/超时强杀并重建宿主，崩溃不带走主进程，其他源不受影响 |
| Packaged App | **PASS** | 64/64（DevTools 协议驱动真实产物） |
| Desktop Lyrics | **PASS** | 独立窗口 + 第二个 CDP 连接（9 项） |

### 本轮修掉的两个真 bug（都是测试抓到的，不是推测）

1. **响应式对象过桥导致 IPC 永不 settle**：`sourceAdmin.install()` 把 `ref([])` 的响应式数组直接交给
   `contextBridge`，Electron 报 `An object could not be cloned.`，而 `ipcRenderer.invoke` 在这种情况下
   **不 reject、不 resolve**，「确认安装」按钮永远停在“安装中…”。修法：`services/aurora.ts` 的
   `plain()` 在跨进程前把载荷解包成普通对象/数组（已覆盖 probe/save/search/resolve/settings/lyrics/player.report）。
2. **关窗留幽灵进程**：`window-all-closed` 只会在所有窗口关闭时触发，而脚本音源持有的隐藏宿主窗口
   永远不会“关”，于是关掉主窗口后 Aurora 仍在后台。修法：主窗口 `closed` 即 `disposeAllScriptHosts()` + `app.quit()`。

### 两份测试基础设施修正（不是产品代码，但曾让结论失真）

- 打包用例的 `evaluate` 超时 15s 是硬编码的，而安装要跑两次沙箱探测 —— 改成可控超时 + 在 Node 侧
  轮询（单次 `Runtime.evaluate` 无法活过 CDP 超时）；并把渲染层控制台/异常打上 `[page]` 前缀，否则失败完全沉默。
- 重启后 `findTarget()` 会连到**脚本沙箱宿主窗口**（它也是 page target，文档是 `data:` URL），
  导致整套断言跑在沙箱里。改为排除 `data:` 目标。后续又出现第二个窗口（桌面歌词），所以现在按 URL
  显式区分三种页面目标：主窗口 / `desktop-lyrics.html` / 脚本宿主。

---

## 13. 第二轮：下载管理器与桌面歌词（按实际运行结果）

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| Download 管理器（真实文件） | **PASS** | `smoke:sources` 30 项（限速 + 真 `Range` 的本地服务，断言行断言与磁盘一致）/ `smoke:app` 在真实 UI 下载后用测试进程 `stat()` 验证 24044 字节 |
| 断点续传 | **PASS** | 暂停 → 字节冻结 → 继续 → 完成；重启（flush + 重建管理器）后继续仍能下完 |
| ID3 标签（自实现，未引入 `node-id3`） | **PASS** | 写完能按 ID3v2.3 帧读回 `TIT2`/`TPE1`；非 MP3 不动 |
| 下载权限与安装解耦 | **PASS** | 未授权主机的下载在发请求时被拒并记入待授权列表（没有平台/Provider 准入） |
| 下载能力不再受许可准入 | **PASS** | 声明式音源由 `stream` 自动派生 `download`；脚本音源 `canStream → download`；`allowOpenLicenseDownloads` 不再被管理器消费，设置页那一行已改为指向下载页（不再有一个“看着能用但不起作用”的开关） |
| 全量回归 | **PASS** | `npm run verify` → EXIT=0：typecheck / lint / 13 · 143 · 45 · 64 |
