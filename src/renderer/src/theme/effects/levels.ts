/*
 * Animation levels — the user's performance dial.
 *
 * The levels are not "how much stuff to render" in the abstract: each one is a concrete budget
 * (particle multiplier, pixel-ratio cap, whether the expensive layers run at all) so that a machine
 * which struggles has something to fall back to *before* the user has to turn everything off.
 *
 * `react` lives here too, because music coupling is a cost: it means work per frame (reading the
 * analyser and writing styles) and it means motion the user cannot predict. A level that skips it is
 * a level that is genuinely cheaper, not just sparser.
 */
import type { AnimationLevel } from '../../../../shared/theme'

export interface LevelProfile {
  /** Multiplier on the theme's particle density. */
  particles: number
  /** `devicePixelRatio` cap for effect canvases. */
  dpr: number
  /** Multiplier on the theme's ambient glow. */
  glow: number
  /** Whether the expensive layers run: recipe backdrops, grain, halos, lyric transitions. */
  heavy: boolean
  /** Multiplier on how much playback energy may influence the visuals. */
  react: number
  label: string
  hint: string
}

export const LEVELS: Record<AnimationLevel, LevelProfile> = {
  off: {
    particles: 0,
    dpr: 1,
    glow: 0,
    heavy: false,
    react: 0,
    label: '关闭',
    hint: '不绘制粒子、动态背景与联动效果',
  },
  saver: {
    particles: 0.35,
    dpr: 1,
    glow: 0.5,
    heavy: false,
    react: 0.35,
    label: '节能',
    hint: '少量粒子，关闭重特效（适合笔记本省电）',
  },
  standard: {
    particles: 1,
    dpr: 1.5,
    glow: 1,
    heavy: true,
    react: 1,
    label: '标准',
    hint: '完整效果，负载低（默认）',
  },
  immersive: {
    particles: 1.8,
    dpr: 1.5,
    glow: 1.25,
    heavy: true,
    react: 1.4,
    label: '沉浸',
    hint: '更密的粒子、更强的音乐联动（视觉优先）',
  },
}

export const LEVEL_ORDER: AnimationLevel[] = ['off', 'saver', 'standard', 'immersive']

export function isAnimationLevel(value: unknown): value is AnimationLevel {
  return typeof value === 'string' && LEVEL_ORDER.includes(value as AnimationLevel)
}

/**
 * One step down the ladder, for the automatic fallback.
 *
 * `off` is deliberately *not* reachable this way: dropping to "no effects at all" because a laptop
 * had a slow second would feel like a bug, so the automatic floor is 节能.
 */
export function downgrade(level: AnimationLevel): AnimationLevel {
  if (level === 'immersive') return 'standard'
  if (level === 'standard') return 'saver'
  return level
}

/**
 * One step back up, for the load guard's recovery.
 *
 * Capped by `ceiling` — the level the user actually chose. Without that cap a good machine would climb
 * past the user's own dial after a while, which is the same class of bug as the old watchdog overwriting
 * a preference, only in the other direction.
 */
export function upgrade(level: AnimationLevel, ceiling: AnimationLevel): AnimationLevel {
  const next = LEVEL_ORDER[Math.min(LEVEL_ORDER.length - 1, LEVEL_ORDER.indexOf(level) + 1)]
  if (!next) return level
  return LEVEL_ORDER.indexOf(next) > LEVEL_ORDER.indexOf(ceiling) ? level : next
}

export function levelProfile(level: AnimationLevel): LevelProfile {
  return LEVELS[level] ?? LEVELS.standard
}
