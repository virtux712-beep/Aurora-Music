/*
 * The ids the app ships with.
 *
 * Main needs this to reject a user theme that would shadow a built-in one, and the renderer needs it
 * to know whether "删除" applies to a skin at all. Kept as a plain list (not derived from the skin
 * definitions, which live in the renderer bundle) so the main process can import it without pulling
 * Vue code into an Electron main bundle.
 */
export const BUILT_IN_SKIN_IDS = ['aurora', 'star-dream', 'autumn-leaf', 'ocean-morning', 'jiangnan-rain', 'sunset-song']

/** Modes the theme controller understands; shared so main and renderer cannot disagree. */
export type SkinMode = 'dark' | 'light'
