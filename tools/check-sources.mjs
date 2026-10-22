/**
 * Probes the public, openly-licensed music sources Aurora Music can legally integrate.
 * For each source it runs the real search call and then verifies a playable audio stream
 * (including HTTP Range support, which the player needs for seeking).
 *
 * Run with: node tools/check-sources.mjs
 */
const UA = 'AuroraMusic/0.1.0 (local music player; source health check)'
const TIMEOUT_MS = 20000

async function request(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': UA, ...(options.headers ?? {}) },
    })
  } finally {
    clearTimeout(timer)
  }
}

async function probeStream(url, label) {
  try {
    const res = await request(url, { headers: { Range: 'bytes=0-4095' } })
    const type = res.headers.get('content-type') ?? ''
    const range = res.headers.get('content-range') ?? ''
    const accept = res.headers.get('accept-ranges') ?? ''
    const buffer = await res.arrayBuffer()
    const isAudio = type.startsWith('audio/') || type.includes('mpegurl') || type.includes('octet-stream')
    return {
      label,
      ok: isAudio && buffer.byteLength > 0,
      detail: `HTTP ${res.status} · ${type} · ${buffer.byteLength}B · accept-ranges=${accept || 'none'} · ${range || 'no content-range'}`,
      finalUrl: res.url,
    }
  } catch (error) {
    return { label, ok: false, detail: String(error), finalUrl: url }
  }
}

const results = []

// ---------------------------------------------------------------- Audius
async function checkAudius() {
  try {
    const host = (await (await request('https://api.audius.co')).json()).data?.[0]
    const search = await (await request(`${host}/v1/tracks/search?query=lofi&app_name=AuroraMusic&limit=3`)).json()
    const tracks = search.data ?? []
    results.push({ name: 'Audius', stage: 'search', ok: tracks.length > 0, detail: `${tracks.length} 条结果 · 示例: ${tracks[0]?.title ?? '-'}` })
    if (tracks.length === 0) return
    const track = tracks[0]
    const streamProbe = await probeStream(`${host}/v1/tracks/${track.id}/stream?app_name=AuroraMusic`, 'stream')
    results.push({ name: 'Audius', stage: 'stream', ok: streamProbe.ok, detail: `${streamProbe.detail} · track_id=${track.id}` })
  } catch (error) {
    results.push({ name: 'Audius', stage: 'search', ok: false, detail: String(error) })
  }
}

// ------------------------------------------------------- Internet Archive
async function checkInternetArchive() {
  try {
    const searchUrl =
      'https://archive.org/advancedsearch.php?q=mediatype%3A%28audio%29+AND+licenseurl%3A%28*creativecommons*%29&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&rows=3&page=1&output=json'
    const search = await (await request(searchUrl)).json()
    const docs = search.response?.docs ?? []
    results.push({
      name: 'Internet Archive',
      stage: 'search',
      ok: docs.length > 0,
      detail: `${search.response?.numFound ?? 0} 条可用 · 示例: ${docs[0]?.title?.slice(0, 40) ?? '-'}`,
    })
    if (docs.length === 0) return

    const identifier = docs[0].identifier
    const metadata = await (await request(`https://archive.org/metadata/${identifier}`)).json()
    const audioFile = (metadata.files ?? []).find((file) => file.name?.toLowerCase().endsWith('.mp3'))
    if (!audioFile) {
      results.push({ name: 'Internet Archive', stage: 'stream', ok: false, detail: '该条目没有 mp3 可直接流式播放' })
      return
    }
    const url = `https://archive.org/download/${identifier}/${encodeURIComponent(audioFile.name)}`
    const probe = await probeStream(url, 'stream')
    results.push({ name: 'Internet Archive', stage: 'stream', ok: probe.ok, detail: probe.detail })
  } catch (error) {
    results.push({ name: 'Internet Archive', stage: 'search', ok: false, detail: String(error) })
  }
}

// ------------------------------------------------------------ Radio Browser
async function checkRadioBrowser() {
  const mirrors = ['https://de1.api.radio-browser.info', 'https://at1.api.radio-browser.info', 'https://nl1.api.radio-browser.info']
  let lastError = ''
  for (const mirror of mirrors) {
    try {
      const stations = await (
        await request(`${mirror}/json/stations/search?limit=3&hidebroken=true&order=clickcount&reverse=true&tag=jazz`)
      ).json()
      results.push({ name: 'Radio Browser', stage: 'search', ok: stations.length > 0, detail: `${mirror} · ${stations.length} 个电台 · 示例: ${stations[0]?.name ?? '-'}` })
      const playable = stations.find((station) => station.url_resolved?.startsWith('http'))
      if (!playable) {
        results.push({ name: 'Radio Browser', stage: 'stream', ok: false, detail: '没有可用的 url_resolved' })
        return
      }
      const probe = await probeStream(playable.url_resolved, 'stream')
      results.push({ name: 'Radio Browser', stage: 'stream', ok: probe.ok, detail: `${probe.detail} · 电台: ${playable.name}` })
      return
    } catch (error) {
      lastError = String(error)
    }
  }
  results.push({ name: 'Radio Browser', stage: 'search', ok: false, detail: lastError })
}

await checkAudius()
await checkInternetArchive()
await checkRadioBrowser()

for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name.padEnd(18)} [${item.stage}]  ${item.detail}`)
}
const failed = results.filter((item) => !item.ok).length
console.log(`\n${results.length - failed}/${results.length} 项检查通过`)
process.exit(failed === 0 ? 0 : 1)
