<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { PLAY_MODE_ICONS, PLAY_MODE_LABELS, usePlayerStore } from '../stores/player'
import { useCollectionStore } from '../stores/collection'
import { usePlatformStore } from '../stores/platform'
import { useSourceStore } from '../stores/source'
import { useUiStore } from '../stores/ui'
import { useTrackActions } from '../composables/useTrackActions'
import { desktopLyricsService, settingsService } from '../services/aurora'
import { DEFAULT_DESKTOP_LYRICS } from '../../../shared/types'
import type { DesktopLyricsSettings, PlatformId } from '../../../shared/types'
import { coverStyle as buildCoverStyle } from '../utils/cover'
import { formatTime } from '../utils/format'
import { DEFAULT_QUALITY, QUALITY_TIERS, qualityTier, tierOfToken, type QualityTierId } from '../../../shared/quality'
import { SLEEP_PRESETS_MINUTES } from '../audio/sleep'

const player = usePlayerStore()
const collection = useCollectionStore()
const platformStore = usePlatformStore()
const sourceStore = useSourceStore()
const ui = useUiStore()
const router = useRouter()
const { toggleFavorite } = useTrackActions()

/** Mirrors the real window state: the button reflects the main process, never its own optimism. */
const desktopLyrics = ref<DesktopLyricsSettings>({ ...DEFAULT_DESKTOP_LYRICS })
void desktopLyricsService.options().then((options) => {
  if (options) desktopLyrics.value = options
})

async function toggleDesktopLyrics(): Promise<void> {
  const options = await desktopLyricsService.setEnabled(!desktopLyrics.value.enabled)
  if (options) desktopLyrics.value = options
  ui.notify(options?.enabled ? '桌面歌词已开启' : '桌面歌词已关闭', 'info')
}

const track = computed(() => player.current)
const favorite = computed(() => (track.value ? collection.isFavorite(track.value.id) : false))

/**
 * The tier badge for whatever is playing, from the store's own answer.
 *
 * The player bar is the one place a user looks *while listening*, so this is the honest current state
 * rather than the song's best published quality: a source that handed back `320k` says 极致音质 even when the
 * song is also published as FLAC.
 */
const currentQuality = computed(() => {
  const id = player.currentQualityTier
  if (!id) return null
  const tier = qualityTier(id)
  const detail = player.lastQualityReason || tier.description
  /*
   * `tierId` is separate from `tier` on purpose: the descriptor is an object, and binding it to
   * `:data-tier` used to stringify it into the literal `[object Object]` — so anything keyed off the
   * attribute (the colour rules, and any reader of the DOM) saw a badge with no tier at all.
   */
  return { ...tier.badge, tierId: id, tier, name: tier.name, title: `${tier.name}（${tier.english}）· ${detail}` }
})

/*
 * 音质控制。
 *
 * 它把**两件不同的事**放在一起，因为用户就是一起看它们的：
 *
 *  - 偏好（`preferredQuality`，主进程设置）：Aurora 拿哪一档去问音源要地址；
 *  - 实际（`player.currentQualityTier`）：这一首**真的**拿到了哪一档。
 *
 * 按钮上显示的一直是"实际"（徽章说假话比没有徽章更糟），弹层里同时标出"当前偏好"与"正在播放"。
 * 放在播放栏而不是设置页，是因为这是个会随手改的东西：它只约束下一首，改完还能立刻重解析当前这首。
 */
const preferredQuality = ref<QualityTierId>(DEFAULT_QUALITY)
const qualityOpen = ref(false)

/*
 * 睡眠定时.
 *
 * It lives in the player bar rather than the settings page because of *when* it is used: at night, with the
 * lights off, after the music has already started. A control you have to find in settings first is one
 * nobody uses at the moment they need it.
 */
const sleepOpen = ref(false)
const sleepArmed = computed(() => player.sleep.mode !== 'off')

void settingsService.cached()
settingsService.get().then((settings) => {
  preferredQuality.value = settings.preferredQuality
})

function tierSpec(tier: (typeof QUALITY_TIERS)[number]): string {
  const parts = [...tier.spec.formats]
  if (tier.spec.bitDepth && tier.spec.sampleRate) parts.push(`${tier.spec.bitDepth}bit / ${(tier.spec.sampleRate / 1000).toFixed(1)}kHz`)
  return parts.join(' · ')
}

/** How many registered platforms/sources declare anything in this tier, from their own metadata. */
function supplyCount(id: QualityTierId): number {
  const tokens = new Set<string>()
  for (const platform of platformStore.platforms) for (const token of platform.qualities ?? []) tokens.add(token)
  for (const source of sourceStore.sources) for (const token of source.qualities ?? []) tokens.add(token)
  return [...tokens].filter((token) => tierOfToken(token) === id).length
}

