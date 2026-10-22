import type { AudioTrack } from '../../../shared/types'
import { useCollectionStore } from '../stores/collection'
import { useDownloadStore } from '../stores/downloads'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useUiStore } from '../stores/ui'

export function useTrackActions() {
  const player = usePlayerStore()
  const library = useLibraryStore()
  const collection = useCollectionStore()
  const downloads = useDownloadStore()
  const ui = useUiStore()

  function playList(tracks: AudioTrack[], startIndex = 0): void {
    if (tracks.length === 0) return
    const track = tracks[startIndex]
    if (!track) return
    void player.playTrack(track, tracks)
  }

  function playShuffled(tracks: AudioTrack[]): void {
    if (tracks.length === 0) return
    const shuffled = [...tracks]
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    player.setMode('shuffle')
    playList(shuffled, 0)
  }

  function enqueueNext(track: AudioTrack): void {
    player.enqueue(track, 'next')
    ui.notify(`已插入到下一首播放：${track.title}`, 'success')
  }

  function enqueueEnd(track: AudioTrack): void {
    player.enqueue(track, 'end')
    ui.notify(`已添加到播放队列：${track.title}`, 'success')
  }

  function toggleFavorite(track: AudioTrack): void {
    // Favourites must survive a restart even for online tracks whose stream URL expires.
    if (track.origin === 'online') library.rememberOnline([track])
    const added = collection.toggleFavorite(track.id)
    ui.notify(added ? `已收藏：${track.title}` : `已取消收藏：${track.title}`, added ? 'success' : 'info')
  }

  /**
   * Hands the track to the download manager. Only online tracks qualify — a local file is already on
   * disk, and the manager resolves the stream itself so the renderer never handles a media URL.
   */
  async function download(track: AudioTrack): Promise<void> {
    if (track.origin !== 'online' || !track.sourceId) {
      ui.notify('本地音乐已经在磁盘上，无需下载', 'info')
      return
    }
    const started = await downloads.start(track)
    if (!started) ui.notify('无法开始下载：该曲目缺少可解析的播放地址', 'error')
  }

  async function reveal(track: AudioTrack): Promise<void> {
    const ok = await library.reveal(track.id)
    if (!ok) ui.notify('无法定位该文件', 'error')
  }

  async function removeFromLibrary(track: AudioTrack): Promise<void> {
    const removed = await library.remove(track.id)
    if (!removed) {
      ui.notify('移除失败，请重试', 'error')
      return
    }
    player.clearIfCurrent(track.id)
    ui.notify(`已从音乐库移除：${track.title}`, 'success')
  }

  return {
    player,
    library,
    collection,
    downloads,
    ui,
    playList,
    playShuffled,
    enqueueNext,
    enqueueEnd,
    toggleFavorite,
    download,
    reveal,
    removeFromLibrary,
  }
}
