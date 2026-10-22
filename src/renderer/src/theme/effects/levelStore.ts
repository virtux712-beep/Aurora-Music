/*
 * Where an animation level is remembered, and what happens to an automatic downgrade.
 *
 * The failure this exists to prevent is a preference that quietly disappears. The watchdog lowers the
 * level when frames are slow; if it writes into the same slot the user's own choice lives in, one busy
 * afternoon permanently costs that user every effect — nothing says so, and the only way back is to
 * find the settings page and notice the dial moved. (That is not hypothetical: an automated test run
 * left a real install at 关闭, and "the effects do nothing" was the only symptom.)
 *
 * So the two are stored apart:
 *
 *  - the user's choice lives in `aurora:animation-level` and is written *only* by a user action;
 *  - an automatic downgrade lives in `aurora:animation-level:auto`, applies to that one session, and is
 *    consumed — read and deleted — at the next launch.
 *
 * Keeping the decision in pure functions (no `localStorage`, no store) is what lets the rule be tested
 * offline: `tools/theme-smoke.ts` asserts the slots and the resolution order without a browser.
 */
import type { AnimationLevel } from '../../../../shared/theme'
import { isAnimationLevel, LEVEL_ORDER } from './levels'

/** The user's own choice. */
export const LEVEL_KEY = 'aurora:animation-level'
/** This session's automatic downgrade. Cleared at launch, never a source of truth across sessions. */
export const AUTO_LEVEL_KEY = 'aurora:animation-level:auto'

/** Which slot a write belongs in. A user action must never be able to write the session slot. */
export function levelSlot(automatic: boolean): string {
  return automatic ? AUTO_LEVEL_KEY : LEVEL_KEY
}

/**
 * The level this session runs at, plus the user's own choice (`chosen`) so a caller that needs the
 * ceiling for the load guard does not have to read storage a second time — which is how the two values
 * drift apart.
 *
 * An automatic downgrade only ever *lowers* what the user asked for: a leftover value from another
 * build (or a hand-edited storage) must never raise it, and a level at or above the choice is ignored
 * rather than applied.
 */
export function resolveStoredLevel(
  user: unknown,
  auto: unknown,
  legacyEffectsOff = false,
): { level: AnimationLevel; fromAuto: boolean; chosen: AnimationLevel } {
  const chosen: AnimationLevel = isAnimationLevel(user)
    ? user
    : legacyEffectsOff
      ? 'off'
      : 'standard'
  if (!isAnimationLevel(auto)) return { level: chosen, fromAuto: false, chosen }
  const lowers = LEVEL_ORDER.indexOf(auto) < LEVEL_ORDER.indexOf(chosen)
  return lowers ? { level: auto, fromAuto: true, chosen } : { level: chosen, fromAuto: false, chosen }
}
