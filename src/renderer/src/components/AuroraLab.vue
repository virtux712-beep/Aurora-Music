<script setup lang="ts">
/*
 * Aurora Lab — the hidden instrument panel (Ctrl+Shift+A).
 *
 * Its job is to make the performance manager *visible*, because every other way of looking at this
 * question is a guess. "The machine seems fine" and "the effects look choppy" are both opinions; the
 * panel shows the numbers the governor actually decided on: measured cadence, the draw rate it allowed,
 * p50/p95 frame cost against the budget, the detected panel refresh, the live particle count, and the
 * DPR the effect canvases are really using.
 *
 * Two rules it follows exactly like the rest of the app:
 *
 *  - **it polls instead of subscribing.** The frame layer is deliberately outside Vue's reactive graph
 *    (it runs at the display's rate), so this component reads `frameSnapshot()` on a 400 ms timer while
 *    it is open. Putting 144 Hz data into the render graph would be the very cost this panel measures.
 *  - **it never invents a value.** GPU detection is best-effort and says so when the driver string is
 *    blocked; a hidden window reports that measurement is paused rather than a stale number.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { frameSnapshot, guardCeiling, type FrameSnapshot } from '../visual/frame'
import { LEVELS } from '../theme/effects'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
const info = ref<FrameSnapshot | null>(null)
const gpu = ref<string>('检测中…')
const ramMb = ref<number | null>(null)
let timer = 0

/**
 * The GPU's driver string, via a throwaway context.
 *
 * `WEBGL_debug_renderer_info` is the only way a renderer can see this, and privacy settings are allowed
 * to blank it — so "不可用" is a real answer here, not a failure to be papered over with the word
 * "unknown GPU".
 */
function detectGpu(): void {
  try {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('webgl')
    if (!context) {
      gpu.value = '不可用（未获得 WebGL 上下文）'
      return
    }
    const debug = context.getExtension('WEBGL_debug_renderer_info')
    const renderer = debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null
    gpu.value = typeof renderer === 'string' && renderer ? renderer : '不可用（驱动信息被隐私设置屏蔽）'
    context.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    gpu.value = '不可用（读取被拒绝）'
  }
}

function sample(): void {
  info.value = frameSnapshot()
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  ramMb.value = memory ? Math.round(memory.usedJSHeapSize / (1024 * 1024)) : null
}

const rows = computed(() => {
  const snapshot = info.value
  if (!snapshot) return []
  const { stats } = snapshot
  const profile = LEVELS[ui.animationLevel]
  return [
    ['实测刷新率', `${snapshot.fps.toFixed(1)} fps`, snapshot.visible ? '' : '窗口不可见'],
    ['实绘帧率', `${snapshot.drawFps.toFixed(1)} fps`, `上限 ${snapshot.budgetHz} fps`],
    ['门闸压力', `${snapshot.allowedCalls}/${snapshot.drawCalls}`, '累计通过 / 请求；每个图层各自限速'],
    ['帧预算', `${snapshot.budgetMs.toFixed(2)} ms`, snapshot.displayHz ? `屏幕 ${snapshot.displayHz} Hz` : '屏幕刷新率测量中'],
    ['帧耗时 p50', `${stats.p50Ms.toFixed(2)} ms`, '中位数'],
    ['帧耗时 p95', `${stats.p95Ms.toFixed(2)} ms`, '尾部延迟，卡顿感来自这里'],
    ['掉帧比例', `${(stats.droppedRatio * 100).toFixed(1)} %`, '超过 1.5× 预算的帧'],
    ['采样窗口', `${stats.samples} 帧`, '决策依据'],
    ['负载判定', snapshot.grade, snapshot.reason || '暂无变化'],
    ['自动调档', `${snapshot.changes} 次`, `缓动 ${(snapshot.ramp * 100).toFixed(0)}%`],
    ['当前档位', LEVELS[ui.animationLevel].label, `用户选择「${LEVELS[guardCeiling()].label}」是恢复上限`],
    ['粒子乘数', profile.particles.toFixed(2), '由等级决定'],
    ['当前粒子', String(snapshot.particles), '画布上实际绘制的数量（含缓动）'],
    ['像素比上限', String(profile.dpr), `设备 ${window.devicePixelRatio}`],
    // What the canvases are *actually* sized at right now: the level's cap, times the idle scale a paused
    // or unfocused window may draw at. Two numbers because they answer two questions — "what did the user
    // choose" and "what is on screen this second".
    ['生效像素比', `${(profile.dpr * snapshot.renderScale).toFixed(2)}×`, `空闲系数 ${snapshot.renderScale}`],
    ['GPU 渲染器', gpu.value, ''],
    ['JS 堆', ramMb.value === null ? '不可用' : `${ramMb.value} MB`, '仅渲染进程'],
    ['窗口', `${window.innerWidth}×${window.innerHeight}`, `${screen.width}×${screen.height}`],
  ] as Array<[string, string, string]>
})

onMounted(() => {
  detectGpu()
  sample()
  timer = window.setInterval(sample, 400)
})

onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <aside class="aurora-lab" data-aurora-lab="on">
    <header>
      <strong>Aurora Lab</strong>
      <span class="faint">Ctrl+Shift+A</span>
    </header>
    <dl>
      <template v-for="row in rows" :key="row[0]">
        <dt>{{ row[0] }}</dt>
        <dd>
          {{ row[1] }}
          <span v-if="row[2]" class="faint"> · {{ row[2] }}</span>
        </dd>
      </template>
    </dl>
    <p class="faint lab-note">
      数值来自 Aurora 的帧调速器（visual/frame.ts），不是估算值；每个数同时镜像到 &lt;html&gt; 的
      <code>data-fx-*</code> 上，所以脚本读到的总是帧循环刚写下的值。窗口不可见时测量会暂停，而不是显示旧值。
    </p>
  </aside>
</template>
