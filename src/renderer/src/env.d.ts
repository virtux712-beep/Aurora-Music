import type { AuroraApi, DesktopLyricsBridge } from '../../shared/types'

declare global {
  interface Window {
    /** The app window's bridge (see `preload/index.ts`). */
    aurora: AuroraApi
    /**
     * The desktop-lyrics window's bridge (see `preload/desktop-lyrics.ts`). That window runs its own
     * small bundle, so it only ever sees this — never the full app bridge.
     */
    auroraLyrics?: DesktopLyricsBridge
  }
}

export {}