/**
 * The four rows, each carrying the three facts that matter: is it preferred, is it playing, can this song
 * actually be had in it. The availability is the *current song's* list when there is one — a source offers
 * `flac` for one song and only `128k` for the next, so a global answer there would be a lie.
 */
const qualityRows = computed(() => {
  const tokens = track.value?.qualities ?? []
  const playingTier = player.currentQualityTier
  return QUALITY_TIERS.map((tier) => ({
    id: tier.id,
    name: tier.name,
    english: tier.english,
    icon: tier.badge.icon,
    spec: tierSpec(tier),
    preferred: preferredQuality.value === tier.id,
    playing: playingTier === tier.id,
    /* `null` means "this song says nothing", which is not the same as "not available". */
    available: tokens.length > 0 ? tokens.some((token) => tierOfToken(token) === tier.id) : null,
    supply: supplyCount(tier.id),
  }))
})

function qualityAvailabilityText(row: { available: boolean | null; supply: number }): string {
  if (row.available === true) return '这首可选'
  if (row.available === false) return '这首没有'
  return row.supply > 0 ? `${row.supply} 个音源声明支持` : '暂无音源声明'
}

const qualityTriggerTitle = computed(() => {
  const actual = currentQuality.value ? `${currentQuality.value.icon} ${currentQuality.value.name}` : '未知'
  const preferred = qualityTier(preferredQuality.value)
  return `音质：正在播放 ${actual} · 偏好 ${preferred.badge.icon} ${preferred.name}（点击调整）`
})

async function setQuality(id: QualityTierId): Promise<void> {
  preferredQuality.value = id
  await settingsService.set({ preferredQuality: id })
  qualityOpen.value = false
  const name = qualityTier(id).name
  if (!(await player.refreshQuality())) {
    ui.notify(`音质偏好已切到「${name}」，下一首开始生效`, 'success')
    return
  }
  /*
   * The re-resolve knows what actually happened, and it is not always "your tier is now in play": the song
   * may not be published in it, or the source may hand back something else. Quoting the resolve's own reason
   * keeps the toast from promising something the stream does not have.
   */
  const reason = player.lastQualityReason
  ui.notify(`音质偏好已切到「${name}」，当前歌曲已重新解析${reason ? `：${reason}` : ''}`, 'success')
}

/*
 * Close on an outside press.
 *
 * This runs in the *capture* phase, so it fires on mousedown — before any click can land on what was
 * pressed. That makes the "is this press inside?" test load-bearing: the picker lists its rows in
 * `.quality-popover`, which is a sibling of `.quality-control` (it is anchored to the bar, not to the
 * badge), so testing only for `.quality-control` closed the popover on the way down and every row click
 * was swallowed. The rows were reachable from a programmatic `.click()` — which dispatches no
 * pointerdown — and unreachable from a mouse, which is the worst of both worlds.
 */
function onDocumentPointerDown(event: MouseEvent): void {
  if (!qualityOpen.value && !sleepOpen.value) return
  const node = event.target as HTMLElement | null
  if (node?.closest('.quality-control, .quality-popover, .sleep-control, .sleep-popover')) return
  qualityOpen.value = false
  sleepOpen.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    qualityOpen.value = false
    sleepOpen.value = false
  }
}

function armSleep(minutes: number): void {
  player.startSleep(minutes)
  sleepOpen.value = false
}

function armSleepAfterTrack(): void {
  player.startSleepAfterTrack()
  sleepOpen.value = false
}

function disarmSleep(): void {
  player.cancelSleep()
  sleepOpen.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('keydown', onKeydown)
})

/**
 * The tier badge for whatever is playing, from the store's own answer.
 *
 *  - a local file says 本地文件;
 *  - an online track is labelled with its platform (or its source, when the source is a plugin).
 */
const originBadge = computed<{ text: string; title: string } | null>(() => {
  const current = track.value
  if (!current) return null
  if (current.origin === 'local') {
    return { text: '本地文件', title: current.filePath ?? '来自本机音乐库' }
  }
  const platformName = platformStore.labelIfKnown(current.sourceId)
  if (platformName) return { text: platformName, title: `在线曲库 · ${platformName}` }
  return { text: sourceStore.label(current.sourceId), title: '来自已安装的音源插件' }
})
const coverStyle = computed<Record<string, string>>(() =>
  track.value ? buildCoverStyle(track.value.cover, track.value.id) : {},
)

function onSeek(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  player.seekRatio(value / 1000)
}

function onVolume(event: Event): void {
  player.setVolume(Number((event.target as HTMLInputElement).value))
}

