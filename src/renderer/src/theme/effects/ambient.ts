/*
 * The particle engine's *parameters* — what the skin asks for, scaled by the level and modulated by
 * the music.
 *
 * Kept separate from the canvas that draws them (`components/AmbientLayer.vue`) because this half is
 * pure arithmetic: it can be unit-tested without a window, and the drawing half stays only about
 * drawing.
 */
import type { AnimationLevel, ParticleKind, ThemeEffects } from '../../../../shared/theme'
import { levelProfile } from './levels'

export interface AmbientSettings {
  particles: ParticleKind
  /** Particles per 100 000 px², after the level multiplier. */
  density: number
  /** Base speed in px/s, after the level multiplier. */
  speed: number
  /**
   * How much playback may speed the field up (0 = never), pre-multiplied by the level's own budget.
   *
   * The coupling is deliberately one-sided — music can make the field *livelier*, never slower than
   * the skin's own tempo — so a quiet passage looks like the theme, not like a frozen screen.
   */
  react: number
}

/**
 * Parameters only — the music's own contribution is applied per frame by the canvas, which already
 * redraws every frame. Putting energy into this object would make it a value that changes 60 times a
 * second, and anything computed from it (a Vue `computed`, a prop) would re-render at that rate.
 */
export function ambientSettings(effects: ThemeEffects, level: AnimationLevel): AmbientSettings {
  const profile = levelProfile(level)
  return {
    particles: profile.particles === 0 ? 'none' : effects.particles,
    density: effects.density * profile.particles,
    speed: effects.speed * (0.6 + 0.4 * profile.particles),
    react: Math.min(1, Math.max(0, effects.reactive)) * profile.react,
  }
}
