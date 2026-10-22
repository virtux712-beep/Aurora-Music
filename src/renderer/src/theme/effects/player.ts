/*
 * The play button's aura, and the immersive artwork's treatment.
 *
 * Both are "the skin touching the player": a halo that breathes with the music, a copper shimmer, a
 * droplet that spreads, an ink bloom, a sun flare. They share one plan because they share one source of
 * truth — the theme's accent — and because the player bar and the immersive page must agree on it
 * (the same song cannot glow purple in the bar and orange in the full view).
 */
import type { AnimationLevel, PulseKind, ThemeEffects, ThemeTokens } from '../../../../shared/theme'
import { levelProfile } from './levels'

export interface PulsePlan {
  kind: PulseKind
  vars: Record<string, string>
}

/**
 * `tokens` are the *resolved* skin tokens for the active mode, so the aura is drawn in the skin's real
 * accent colours rather than in a second palette that has to be kept in sync.
 */
export function pulsePlan(effects: ThemeEffects, tokens: ThemeTokens, level: AnimationLevel): PulsePlan {
  const profile = levelProfile(level)
  if (!profile.heavy) {
    /*
     * No recipe, so no numbers. 节能 and 关闭 leave the base rule's own fallbacks (`--pulse-strength: 0`,
     * `--pulse-react: 0`) to do the work instead of writing zeroes that mean the same thing — which is
     * also what makes "switching down actually removes the halo" observable rather than assumed.
     */
    return { kind: 'plain', vars: {} }
  }
  return {
    kind: effects.pulse,
    vars: {
      '--pulse-accent': tokens['--accent'] || '#a58aff',
      // How far the aura reaches at rest; the music multiplies this (see `--pulse-react`).
      '--pulse-strength': String(Math.round(profile.glow * 100) / 100),
      // How much the music may add on top. 0 here is a real "this theme does not move with the song".
      '--pulse-react': String(Math.round(Math.min(1, Math.max(0, effects.reactive)) * profile.react * 100) / 100),
    },
  }
}