async function previous(): Promise<void> {
  await player.previous()
}

async function next(): Promise<void> {
  await player.next(false)
}
</script>

<template>
  <footer class="player-bar">
    <div class="now-playing" :class="{ clickable: Boolean(track) }" :title="track ? '打开沉浸式歌词' : '还没有播放任何音乐'" @click="track && router.push('/lyrics')">
      <div class="player-cover" :style="coverStyle"><span v-if="!track">✦</span></div>
      <div class="now-meta">
        <strong>
          {{ track?.title ?? '还没有播放任何音乐' }}
          <em v-if="originBadge" class="badge-origin" :class="track?.origin" :title="originBadge.title">{{ originBadge.text }}</em>
        </strong>
        <span>
          {{ track ? `${track.artist} · ${track.album}` : '从音乐库中选择一首开始' }}
        </span>
      </div>
      <span class="quality-control">
        <!--
          The quality trigger. Its label is the tier actually in play — from the source's own answer when it
          gave one, otherwise from the track's availability, and never the requested tier (a badge about a
          preference instead of about the sound is a badge that lies). With no tier to report it reads 音质,
          so the preference stays reachable even on an empty bar.
        -->
        <button
          class="badge-quality quality-trigger"
          :class="[currentQuality?.tone ?? 'unknown', { open: qualityOpen }]"
          :data-tier="currentQuality?.tierId ?? ''"
          :title="qualityTriggerTitle"
          :aria-expanded="qualityOpen"
          @click.stop="qualityOpen = !qualityOpen"
        >
          <!--
            Icon and label are separate elements so a narrow bar can drop the *label* rather than clip it:
            clipping left half a glyph on screen, which reads as a rendering bug.
          -->
          <template v-if="currentQuality"><span class="q-icon">{{ currentQuality.icon }}</span><span class="q-label">{{ currentQuality.label }}</span></template>
          <template v-else>音质</template>
        </button>
      </span>
      <button
        class="heart-button"
        :class="{ active: favorite }"
        :disabled="!track"
        :title="favorite ? '取消收藏' : '收藏'"
        @click.stop="track && toggleFavorite(track)"
      >{{ favorite ? '♥' : '♡' }}</button>
    </div>

    <div class="transport">
      <!-- The transport holds only the transport. Play mode is a setting about the *queue*, not about
           playing, so it lives with the queue button in the right zone instead of doubling up here. -->
      <div class="transport-buttons">
        <button title="上一首" :disabled="!player.hasQueue" @click="previous">⏮</button>
        <button
          class="play-button"
          :title="player.isPlaying ? '暂停' : '播放'"
          :disabled="!player.hasQueue"
          @click="player.toggle()"
        >
          <span v-if="player.isBuffering && player.isPlaying" class="spinner"></span>
          <span v-else>{{ player.isPlaying ? '❚❚' : '▶' }}</span>
        </button>
        <button title="下一首" :disabled="!player.hasQueue" @click="next">⏭</button>
      </div>
      <div class="progress-line">
        <span>{{ player.isLive ? 'LIVE' : formatTime(player.currentTime) }}</span>
        <input
          class="progress-range"
          type="range"
          min="0"
          max="1000"
          step="1"
          :value="Math.round(player.progress * 1000)"
          :disabled="!track || player.isLive"
          :title="player.isLive ? '网络电台直播流，无法拖动进度' : '播放进度'"
          aria-label="播放进度"
          @input="onSeek"
        />
        <span>{{ player.isLive ? 'LIVE' : formatTime(player.duration) }}</span>
      </div>
    </div>

    <!--
      The bar's function zone, in three groups rather than seven evenly spaced buttons.

      Even spacing made the eye read one long row; grouping by what the controls *do* — switch view (lyrics),
      steer the queue (mode + queue), shape the sound (mute + volume) — is what turns it back into three
      decisions. The dividers are decorative only: `pointer-events: none`, so nothing is un-clickable.
    -->
    <div class="player-actions">
      <div class="action-group lyrics-group">
        <button class="lyrics-button" :disabled="!track" title="沉浸式歌词（Ctrl+Shift+L）" @click="router.push('/lyrics')">词</button>
        <button
          class="lyrics-button"
          :class="{ active: desktopLyrics.enabled }"
          title="桌面歌词（独立置顶窗口）"
          @click="toggleDesktopLyrics"
        >
          桌
        </button>
      </div>

      <span class="action-divider after-lyrics" aria-hidden="true"></span>

      <div class="action-group queue-group">
        <button class="mode-label" :title="PLAY_MODE_LABELS[player.mode]" @click="player.cycleMode()">
          {{ PLAY_MODE_ICONS[player.mode] }} {{ PLAY_MODE_LABELS[player.mode] }}
        </button>
        <button class="queue-button" :class="{ active: ui.queueOpen }" title="播放队列" @click="ui.toggleQueue()">
          ☰ <span>队列{{ player.queue.length ? ` ${player.queue.length}` : '' }}</span>
        </button>
      </div>

      <span class="action-divider after-queue" aria-hidden="true"></span>

      <div class="action-group sleep-control">
        <button
          class="sleep-button"
          :class="{ active: sleepArmed }"
          data-testid="sleep-button"
          :title="sleepArmed ? `睡眠定时：${player.sleepLabelText}（点击修改）` : '睡眠定时'"
          :aria-expanded="sleepOpen"
          @click.stop="sleepOpen = !sleepOpen"
        >
          ☾<span v-if="sleepArmed" class="sleep-countdown" data-testid="sleep-countdown">{{ player.sleepLabelText }}</span>
        </button>
      </div>

      <span class="action-divider after-sleep" aria-hidden="true"></span>

      <div class="action-group volume-group">
        <button class="icon-action" :title="player.muted ? '取消静音' : '静音'" @click="player.toggleMute()">
          {{ player.muted || player.volume === 0 ? '◌' : '◖' }}
        </button>
        <input
          class="volume-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="player.muted ? 0 : player.volume"
          aria-label="音量"
          @input="onVolume"
        />
        <span class="volume-value">{{ Math.round((player.muted ? 0 : player.volume) * 100) }}%</span>
      </div>
    </div>

    <!--
      The picker itself lives outside `.now-meta`, which clips its own line (ellipsis), and is anchored above
      the bar: the bar is fixed to the bottom, so there is no room below it.
    -->
    <div v-if="sleepOpen" class="sleep-popover" data-testid="sleep-popover" @click.stop>
      <header>
        <strong>睡眠定时</strong>
        <em v-if="sleepArmed">{{ player.sleepLabelText }}</em>
        <em v-else>未设置</em>
      </header>
      <p class="sleep-hint">
        倒计时到点就停；「本曲结束后」不打断正在听的这一首，唱完不再接下一首。
      </p>
      <ul class="sleep-options">
        <li v-for="minutes in SLEEP_PRESETS_MINUTES" :key="minutes">
          <button
            class="sleep-option"
            :class="{ active: player.sleep.mode === 'minutes' && player.sleep.minutes === minutes }"
            :data-minutes="minutes"
            @click="armSleep(minutes)"
          >
            {{ minutes }} 分钟后停止
          </button>
        </li>
        <li>
          <button
            class="sleep-option"
            :class="{ active: player.sleep.mode === 'track' }"
            data-mode="track"
            @click="armSleepAfterTrack"
          >
            本曲结束后停止
          </button>
        </li>
        <li v-if="sleepArmed">
          <button class="sleep-option danger" data-mode="off" @click="disarmSleep">关闭定时</button>
        </li>
      </ul>
    </div>

    <div v-if="qualityOpen" class="quality-popover" @click.stop>
      <header>
        <strong>音质</strong>
        <em>正在播放：{{ currentQuality ? `${currentQuality.icon} ${currentQuality.name}` : '未知' }}</em>
      </header>
      <!--
        Two facts, and the second one matters: a local file cannot be re-encoded on the fly, so the four
        tiers are a preference for *online* songs there. Saying so is what stops "I picked 流畅播放 and
        nothing changed" from looking like a broken picker.
      -->
      <p class="quality-hint">
        偏好决定向音源索要哪一档；徽章显示的是实际拿到的那一档。改完立即重解析当前歌曲。
        <template v-if="track && track.origin !== 'online'">当前是本地文件，按文件本身的音质播放，切换档位只影响在线歌曲。</template>
      </p>
      <ul class="quality-tiers">
        <li v-for="row in qualityRows" :key="row.id">
          <button
            class="quality-tier"
            :class="[row.id, { active: row.preferred, playing: row.playing, unavailable: row.available === false }]"
            :data-tier="row.id"
            :title="`${row.name}（${row.english}）· ${row.spec}`"
            @click="setQuality(row.id)"
          >
            <span class="tier-name">{{ row.icon }} {{ row.name }}</span>
            <span class="tier-spec">{{ row.spec }}</span>
            <span class="tier-marks">
              <em v-if="row.playing" class="tier-mark playing">正在播放</em>
              <em v-if="row.preferred" class="tier-mark preferred">✓ 偏好</em>
            </span>
            <span class="tier-availability" :class="{ ok: row.available === true }">{{ qualityAvailabilityText(row) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </footer>
</template>
