<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AudioTrack } from '../../../shared/types'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'

/**
 * Bulk metadata editing for a selection from the library.
 *
 * Two things it will not pretend about, because both are limits of the write path rather than of this
 * dialog:
 *
 *  1. **Tags are written into the files, and only MP3 can be rewritten.** `library:set-tags` refuses
 *     anything else (writing a guessed container format is how files get corrupted), so the dialog
 *     counts the MP3s up front and says what will happen to the rest. A selection of FLACs reports
 *     "0 首可写入" instead of closing with a cheerful toast and having changed nothing.
 *  2. **A partial result is a result.** Each file is written on its own, so successes stay applied even
 *     when one file is read-only or has been moved; the failures are listed with their reasons.
 *
 * Because the edit changes the files, the dialog keeps the previous values and offers one-click undo
 * for what it just wrote. That undo lives as long as this dialog does — it is not a general history,
 * and saying otherwise would be a promise the app cannot keep after a restart.
 */
const props = defineProps<{ tracks: AudioTrack[] }>()
const emit = defineEmits<{ (event: 'close'): void }>()

const library = useLibraryStore()
const ui = useUiStore()

const artist = ref('')
const album = ref('')

const busy = ref(false)
const done = ref(false)
const progress = ref({ written: 0, total: 0 })
const failures = ref<Array<{ title: string; error: string }>>([])
/** The values as they were before this dialog wrote anything, for the undo. */
const undoStack = ref<Array<{ id: string; title: string; artist: string; album: string }>>([])

const mp3s = computed(() => props.tracks.filter((track) => track.format.toUpperCase() === 'MP3'))
const skipped = computed(() => props.tracks.length - mp3s.value.length)
const canWrite = computed(() => mp3s.value.length > 0 && (artist.value.trim() !== '' || album.value.trim() !== ''))

async function apply(): Promise<void> {
  if (busy.value || !canWrite.value) return
  busy.value = true
  failures.value = []
  undoStack.value = []
  progress.value = { written: 0, total: mp3s.value.length }
  const nextArtist = artist.value.trim()
  const nextAlbum = album.value.trim()
  const written: typeof undoStack.value = []

  for (const track of mp3s.value) {
    const patch: { id: string; artist?: string; album?: string } = { id: track.id }
    // Only the fields the user actually filled in: an empty box means "leave it alone", not "erase it".
    if (nextArtist) patch.artist = nextArtist
    if (nextAlbum) patch.album = nextAlbum
    const result = await library.writeTags(patch)
    if (result.ok) {
      written.push({ id: track.id, title: track.title, artist: track.artist, album: track.album })
      progress.value = { ...progress.value, written: progress.value.written + 1 }
    } else {
      failures.value = [...failures.value, { title: track.title, error: result.error ?? '写入失败' }]
    }
  }

  undoStack.value = written
  busy.value = false
  done.value = true
  const okCount = written.length
  if (okCount === 0) ui.notify('没有任何文件被写入（详见下方原因）', 'error')
  else if (failures.value.length > 0) ui.notify(`已写入 ${okCount} 首，${failures.value.length} 首失败`, 'info')
  else ui.notify(`已写入 ${okCount} 首的标签`, 'success')
}

/** Puts back what this dialog changed, through the same IPC that changed it. */
async function undo(): Promise<void> {
  if (busy.value || undoStack.value.length === 0) return
  busy.value = true
  const restored: typeof undoStack.value = []
  for (const entry of undoStack.value) {
    const result = await library.writeTags({ id: entry.id, artist: entry.artist, album: entry.album })
    if (!result.ok) failures.value = [...failures.value, { title: entry.title, error: `撤销失败：${result.error ?? '未知原因'}` }]
    else restored.push(entry)
  }
  undoStack.value = undoStack.value.filter((entry) => !restored.includes(entry))
  busy.value = false
  ui.notify(restored.length > 0 ? `已撤销 ${restored.length} 首` : '撤销没有生效', restored.length > 0 ? 'success' : 'error')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal-card" data-testid="batch-tag-dialog">
      <header class="modal-head">
        <div>
          <h2>批量修改歌曲信息</h2>
          <p class="muted small-text">
            已选 {{ tracks.length }} 首 · 其中 {{ mp3s.length }} 首是 MP3（可写入标签）
            <template v-if="skipped > 0">· {{ skipped }} 首其他格式会被跳过</template>
          </p>
        </div>
        <button class="icon-button" title="关闭" @click="emit('close')">✕</button>
      </header>

      <p v-if="mp3s.length === 0" class="notice-card subtle">
        <span class="notice-icon">!</span>
        <span>标签写入目前只支持 MP3：其他格式会被写坏，所以 Aurora 不做。这次选中的曲目里没有 MP3。</span>
      </p>

      <label class="field">
        <span>艺术家{{ artist ? '' : '（留空则不改动）' }}</span>
        <input v-model="artist" type="text" data-testid="batch-artist" :disabled="busy || mp3s.length === 0" placeholder="例如：周杰伦" />
      </label>
      <label class="field">
        <span>专辑{{ album ? '' : '（留空则不改动）' }}</span>
        <input v-model="album" type="text" data-testid="batch-album" :disabled="busy || mp3s.length === 0" placeholder="例如：叶惠美" />
      </label>

      <p class="muted small-text">
        修改会写进文件本身（ID3v2.3），不只是界面上的显示。
      </p>

      <div v-if="busy || done" class="batch-progress" data-testid="batch-progress">
        {{ progress.written }} / {{ progress.total }}
        <span v-if="busy" class="spinner"></span>
      </div>

      <ul v-if="failures.length > 0" class="batch-failures" data-testid="batch-failures">
        <li v-for="item in failures" :key="item.title">
          <strong>{{ item.title }}</strong>
          <span>{{ item.error }}</span>
        </li>
      </ul>

      <footer class="modal-actions">
        <button v-if="undoStack.length > 0 && !busy" class="ghost-button small" data-testid="batch-undo" @click="undo">
          撤销这次修改（{{ undoStack.length }} 首）
        </button>
        <button class="primary-button small" data-testid="batch-apply" :disabled="!canWrite || busy" @click="apply">
          {{ busy ? '正在写入…' : done ? '再写一次' : `写入 ${mp3s.length} 首` }}
        </button>
      </footer>
    </section>
  </div>
</template>
