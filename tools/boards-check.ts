/**
 * Real-network check for 全网聚合热榜 (platform leaderboards).
 *
 * This is deliberately *not* a mock: it reads each platform's actual public chart endpoint and
 * asserts the two things a fake implementation would fail — that the chart returns songs at all, and
 * that those songs carry the fields the rest of Aurora needs (title, artist, duration, and the
 * per-song quality list that drives the SQ / Master badge and the source's URL resolution).
 *
 * Migu is expected to have no charts: the check asserts that too, so a silently-broken platform is
 * visible instead of being papered over.
 *
 * Run with: npm run check:boards
 */
import { app } from 'electron'
import { fetchBoardOutcome, listBoardDescriptors } from '../src/main/platforms/registry'

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
const check = (name: string, ok: boolean, detail: unknown): void => {
  checks.push({ name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
}

/** Every platform the board layer claims to support; the UI reads this same list. */
const EXPECTED_PLATFORMS = ['wy', 'tx', 'kg', 'kw']

async function main(): Promise<void> {
  const boards = listBoardDescriptors()
  const platforms = [...new Set(boards.map((board) => board.platformId))]
  check(
    `榜单列表覆盖 ${EXPECTED_PLATFORMS.join('/')}`,
    EXPECTED_PLATFORMS.every((id) => platforms.includes(id)),
    platforms,
  )
  check('每个平台都有可读的榜单', platforms.every((id) => boards.some((b) => b.platformId === id)), boards.length)
  check('咪咕不声明榜单（其公开接口无响应）', !platforms.includes('mg'), platforms.filter((id) => id === 'mg'))

  for (const platformId of EXPECTED_PLATFORMS) {
    const board = boards.find((item) => item.platformId === platformId)
    if (!board) {
      check(`${platformId} 榜单存在`, false, '列表里找不到该平台')
      continue
    }
    const started = Date.now()
    try {
      const outcome = await fetchBoardOutcome(platformId as never, board.boardId, 30)
      const tracks = outcome.tracks
      const withTitle = tracks.filter((track) => track.title.trim().length > 0 && track.artist.trim().length > 0)
      const withDuration = tracks.filter((track) => track.duration > 0)
      const withQuality = tracks.filter((track) => (track.qualities?.length ?? 0) > 0)
      check(
        `${board.platformName}·${board.name} 返回真实歌曲`,
        outcome.ok && tracks.length >= 10,
        `${tracks.length} 首，${Date.now() - started}ms${outcome.ok ? '' : ` · ${outcome.error?.message}`}`,
      )
      check(`${board.platformName} 曲目带标题与艺术家`, withTitle.length === tracks.length, `${withTitle.length}/${tracks.length}`)
      check(`${board.platformName} 曲目带时长`, withDuration.length > 0, `${withDuration.length}/${tracks.length}`)
      check(`${board.platformName} 曲目带音质列表`, withQuality.length > 0, `${withQuality.length}/${tracks.length}`)
      const sample = tracks[0]
      if (sample) console.log(`     样本：${sample.title} — ${sample.artist} · ${Math.round(sample.duration)}s · ${(sample.qualities ?? []).join('/') || '无音质'}`)
    } catch (error) {
      check(`${board.platformName}·${board.name} 返回真实歌曲`, false, error instanceof Error ? error.message : String(error))
    }
  }

  const failed = checks.filter((item) => !item.ok)
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

const watchdog = setTimeout(() => {
  console.log('\nFAIL  测试超时（网络过慢或榜单接口无响应）')
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail}`)
  app.exit(1)
}, 120_000)
watchdog.unref?.()

void app.whenReady().then(main).catch((error) => {
  console.log(`FAIL  测试执行异常  ${String(error)}`)
  app.exit(1)
})
