<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { coverStyle } from '../../utils/cover'
import { safeMediaUrl } from '../../utils/url'
import { analyzeArtwork, clearCustomArtwork, focusObjectPosition, getCustomArtwork, prepareArtwork, setCustomArtwork, type CropResult } from '../../utils/artwork'
import { useUiStore } from '../../stores/ui'

/**
 * Artwork Canvas — the left column's artwork, treated as a canvas rather than as an image tag.
 *
 * Four things happen here, and each is a real computation rather than a CSS trick:
 *
 *  1. **Fill the frame** — `object-fit: cover` plus a solved `object-position`.
 *  2. **Keep the subject** — `analyzeArtwork` finds the interesting part of the image (edge energy,
 *     saturation, mild centre prior) and `focusObjectPosition` computes the only crop offset that
 *     holds that region inside a square frame. When the subject genuinely cannot fit, the component
 *     reports `clipped` instead of pretending the crop is perfect.
 *  3. **Extend the image** — the same artwork, blurred and oversized, sits behind the sharp frame, so
 *     a portrait cover neither letterboxes nor shows a dead gradient.
 *  4. **Feed the theme** — the resolved source is emitted upward, which is what makes the ambient
 *     backdrop and the accent follow a *user-uploaded* image exactly as they follow a catalog cover.
 *
 * The upload path is per track and stored locally (`utils/artwork.ts`), so the choice survives restarts
 * without touching the music file or the library database.
 */
const props = defineProps<{ trackId?: string; cover?: string; seed: string; title?: string }>()
const emit = defineEmits<{ 'update:source': [source: string | undefined] }>()

const ui = useUiStore()

const shell = ref<HTMLElement | null>(null)
const frameSize = ref(340)
const source = ref<string | undefined>(undefined)
const crop = ref<CropResult | null>(null)
const confident = ref(false)
const clipped = ref(false)
const origin = ref<'upload' | 'catalog' | 'fallback'>('fallback')
const busy = ref(false)
const errorText = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
/**
 * `true` once the browser has refused the current `src`.
 *
 * A cover can still fail to load even after the URL passes `safeMediaUrl` — an expired CDN link, a
 * dead host, a relay token that was evicted. Without this the frame drew Chromium's broken-image
 * glyph on top of the frame, which is both ugly and misleading: a broken image is not "this track has
 * no artwork", and the honest answer is the same gradient every coverless track gets.
 */
const failed = ref(false)
const usable = computed(() => Boolean(source.value) && !failed.value)

/** True when the current artwork is the user's own, so 「恢复默认封面」 can be offered. */
const hasUpload = computed(() => Boolean(props.trackId && getCustomArtwork(props.trackId)))
/** Same deterministic gradient the rest of the app uses when there is nothing to show. */
const fallback = computed(() => coverStyle(undefined, props.seed))

let token = 0

/**
 * Resolves the source, then the crop.
 *
 * The token guard matters: analysing an image is async, and a user flicking through tracks would
 * otherwise let an older cover's geometry land on the current one.
 */
async function resolve(): Promise<void> {
  const mine = ++token
  const override = props.trackId ? getCustomArtwork(props.trackId) : undefined
  // A cover arrives from a source (or from a platform's metadata), so it is validated *here* rather
  // than only in `coverStyle()`: this component builds its own `src` and `url(…)` bindings, and
  // passing the raw string through is how a `file://` cover reads a local file into the renderer and
  // a `javascript:` one lands in a style attribute. An unusable value is treated as "no artwork".
  const next = safeMediaUrl(override ?? props.cover)
  source.value = next
  failed.value = false
  // Reported from the *validated* value: a cover the guard rejected is not "catalog" artwork.
  origin.value = override ? 'upload' : next ? 'catalog' : 'fallback'
  emit('update:source', next)
  if (!next) {
    crop.value = null
    confident.value = false
    clipped.value = false
    return
  }
  const analysis = await analyzeArtwork(next)
  if (mine !== token) return
  confident.value = analysis.confident
  const size = frameSize.value
  const result = focusObjectPosition(
    analysis.width || size,
    analysis.height || size,
    size,
    size,
    analysis.focus,
    analysis.box,
  )
  crop.value = result
  clipped.value = result.clipped
}

watch(() => [props.trackId, props.cover] as const, () => void resolve(), { immediate: true })

let observer: ResizeObserver | null = null

function measure(): void {
  const width = shell.value?.clientWidth ?? 0
  if (width > 0 && Math.abs(width - frameSize.value) > 1) {
    frameSize.value = width
    // A resize changes the crop window, so the geometry has to be solved again.
    void resolve()
  }
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && shell.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(shell.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

async function pick(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !props.trackId) return
  busy.value = true
  errorText.value = ''
  try {
    const prepared = await prepareArtwork(file)
    const stored = setCustomArtwork(props.trackId, prepared.dataUrl)
    if (!stored) {
      errorText.value = '本机存储空间不足，无法保存这张图片'
      ui.notify('保存失败：本机存储空间不足', 'error')
      return
    }
    await resolve()
    ui.notify(`已为《${props.title ?? '当前歌曲'}》设置自定义封面`, 'success')
  } catch (failure) {
    errorText.value = failure instanceof Error ? failure.message : '图片处理失败'
    ui.notify(errorText.value, 'error')
  } finally {
    busy.value = false
  }
}

async function restore(): Promise<void> {
  if (!props.trackId) return
  clearCustomArtwork(props.trackId)
  await resolve()
  ui.notify('已恢复默认封面', 'info')
}

/** The solved framing, handed to CSS as `object-position`. */
const imageStyle = computed(() => ({ objectPosition: crop.value?.position ?? '50% 50%' }))
</script>

<template>
  <div
    ref="shell"
    class="artwork"
    :data-artwork-source="origin"
    :data-artwork-confident="confident ? 'true' : 'false'"
    :data-artwork-clipped="clipped ? 'true' : 'false'"
    :data-artwork-loaded="usable ? 'true' : 'false'"
    :data-artwork-position="crop?.position ?? '50% 50%'"
    :data-artwork-scale="crop ? crop.scale.toFixed(3) : ''"
  >
    <!-- The blurred extension: the same image, pushed past the frame so the column never shows a seam. -->
    <div v-if="usable" class="artwork-extend" :style="{ backgroundImage: `url('${source}')` }" aria-hidden="true"></div>
    <div class="artwork-glow" :style="usable ? { backgroundImage: `url('${source}')` } : fallback" aria-hidden="true"></div>

    <div class="artwork-frame">
      <img
        v-if="usable"
        :src="source"
        alt=""
        :style="imageStyle"
        decoding="async"
        @error="failed = true"
      />
      <div v-else class="cover-fallback large" :style="fallback"><span>✦</span></div>

      <div class="artwork-tools">
        <button class="artwork-tool" :disabled="busy" title="上传自定义封面" @click="fileInput?.click()">
          {{ busy ? '处理中…' : '换封面' }}
        </button>
        <button v-if="hasUpload" class="artwork-tool" title="恢复默认封面" @click="restore">恢复</button>
      </div>
      <input ref="fileInput" class="artwork-file" type="file" accept="image/*" @change="pick" />
    </div>

    <p v-if="errorText" class="artwork-error">{{ errorText }}</p>
  </div>
</template>
