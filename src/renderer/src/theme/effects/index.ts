/*
 * The effect engine's front door: one plan per theme+level, applied once to the document root.
 *
 * Everything the visuals need is expressed either as a `data-*` attribute (which recipe to run) or as a
 * custom property (that recipe's numbers). That is what keeps this cheap enough to run on a theme or
 * level change — a handful of attribute writes — while the *music* linkage stays out of the reactive
 * graph entirely: playback only writes `--music-energy` and reads it in the canvas (see `energy.ts`).
 *
 * The four role modules (background / ambient / player / lyrics) are the "effects/" a theme is made of.
 * They are engine modules rather than one script per theme on purpose: a theme must stay *data*, because
 * a user theme arrives as JSON and can never ship code — so a theme picks a recipe by name and tunes it
 * with its own colours, and the recipe is implemented once here.
 */
import type { AnimationLevel, ThemeDefinition, ThemeTokens } from '../../../../shared/theme'
import { ambientSettings, type AmbientSettings } from './ambient'
import { backgroundPlan, type BackgroundPlan } from './background'
import { levelProfile } from './levels'
import { lyricPlan, type LyricPlan } from './lyrics'
import { pulsePlan, type PulsePlan } from './player'

export interface EffectPlan {
  level: AnimationLevel
  ambient: AmbientSettings
  background: BackgroundPlan
  pulse: PulsePlan
  lyrics: LyricPlan
  /** Attribute name → value, written to the root element. */
  dataset: Record<string, string>
  /** Custom properties, written to the root element. */
  vars: Record<string, string>
}

export function planEffects(
  theme: ThemeDefinition,
  level: AnimationLevel,
  tokens: ThemeTokens,
): EffectPlan {
  const profile = levelProfile(level)
  const ambient = ambientSettings(theme.effects, level)
  const background = backgroundPlan(theme.effects, level)
  const pulse = pulsePlan(theme.effects, tokens, level)
  const lyrics = lyricPlan(theme.effects, level)
  return {
    level,
    ambient,
    background,
    pulse,
    lyrics,
    dataset: {
      anim: level,
      // `plain` is a real recipe (a flat, tinted surface) — not a missing value.
      bg: background.kind,
      pulse: pulse.kind,
      lyric: lyrics.kind,
      immersive: profile.heavy ? theme.effects.immersive : 'plain',
    },
    vars: { ...background.vars, ...pulse.vars, ...lyrics.vars },
  }
}

/**
 * Writes a plan to an element.
 *
 * Removes properties the previous plan set and the new one does not, so switching from 沉浸 to 关闭
 * cannot leave a stale `--pulse-strength` behind and keep a halo alive at a level that promised none.
 */
export function applyEffects(root: HTMLElement, plan: EffectPlan, applied: Set<string>): Set<string> {
  for (const name of applied) {
    if (!(name in plan.vars)) root.style.removeProperty(name)
  }
  for (const [name, value] of Object.entries(plan.vars)) root.style.setProperty(name, value)
  for (const [name, value] of Object.entries(plan.dataset)) root.dataset[name] = value
  return new Set(Object.keys(plan.vars))
}

export { LEVELS, LEVEL_ORDER, isAnimationLevel, levelProfile, downgrade, upgrade } from './levels'
export type { LevelProfile } from './levels'
export { AUTO_LEVEL_KEY, LEVEL_KEY, levelSlot, resolveStoredLevel } from './levelStore'
export type { AmbientSettings } from './ambient'
export type { BackgroundPlan } from './background'
export type { LyricPlan } from './lyrics'
export type { PulsePlan } from './player'
export { startEnergy, subscribeEnergy, currentEnergy } from './energy'
