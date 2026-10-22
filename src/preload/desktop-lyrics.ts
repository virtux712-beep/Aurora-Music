import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopLyricsSettings,
  DesktopLyricsTick,
  DesktopLyricsTrack,
  PlayerCommand,
} from '../shared/types'

/**
 * The desktop-lyrics window's entire capability surface.
 *
 * Deliberately *not* the app preload: this window has no business reading the library, resolving
 * sources or touching settings beyond its own block. A separate preload makes that structural
 * rather than a promise — even if this window were somehow compromised, the bridge it can reach
 * contains four channels and nothing else.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  /** Tells the main process the window is up, so it re-pushes the current track and options. */
  ready: (): Promise<void> => ipcRenderer.invoke('desktop-lyrics:ready'),
  onTrack: (listener: (track: DesktopLyricsTrack | null) => void): (() => void) =>
    subscribe<DesktopLyricsTrack | null>('desktop-lyrics:track', listener),
  onTick: (listener: (tick: DesktopLyricsTick) => void): (() => void) =>
    subscribe<DesktopLyricsTick>('desktop-lyrics:tick', listener),
  onOptions: (listener: (options: DesktopLyricsSettings) => void): (() => void) =>
    subscribe<DesktopLyricsSettings>('desktop-lyrics:options', listener),
  setOptions: (patch: Partial<DesktopLyricsSettings>): Promise<DesktopLyricsSettings> =>
    ipcRenderer.invoke('desktop-lyrics:set-options', patch),
  /** Fire-and-forget: the app window owns playback and will act on it. */
  control: (command: PlayerCommand): void => ipcRenderer.send('desktop-lyrics:control', command),
  hide: (): Promise<void> => ipcRenderer.invoke('desktop-lyrics:hide'),
}

contextBridge.exposeInMainWorld('auroraLyrics', api)
