export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.floor(seconds)
  const secs = total % 60
  const minutes = Math.floor(total / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

export function formatCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 172_800_000) return '昨天'
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

export function shortenArtists(artist: string): string {
  return artist.replace(/\s*;\s*/g, ' / ').replace(/\s*\/\s*/g, ' / ')
}
