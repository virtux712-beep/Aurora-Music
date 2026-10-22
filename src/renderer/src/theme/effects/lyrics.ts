/*
 * The lyric line's arrival — the theme's own reading gesture.
 *
 * 星河入梦 focuses the line as if pulled out of the dark, 晚秋拾叶 turns it like a page, 潮汐晨光 lets it
 * ripple in from below, 烟雨江南 writes it on, 落日长歌 drops it in like a subtitle. They are all one
 * transition with different timing and offsets, so they are declared as numbers here and performed by
 * CSS: a lyric line animates on every song change, and doing that in JS would mean a transition per
 * line on the critical path of playback.
 */
import type { AnimationLevel, LyricKind, ThemeEffects } from '../../../../shared/theme'
import { levelProfile } from './levels'

export interface LyricPlan {
  kind: LyricKind
  vars: Record<string, string>
}

/** Per-recipe feel: how far the line travels, how long it takes, and whether it scales. */
const FEEL: Record<LyricKind, { distance: number; duration: number; scale: number }> = {
  focus: { distance: 10, duration: 520, scale: 0.97 },
  page: { distance: 6, duration: 420, scale: 1 },
  ripple: { distance: 14, duration: 560, scale: 0.99 },
  ink: { distance: 4, duration: 640, scale: 1.01 },
  subtitle: { distance: 18, duration: 380, scale: 1 },
  plain: { distance: 0, duration: 0, scale: 1 },
}

export function lyricPlan(effects: ThemeEffects, level: AnimationLevel): LyricPlan {
  const profile = levelProfile(level)
  const feel = FEEL[effects.lyrics] ?? FEEL.plain
  // At 节能 and below the gesture is skipped: a transition still runs on every line change, and the
  // cheapest correct answer is the one that does not animate at all — so the numbers are not written
  // either (nothing would read them, and leaving them behind is what "a stale effect" looks like).
  if (!profile.heavy || feel.duration === 0) return { kind: 'plain', vars: {} }
  const vars: Record<string, string> = {
    '--lyric-shift': `${feel.distance}px`,
    '--lyric-duration': `${feel.duration}ms`,
    '--lyric-scale': String(feel.scale),
  }
  // Only 星河入梦 resolves the line out of a blur — that one *is* the theme's identity, and it is the
  // only recipe whose keyframes read the variable.
  if (effects.lyrics === 'focus') vars['--lyric-blur'] = '4px'
  return { kind: effects.lyrics, vars }
}
