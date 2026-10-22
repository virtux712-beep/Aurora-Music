/*
 * The shell background recipe.
 *
 * Each theme paints its page background differently — a nebula drifts, paper is still, tides move in
 * long swells, ink washes out, sunset light travels. Rather than five stylesheets, the recipe name
 * becomes a `data-bg` value and the *values* it needs (drift period, strength, the two tint colours
 * already in `--ambient-a/b`) are written as custom properties.
 *
 * So a user theme picks a recipe by name and tunes it with its own colours, and the CSS that implements
 * the recipe is written once.
 */
import type { AnimationLevel, BackgroundKind, ThemeEffects } from '../../../../shared/theme'
import { levelProfile } from './levels'

export interface BackgroundPlan {
  kind: BackgroundKind
  vars: Record<string, string>
}

/*
 * The plan carries the *tempo* only, and deliberately so: how strongly the background shows is already
 * `--ambient-glow` (written once in the store from the skin's glow × the level's own glow budget), and a
 * second strength variable here would be one number nothing reads — a knob that looks like a feature.
 * The drift period has a real consumer in every recipe below.
 */
export function backgroundPlan(effects: ThemeEffects, level: AnimationLevel): BackgroundPlan {
  const profile = levelProfile(level)
  const calm = level === 'saver' ? 1.4 : 1
  return {
    // Without the heavy layers the recipe is skipped entirely: `plain` is not a downgrade of the
    // theme's look, it *is* the theme's look at a cheaper setting (the tinted glow still applies).
    kind: profile.heavy ? effects.background : 'plain',
    // The theme's own tempo, slowed a little at 节能 so a cheap setting also looks calmer.
    vars: { '--bg-art-drift': `${Math.round(effects.driftSeconds * calm)}s` },
  }
}
