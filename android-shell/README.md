# Aurora Music · 安卓套壳（验证版）

把桌面版的 Vue 界面原封不动装进 Capacitor 安卓壳里运行：渲染层零改动，靠
`shim/aurora-shim.js` 在 WebView 里实现桌面版的 `window.aurora` 桥接接口。

## 已接通

- 全部页面与导航、主题、设置（localStorage 持久化）
- 本地曲库：系统文件选择器导入，music-metadata 解析标签，音频存 IndexedDB
- 本地播放：blob URL 喂给渲染层自带的播放引擎
- 歌词：与音频同名、一起选入的 `.lrc` 文件自动配对，沉浸歌词逐行同步
- 收藏 / 歌单 / 最近播放：渲染层自身的本地存储，天然可用

## 未接通（与桌面版的差异）

- 在线音乐：五平台只显示目录，搜索/解析返回「暂未接入」（解析引擎在桌面主进程）
- 脚本音源 / 自定义音源、下载、桌面歌词、系统集成、HTTP API：均为占位实现

## 构建

GitHub Actions（`.github/workflows/android-apk.yml`）在云端完成全部构建，
不需要本地 Android SDK：

1. 下载 v0.1.0 发布里的源码包，`electron-vite build` 出渲染层
2. `npm run build:shim` 打包桥接层，`scripts/prepare-www.mjs` 组装 `www/`
   （渲染层 + 种子数据 `seeds/` + 桥接注入 index.html）
3. `cap add android` + `gradle assembleDebug` 出调试签名 APK
4. APK 发布到预发布 `android-shell-v0.1.0`，手机上直接下载安装

本地组装 www（不打 APK）也可以：

```bash
npm ci
npm run build:shim
node scripts/prepare-www.mjs <渲染层 out/renderer 路径> ./seeds
```
