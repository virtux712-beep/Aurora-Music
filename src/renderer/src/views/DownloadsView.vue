<script setup lang="ts">
import { computed, onMounted } from 'vue'
import type { DownloadSettings, DownloadTask } from '../../../shared/types'
import { useDownloadStore } from '../stores/downloads'
import { useUiStore } from '../stores/ui'
import { coverStyle as buildCoverStyle } from '../utils/cover'
import { formatCount } from '../utils/format'

/**
 * The download manager page.
 *
 * Every number here is the main process's own report — the store only mirrors `DownloadTask`, and
 * every button forwards a transition (`pause` / `resume` / `retry` / `cancel`) instead of setting a
 * local flag. The "已完成" state in particular cannot be faked: it only appears once a task has
 * really been renamed into place on disk.
 */
const downloads = useDownloadStore()
const ui = useUiStore()

const templates: Array<{ value: DownloadSettings['nameTemplate']; label: string }> = [
  { value: 'artist-title', label: '歌手 - 歌名' },
  { value: 'title-artist', label: '歌名 - 歌手' },
  { value: 'title', label: '歌名' },
]

onMounted(async () => {
  downloads.init()
  await Promise.all([downloads.refresh(), downloads.loadSettings()])
})

const directoryLabel = computed(() => {
  const configured = downloads.settings?.directory?.trim()
  return configured || '应用数据目录下的 downloads 文件夹'
})

const busy = (task: DownloadTask): boolean => downloads.busyId === task.id

function coverStyle(task: DownloadTask): Record<string, string> {
  return buildCoverStyle(task.cover, task.id)
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(size >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatSpeed(task: DownloadTask): string {
  if (task.status !== 'downloading' || task.speed <= 0) return task.status === 'downloading' ? '连接中…' : '—'
  return `${formatBytes(task.speed)}/s`
}

function formatEta(task: DownloadTask): string {
  if (task.status !== 'downloading' || task.eta <= 0) return '—'
  const seconds = Math.round(task.eta)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`
}

const STATUS_LABELS: Record<DownloadTask['status'], string> = {
  queued: '排队中',
  downloading: '下载中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

async function patch(patchValue: Partial<DownloadSettings>): Promise<void> {
  await downloads.saveSettings(patchValue)
}

async function reveal(task: DownloadTask): Promise<void> {
  const ok = await downloads.reveal(task.id)
  if (!ok) ui.notify('无法定位该文件', 'error')
}
</script>

<template>
  <div class="view">
    <header class="view-header">
      <div>
        <h1>下载</h1>
        <p class="muted">
          真实落盘的下载任务：进度、速度与剩余时间都来自正在写入磁盘的传输
          <template v-if="downloads.active.length > 0">
            · 共 {{ formatCount(downloads.active.length) }} 个进行中（合计 {{ formatBytes(downloads.totalSpeed) }}/s）
          </template>
        </p>
      </div>
      <div class="view-actions">
        <button class="ghost-button" @click="downloads.openDirectory()">打开下载目录</button>
        <button class="ghost-button" :disabled="downloads.finished.length === 0" @click="downloads.clearFinished()">
          清除已结束
        </button>
      </div>
    </header>

    <section class="section-block">
      <div class="section-heading">
        <div>
          <h3>下载设置</h3>
          <p>保存位置、文件名格式与并发数量</p>
        </div>
      </div>
      <div class="download-settings">
        <div class="download-field">
          <span class="download-label">保存目录</span>
          <div class="download-dir">
            <code :title="downloads.settings?.directory || ''">{{ directoryLabel }}</code>
            <button class="ghost-button small" @click="downloads.chooseDirectory()">更改…</button>
          </div>
        </div>
        <label class="download-field">
          <span class="download-label">文件名格式</span>
          <select
            class="download-select"
            :value="downloads.settings?.nameTemplate ?? 'artist-title'"
            @change="patch({ nameTemplate: ($event.target as HTMLSelectElement).value as DownloadSettings['nameTemplate'] })"
          >
            <option v-for="item in templates" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <label class="download-field">
          <span class="download-label">同时下载</span>
          <select
            class="download-select"
            :value="downloads.settings?.concurrency ?? 2"
            @change="patch({ concurrency: Number(($event.target as HTMLSelectElement).value) })"
          >
            <option v-for="count in [1, 2, 3, 4, 5, 6]" :key="count" :value="count">{{ count }}</option>
          </select>
        </label>
        <label class="download-field download-toggle">
          <input
            type="checkbox"
            :checked="downloads.settings?.writeTags ?? true"
            @change="patch({ writeTags: ($event.target as HTMLInputElement).checked })"
          />
          <span>写入标签（MP3：标题 / 歌手 / 专辑 / 封面）</span>
        </label>
      </div>
    </section>

    <section class="section-block">
      <div class="section-heading">
        <div>
          <h3>任务</h3>
          <p>{{ formatCount(downloads.tasks.length) }} 个任务</p>
        </div>
      </div>

      <div v-if="downloads.tasks.length === 0" class="empty-state">
        <p>还没有下载任务。</p>
        <p class="muted">在「在线音乐」的歌曲行上点击 ⇩ 即可下载到本地音乐库。</p>
      </div>

      <ul v-else class="download-list">
        <li v-for="task in downloads.tasks" :key="task.id" class="download-row" :class="task.status">
          <span class="download-cover" :style="coverStyle(task)"></span>
          <div class="download-meta">
            <strong>{{ task.title }}</strong>
            <small>
              {{ task.artist }}<template v-if="task.album"> · {{ task.album }}</template>
              <em v-if="task.quality || task.requestedQuality" class="badge-source">{{ task.quality || task.requestedQuality }}</em>
              <em v-if="task.tagged" class="badge-source">已写入标签</em>
            </small>
            <div class="download-progress" :class="task.status">
              <span :style="{ width: `${Math.round(downloads.progressOf(task) * 100)}%` }"></span>
            </div>
            <small class="download-stats">
              <span class="download-status">{{ STATUS_LABELS[task.status] }}</span>
              <span>{{ formatBytes(task.received) }}<template v-if="task.total > 0"> / {{ formatBytes(task.total) }}</template></span>
              <span>{{ formatSpeed(task) }}</span>
              <span v-if="task.status === 'downloading'">剩余 {{ formatEta(task) }}</span>
              <span v-if="task.error" class="download-error">{{ task.error }}</span>
              <span v-else-if="task.fileName" class="download-path" :title="task.filePath">{{ task.fileName }}</span>
            </small>
          </div>
          <div class="download-actions">
            <button
              v-if="task.status === 'downloading' || task.status === 'queued'"
              class="ghost-button small"
              :disabled="busy(task)"
              @click="downloads.pause(task.id)"
            >
              暂停
            </button>
            <button
              v-if="task.status === 'paused'"
              class="ghost-button small"
              :disabled="busy(task)"
              @click="downloads.resume(task.id)"
            >
              继续
            </button>
            <button
              v-if="task.status === 'failed' || task.status === 'canceled'"
              class="ghost-button small"
              :disabled="busy(task)"
              @click="downloads.retry(task.id)"
            >
              重试
            </button>
            <button
              v-if="task.status === 'completed'"
              class="ghost-button small"
              @click="reveal(task)"
            >
              在文件夹中显示
            </button>
            <button
              v-if="task.status === 'downloading' || task.status === 'queued' || task.status === 'paused'"
              class="ghost-button small"
              :disabled="busy(task)"
              @click="downloads.cancel(task.id)"
            >
              取消
            </button>
            <button class="icon-action danger" title="移除任务" :disabled="busy(task)" @click="downloads.remove(task.id)">✕</button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
