<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AudioTrack, ConvertFormat } from '../../../shared/types'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'
import { describeAudio } from '../utils/audio'

/**
 * The two per-file tools behind the track context menu: editing ID3 tags and transcoding.
 *
 * Both go through the main process (`library:set-tags` / `library:convert`) and both report the real
 * result. There is no optimistic UI here: a tag write that the file rejected, and a conversion with no
 * ffmpeg on the machine, are shown as failures with the reason.
 */
const props = defineProps<{
  track: AudioTrack
  mode: 'tags' | 'convert'
}>()

const emit = defineEmits<{
  (event: 'close'): void
}>()

const library = useLibraryStore()
const ui = useUiStore()

const busy = ref(false)
const error = ref('')

const title = ref(props.track.title)
const artist = ref(props.track.artist)
const album = ref(props.track.album)
const format = ref<ConvertFormat>('mp3')

watch(
  () => props.track.id,
  () => {
    title.value = props.track.title
    artist.value = props.track.artist
    album.value = props.track.album
    error.value = ''
  },
)

const isMp3 = computed(() => props.track.format.toUpperCase() === 'MP3')
const ffmpeg = computed(() => library.ffmpeg)

const formats: ConvertFormat[] = ['mp3', 'flac', 'wav', 'm4a', 'ogg']

async function saveTags(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await library.writeTags({
      id: props.track.id,
      title: title.value.trim(),
      artist: artist.value.trim(),
      album: album.value.trim(),
    })
    if (!result.ok) {
      error.value = result.error ?? '写入标签失败'
      return
    }
    ui.notify(`已写入标签：${props.track.title}`, 'success')
    emit('close')
  } finally {
    busy.value = false
  }
}

async function runConvert(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await library.convert(props.track.id, format.value)
    if (!result.ok) {
      error.value = result.error ?? '格式转换失败'
      return
    }
    ui.notify(`已转换为 ${format.value.toUpperCase()} 并加入音乐库`, 'success')
    emit('close')
  } finally {
    busy.value = false
  }
}

void library.refreshFfmpeg()
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal-card">
      <header class="modal-head">
        <div>
          <h2>{{ mode === 'tags' ? '修改 ID3 标签' : '格式转换' }}</h2>
          <p class="muted small-text">{{ track.title }} · {{ describeAudio(track) }}</p>
        </div>
        <button class="icon-button" title="关闭" @click="emit('close')">✕</button>
      </header>

      <template v-if="mode === 'tags'">
        <p v-if="!isMp3" class="notice-card subtle">
          <span class="notice-icon">!</span>
          <span>只有 MP3 文件能直接重写标签；当前文件是 {{ track.format.toUpperCase() }}。</span>
        </p>
        <label class="field">
          <span>标题</span>
          <input v-model="title" type="text" :disabled="!isMp3" />
        </label>
        <label class="field">
          <span>艺术家</span>
          <input v-model="artist" type="text" :disabled="!isMp3" />
        </label>
        <label class="field">
          <span>专辑</span>
          <input v-model="album" type="text" :disabled="!isMp3" />
        </label>
      </template>

      <template v-else>
        <p class="muted small-text">
          转换会在原文件旁生成新文件并立即加入音乐库，原文件不会被删除。需要本机安装 ffmpeg。
        </p>
        <p v-if="!ffmpeg.available" class="notice-card subtle">
          <span class="notice-icon">!</span>
          <span>
            未检测到 ffmpeg。请安装后重试（可用环境变量 AURORA_FFMPEG_PATH 指定路径）。
            <template v-if="library.ffmpeg.path"> 当前检查路径：{{ library.ffmpeg.path }}</template>
          </span>
        </p>
        <label class="field">
          <span>目标格式</span>
          <select v-model="format">
            <option v-for="item in formats" :key="item" :value="item">{{ item.toUpperCase() }}</option>
          </select>
        </label>
      </template>

      <p v-if="error" class="tool-error">{{ error }}</p>

      <footer class="modal-actions">
        <button class="ghost-button" @click="emit('close')">取消</button>
        <button
          v-if="mode === 'tags'"
          class="primary-button"
          :disabled="busy || !isMp3"
          @click="saveTags"
        >
          {{ busy ? '写入中…' : '保存标签' }}
        </button>
        <button
          v-else
          class="primary-button"
          :disabled="busy || !ffmpeg.available"
          @click="runConvert"
        >
          {{ busy ? '转换中…' : '开始转换' }}
        </button>
      </footer>
    </section>
  </div>
</template>
