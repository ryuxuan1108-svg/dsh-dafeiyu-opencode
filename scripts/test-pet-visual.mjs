import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSettings, settingsPaths } from '../src/opencode-settings.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const debugPort = probe.address().port
await new Promise((done) => probe.close(done))
process.env.OPENCODE_DAFEIYU_DESKTOP_DEBUG_PORT = String(debugPort)
const { createPetEngine } = await import('../dist/dsh-pet-engine.js')
const paths = settingsPaths(root)
const engine = await createPetEngine({
  home: join(dirname(paths.overrides), 'pet-runtime'), settings: loadSettings(paths.files), logger: console,
  request: async () => ({ status: 'ready', available: true, summary: 'Sub2API 余额 · 窗口验证' }),
})
let socket
try {
  const deadline = Date.now() + 180000
  let target
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })
      const targets = await response.json()
      target = targets.find((item) => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
    } catch {}
    await new Promise((done) => setTimeout(done, 500))
  }
  if (!target) throw new Error('dsh-pet 桌面窗口未就绪，请检查 Electron 日志。')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  let seq = 0
  const calls = new Map()
  socket.addEventListener('message', (message) => {
    const value = JSON.parse(message.data)
    const pending = calls.get(value.id)
    if (!pending) return
    calls.delete(value.id)
    if (value.error) pending.reject(new Error(value.error.message))
    else pending.resolve(value.result)
  })
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++seq
    calls.set(id, { resolve: resolveCall, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await call('Page.enable')
  await engine.send({ kind: 'state', state: 'WORKING', detail: 'OpenCode · 上游桌宠已接入' })
  await new Promise((done) => setTimeout(done, 3500))
  const workBubble = await call('Runtime.evaluate', { expression: 'document.body.innerText.includes("OpenCode")', returnByValue: true })
  if (!workBubble.result?.value) throw new Error('桌面窗口尚未显示 OpenCode 工作状态。')
  const screenshot = await call('Page.captureScreenshot', { format: 'png' })
  await mkdir(join(root, '.build'), { recursive: true })
  const output = join(root, '.build', 'dsh-pet-desktop.png')
  await writeFile(output, Buffer.from(screenshot.data, 'base64'))
  console.log(`dsh-pet desktop visual check passed: ${output}; desktop processes=${engine.desktopProcesses().length}`)
} finally {
  socket?.close()
  await engine.stop()
}
