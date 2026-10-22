/**
 * One-off: puts the *installed* app's animation level back, by having the app write it.
 *
 * An earlier build let the performance watchdog persist its automatic downgrade into the same slot as the
 * user's own choice, so an install can sit at 关闭 and look like "the effects are broken" (no particles, no
 * vinyl rotation, nothing moving) with nothing on screen saying why.
 *
 * `tools/reset-animation-level.mjs` does the same job by clicking, but it issues a `location.reload()` and
 * then waits for the evaluation to return across that reload — which never happens, so the script hangs.
 * This one writes both slots in a single evaluate and exits; the value is read on the *next* launch, which
 * is exactly when it matters.
 *
 * Usage:
 *   node tools/restore-animation-level.mjs                 # → 沉浸
 *   node tools/restore-animation-level.mjs standard
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const LEVELS = ['off', 'saver', 'standard', 'immersive']
const level = process.argv[2] && LEVELS.includes(process.argv[2]) ? process.argv[2] : 'immersive'
const port = 9471
const exe = 'release/win-unpacked/Aurora Music.exe'

const child = spawn(exe, [`--remote-debugging-port=${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
child.stderr.on('data', () => undefined)

let ws = null
let messageId = 0

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++messageId
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      reject(new Error(`CDP ${method} 超时`))
    }, 30000)
    const onMessage = (event) => {
      const payload = JSON.parse(String(event.data))
      if (payload.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      if (payload.error) reject(new Error(JSON.stringify(payload.error)))
      else resolve(payload.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function main() {
  let target = null
  for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await response.json()
      target = list.find((item) => item.type === 'page' && !item.url.includes('desktop-lyrics'))
    } catch {
      // not up yet
    }
    if (!target) await delay(500)
  }
  if (!target) throw new Error('连不上应用')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('调试连接失败')))
  })
  // The real profile boots with a populated library and live sources, which takes longer than the fresh
  // profile the acceptance checks use — evaluating before the renderer is ready is what timed out first.
  await delay(6000)

  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      localStorage.setItem('aurora:animation-level', ${JSON.stringify(level)})
      localStorage.removeItem('aurora:animation-level:auto')
      return JSON.stringify({ level: localStorage.getItem('aurora:animation-level'), auto: localStorage.getItem('aurora:animation-level:auto') })
    })()`,
    returnByValue: true,
  })
  console.log('写入结果:', result.result.value)
}

main()
  .then(() => console.log('完成，下次启动即为该档位'))
  .catch((error) => console.error('失败:', error.message))
  .finally(() => {
    try {
      ws?.close()
    } catch {
      // already closed
    }
    child.kill()
  })
