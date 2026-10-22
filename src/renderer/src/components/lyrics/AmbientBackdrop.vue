<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { coverStyle } from '../../utils/cover'
import { extractPalette, paletteFromSeed } from '../../utils/palette'

/**
 * The immersive backdrop: two blurred layers plus a grain, all derived from the song's own colours.
 *
 *  - layer 1 is the cover itself, blurred hard and scaled past the viewport so its structure only
 *    reads as depth, never as a second image;
 *  - layer 2 is a three-stop colour field built from the extracted palette — with `blur(90px)` and
 *    generous overlap, which is what removes the banding a plain linear-gradient would show;
 *  - the grain sits on top at 3% with `overlay` blending: at that strength it does not read as noise,
 *    it only breaks up the remaining 8-bit stepping in the dark areas.
 *
 * Colours are handed to the stylesheet as custom properties rather than assembled inline, so the
 * gradient maths lives in CSS and this component only decides *which* three colours apply.
 */
const props = defineProps<{ cover?: string; seed: string }>()

const palette = ref<string[]>(paletteFromSeed(props.seed))

// Resolving a cover is async and can land after the track has already changed, so late results from
// an older cover are dropped instead of flashing the previous song's colours.
let token = 0

async function resolve(cover: string | undefined, seed: string): Promise<void> {
  const mine = ++token
  const found = await extractPalette(cover, seed)
  if (mine === token) palette.value = found
}

watch(() => [props.cover, props.seed] as const, ([cover, seed]) => void resolve(cover, seed), { immediate: true })

const wash = computed(() => (props.cover ? { backgroundImage: `url("${props.cover}")` } : coverStyle(undefined, props.seed)))
const tones = computed<Record<string, string>>(() => ({
  '--amb-1': palette.value[0] ?? '#3a3f56',
  '--amb-2': palette.value[1] ?? '#2a2f42',
  '--amb-3': palette.value[2] ?? '#4a4660',
}))
</script>

<template>
  <div class="ambient" :style="tones" aria-hidden="true">
    <div class="ambient-photo" :style="wash"></div>
    <div class="ambient-field"></div>
    <!-- The active skin's own colours, screened in additively: this is what makes 落日长歌's immersive
         page read as warm film and 烟雨江南's as rain-lit ink, from the same cover artwork. -->
    <div class="ambient-skin"></div>
    <div class="ambient-veil"></div>
    <div class="ambient-grain"></div>
  </div>
</template>
