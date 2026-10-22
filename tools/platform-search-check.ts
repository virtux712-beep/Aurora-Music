/**
 * Live diagnostic for the built-in platform search.
 *
 * Unlike the smoke suites this one talks to the real endpoints, so it is a *manual* tool rather than
 * part of `npm run verify` — the network is not a dependency a build should have. It exists because
 * "the ported search compiles" and "the ported search returns songs" are very different claims, and
 * only the second one is worth reporting.
 *
 *   npm run check:platforms            # 周杰伦 晴天 across every platform
 *   npm run check:platforms -- 林俊杰   # any keyword
 */
import { PLATFORMS, searchPlatform } from '../src/main/musicSdk'

const keyword = process.argv.slice(2).filter((arg) => !arg.startsWith('-')).join(' ') || '周杰伦 晴天'

async function main(): Promise<void> {
  console.log(`keyword: ${keyword}\n`)
  let failed = 0
  for (const platform of PLATFORMS) {
    const started = Date.now()
    try {
      const songs = await searchPlatform(platform.id, keyword, 1, 10)
      const latency = Date.now() - started
      if (songs.length === 0) {
        failed += 1
        console.log(`FAIL ${platform.name}（${platform.id}）— 0 条结果（${latency}ms）`)
        continue
      }
      console.log(`PASS ${platform.name}（${platform.id}）— ${songs.length} 条 / ${latency}ms`)
      for (const song of songs.slice(0, 3)) {
        const qualities = Object.keys(song.meta._qualitys ?? {}).join(',') || '—'
        console.log(`       ${song.name} — ${song.singer}  [${song.interval}]  ${qualities}`)
        console.log(`       meta: ${JSON.stringify(song.meta).slice(0, 200)}`)
      }
    } catch (error) {
      failed += 1
      console.log(`FAIL ${platform.name}（${platform.id}）— ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${PLATFORMS.length - failed}/${PLATFORMS.length} 平台返回了真实结果`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
